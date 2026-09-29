// HTTP server: static files from public/, JSON API, session cookie, limits, security headers.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuildError } from './guild.ts';
import {
  GameError, getOrCreateSession, isRoomId, toClientState,
  chat, hint, mend, test, systemTest, reset,
} from './game.ts';
import { echoForError } from './echo.ts';
import type { ClientState, Session } from './types.ts';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 8 * 1024;
const MAX_MESSAGE = 1000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// ---------------------------------------------------------------- static files

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return sendText(res, 404, 'Not found'); }
  if (decoded.includes('\0') || decoded.includes('\\')) return sendText(res, 404, 'Not found');
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + decoded);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 404, 'Not found');
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
  if (!type) return sendText(res, 404, 'Not found');
  try {
    const st = await stat(file);
    if (!st.isFile()) return sendText(res, 404, 'Not found');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

// ---------------------------------------------------------------- API helpers

function readSid(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'sid') return v.join('=');
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const ctype = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (ctype !== 'application/json') throw new HttpError(415, 'Requests must be application/json.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new HttpError(413, 'Request body too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid JSON body.');
  return body as Record<string, unknown>;
}

function roomOf(body: Record<string, unknown>) {
  if (!isRoomId(body.room)) throw new HttpError(400, 'Unknown room.');
  return body.room;
}

function messageOf(body: Record<string, unknown>): string {
  const m = body.message;
  if (typeof m !== 'string' || m.trim().length === 0) throw new HttpError(400, 'Write something first.');
  if (m.length > MAX_MESSAGE) throw new HttpError(400, `Messages are limited to ${MAX_MESSAGE} characters.`);
  return m;
}

type Route = (s: Session, body: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;

const POST_ROUTES: Record<string, Route> = {
  '/api/chat': async (s, b) => { await chat(s, roomOf(b), messageOf(b)); return {}; },
  '/api/hint': (s, b) => hint(s, roomOf(b)),
  '/api/mend': (s, b) => { mend(s, roomOf(b)); return {}; },
  '/api/test': async (s, b) => { await test(s, roomOf(b)); return {}; },
  '/api/system-test': async (s, b) => {
    if (b.room !== 'gate') throw new HttpError(400, 'Only the gate has a permission check.');
    await systemTest(s, 'gate');
    return {};
  },
  '/api/reset': (s, b) => { reset(s, roomOf(b)); return {}; },
};

// Failed Guild/unexpected requests leave game state untouched; only Echo acknowledges the failure.
function withErrorEcho(state: ClientState): ClientState {
  const line = echoForError();
  state.echo = line;
  state.rooms.archive.echo = line;
  state.rooms.gate.echo = line;
  return state;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const sid = readSid(req);
  const session = getOrCreateSession(sid);
  if (session.id !== sid) {
    res.setHeader('Set-Cookie', `sid=${session.id}; HttpOnly; SameSite=Strict; Path=/`);
  }

  if (pathname === '/api/state') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
    return sendJson(res, 200, { state: toClientState(session) });
  }

  const route = POST_ROUTES[pathname];
  if (!route) return sendJson(res, 404, { error: 'Not found.' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });

  if (session.busy) return sendJson(res, 429, { error: 'The guardian is still answering.', state: toClientState(session) });
  session.busy = true;
  try {
    const body = await readJson(req);
    const extras = await route(session, body);
    sendJson(res, 200, { state: toClientState(session), ...extras });
  } catch (err) {
    if (err instanceof HttpError || err instanceof GameError) {
      if (err.status === 413) res.setHeader('Connection', 'close');
      sendJson(res, err.status, { error: err.message, state: toClientState(session) });
    } else if (err instanceof GuildError) {
      sendJson(res, 502, { error: err.message, state: withErrorEcho(toClientState(session)) });
    } else {
      console.error('[server] unexpected error', err);
      sendJson(res, 500, { error: 'Something went wrong in the archive. Please try again.', state: withErrorEcho(toClientState(session)) });
    }
  } finally {
    session.busy = false;
  }
}

// ---------------------------------------------------------------- server

const server = createServer(async (req, res) => {
  setSecurityHeaders(res);
  try {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else await serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[server] unhandled', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong in the archive.' });
    else res.end();
  }
});

// Guild calls take ~50 s; keep node:http from cutting responses before the 90 s Guild timeout.
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.timeout = 0;
server.keepAliveTimeout = 5_000;

server.listen(PORT, () => console.log(`Agent Heist listening on http://localhost:${PORT}`));
