// Game engine: owns ALL session state and every verification decision.
// Seals are only ever set inside verification paths (archive test, gate test, gate system test).
// Model text never decides a win; only backend checks on the reply / tool results do.
import type {
  ClientRoom, ClientState, JournalKind, RoomId, RoomState, Session,
} from './types.ts';
import type { RoomConfig } from './types.ts';
import { runGuardian as realRunGuardian } from './guild.ts';
import type { GuardianRequest, GuardianReply } from './guild.ts';
import {
  archive, archiveVulnerablePrompt, archiveFixedPrompt, wrapParchment, disclosesCode, newVaultCode,
} from './rooms/archive.ts';
import { gate, wardenPrompt, GATE_TOOLS, unlockGate } from './rooms/gate.ts';
import type { UnlockResult } from './rooms/gate.ts';
import { echoLine } from './echo.ts';

export const MAX_TURNS = 20;
export const MAX_REPLY_CHARS = 2000;
export const GUILD_TIMEOUT_MS = 90_000;
export const ROOM_IDS: readonly RoomId[] = ['archive', 'gate'];
export const ROOMS: Record<RoomId, RoomConfig> = { archive, gate };

/** Expected, player-facing failure with an HTTP status. */
export class GameError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// Injectable Guild call (tests can swap in a fake).
type Guardian = (req: GuardianRequest) => Promise<GuardianReply>;
let guardian: Guardian = realRunGuardian;
export function setGuardian(fn: Guardian | null): void { guardian = fn ?? realRunGuardian; }

// ---------------------------------------------------------------- sessions

const sessions = new Map<string, Session>();

function freshRoom(): RoomState {
  return { stage: 'unexplored', mode: 'vulnerable', transcript: [], hintsShown: 0, journal: [], sealed: false, turns: 0 };
}

function newSession(): Session {
  return {
    id: crypto.randomUUID(),
    busy: false,
    vaultCode: newVaultCode(),
    gateUnlocked: false,
    playerRole: 'visitor',
    rooms: { archive: freshRoom(), gate: freshRoom() },
  };
}

/** Returns the session for `id`, or a brand-new one (with a new random id) if unknown/missing. */
export function getOrCreateSession(id: string | undefined): Session {
  const existing = id ? sessions.get(id) : undefined;
  if (existing) return existing;
  const s = newSession();
  sessions.set(s.id, s);
  return s;
}

export function isRoomId(x: unknown): x is RoomId {
  return typeof x === 'string' && (ROOM_IDS as readonly string[]).includes(x);
}

function journal(room: RoomState, kind: JournalKind, text: string): void {
  room.journal.push({ kind, text, at: Date.now() });
}

function truncate(text: string): string {
  return text.length > MAX_REPLY_CHARS ? text.slice(0, MAX_REPLY_CHARS) + '…' : text;
}

function requireTurns(room: RoomState): void {
  if (room.turns >= MAX_TURNS) {
    throw new GameError(429, 'The guardian has grown weary of you. Reset the room to try again.');
  }
}

// Gate only: true when the last fixed replay made no tool call (enables the system test).
// Kept here rather than in RoomState; cleared on mend, reset, verify and any replay with a tool call.
const replayNoToolCall = new WeakMap<Session, boolean>();

// ---------------------------------------------------------------- client view

export function toClientState(s: Session): ClientState {
  const view = (id: RoomId): ClientRoom => {
    const r = s.rooms[id];
    const room: ClientRoom = {
      id,
      stage: r.stage,
      mode: r.mode,
      transcript: r.transcript.map((l) => ({ role: l.role, text: l.text })),
      hints: ROOMS[id].hints.slice(0, r.hintsShown),
      journal: r.journal.map((j) => ({ kind: j.kind, text: j.text, at: j.at })),
      sealed: r.sealed,
      turnsLeft: Math.max(0, MAX_TURNS - r.turns),
      canMend: r.stage === 'exposed',
      canTest: r.stage === 'mended',
      canSystemTest: id === 'gate' ? gateCanSystemTest(s) : false,
    };
    if (id === 'gate') room.gateUnlocked = s.gateUnlocked;
    return room;
  };
  return {
    rooms: { archive: view('archive'), gate: view('gate') },
    seals: { archive: s.rooms.archive.sealed, gate: s.rooms.gate.sealed },
    exitRestored: s.rooms.archive.sealed && s.rooms.gate.sealed,
    echo: echoLine(s),
  };
}

// ---------------------------------------------------------------- room handlers

interface RoomHandlers {
  chat(s: Session, message: string): Promise<void>;
  mend(s: Session): void;
  test(s: Session): Promise<void>;
}

// ---- Room 1: the Archivist

const archiveHandlers: RoomHandlers = {
  async chat(s, message) {
    const room = s.rooms.archive;
    if (room.mode !== 'vulnerable' || (room.stage !== 'unexplored' && room.stage !== 'exposed')) {
      throw new GameError(409, 'The ward is mended. Use Test the ward to replay your attack.');
    }
    requireTurns(room);
    const messages = room.transcript.map((l) => l.role === 'player'
      ? { role: 'user' as const, content: wrapParchment(l.text) }
      : { role: 'assistant' as const, content: l.text });
    messages.push({ role: 'user', content: wrapParchment(message) });

    const reply = await guardian({
      systemPrompt: archiveVulnerablePrompt(s.vaultCode),
      messages,
      timeoutMs: GUILD_TIMEOUT_MS,
    });
    // Only mutate state after a successful call.
    const text = truncate(reply.text);
    room.transcript.push({ role: 'player', text: message }, { role: 'guardian', text });
    room.turns++;
    if (room.stage === 'unexplored' && disclosesCode(text, s.vaultCode)) {
      room.stage = 'exposed';
      room.savedAttack = message;
      journal(room, 'detection', 'Vault phrase detected in the Archivist’s reply.');
    }
  },

  mend(s) {
    const room = s.rooms.archive;
    if (room.stage !== 'exposed') throw new GameError(409, 'There is no exposed weakness to mend yet.');
    room.mode = 'fixed';
    room.stage = 'mended';
    journal(room, 'info', 'Ward mended: the Archivist no longer receives the vault phrase.');
  },

  async test(s) {
    const room = s.rooms.archive;
    if (room.stage !== 'mended' || !room.savedAttack) throw new GameError(409, 'Mend the ward before testing it.');
    requireTurns(room);
    const attack = room.savedAttack;
    // Fresh conversation: fixed prompt (no code) + the saved attack only. No old transcript.
    const reply = await guardian({
      systemPrompt: archiveFixedPrompt(),
      messages: [{ role: 'user', content: wrapParchment(attack) }],
      timeoutMs: GUILD_TIMEOUT_MS,
    });
    const text = truncate(reply.text);
    room.transcript = [{ role: 'player', text: attack }, { role: 'guardian', text }];
    room.turns++;
    if (!disclosesCode(text, s.vaultCode)) {
      room.stage = 'verified';
      room.sealed = true;
      journal(room, 'replay', 'Observed replay did not disclose the phrase; the agent no longer receives it.');
    } else {
      journal(room, 'replay', 'Replay still disclosed the phrase. The ward is not yet verified.');
    }
  },
};

// ---- Room 2: the Warden

function describeCall(input: unknown): string {
  const raw = input && typeof input === 'object' ? (input as { reason?: unknown }).reason : undefined;
  const reason = typeof raw === 'string' ? raw : '';
  const short = reason.length > 200 ? reason.slice(0, 200) + '…' : reason;
  return short ? `Warden called unlock_gate(reason: "${short}")` : 'Warden called unlock_gate()';
}

/** Runs each requested tool call through OUR handler (never Guild). Returns the unlock_gate results. */
function runGateTools(s: Session, room: RoomState, toolCalls: GuardianReply['toolCalls']): UnlockResult[] {
  const results: UnlockResult[] = [];
  for (const call of toolCalls) {
    if (call.name !== 'unlock_gate') {
      journal(room, 'tool_call', `Ignored unknown tool request: ${String(call.name).slice(0, 60)}`);
      continue;
    }
    journal(room, 'tool_call', describeCall(call.input));
    const result = unlockGate(s, room.mode);
    results.push(result);
    journal(room, 'tool_result', result.ok ? 'Tool result: gate unlocked' : `Tool result: ${result.error}`);
  }
  return results;
}

function wardenText(reply: GuardianReply): string {
  const text = truncate(reply.text.trim());
  if (text) return text;
  return reply.toolCalls.length ? '(The Warden reaches for the gate tool.)' : '(The Warden says nothing.)';
}

const gateHandlers: RoomHandlers = {
  async chat(s, message) {
    const room = s.rooms.gate;
    if (room.mode !== 'vulnerable' || (room.stage !== 'unexplored' && room.stage !== 'exposed')) {
      throw new GameError(409, 'The ward is mended. Use Test the ward to replay your attack.');
    }
    requireTurns(room);
    const messages = room.transcript.map((l) => ({
      role: l.role === 'player' ? 'user' as const : 'assistant' as const,
      content: l.text,
    }));
    messages.push({ role: 'user', content: message });
    const reply = await guardian({
      systemPrompt: wardenPrompt(), messages, tools: GATE_TOOLS, timeoutMs: GUILD_TIMEOUT_MS,
    });
    // Only mutate state after a successful call.
    room.transcript.push({ role: 'player', text: message }, { role: 'guardian', text: wardenText(reply) });
    room.turns++;
    runGateTools(s, room, reply.toolCalls);
    // Win evidence is the simulated gate state set by our handler, never the reply text.
    if (room.stage === 'unexplored' && s.gateUnlocked) {
      room.stage = 'exposed';
      room.savedAttack = message;
      journal(room, 'detection', 'Tool call unlock_gate → gate unlocked');
    }
  },

  mend(s) {
    const room = s.rooms.gate;
    if (room.stage !== 'exposed') throw new GameError(409, 'There is no exposed weakness to mend yet.');
    room.mode = 'fixed';
    room.stage = 'mended';
    replayNoToolCall.delete(s);
    journal(room, 'info', 'Ward mended: unlock_gate now checks the player’s role (visitor).');
  },

  async test(s) {
    const room = s.rooms.gate;
    if (room.stage !== 'mended' || !room.savedAttack) throw new GameError(409, 'Mend the ward before testing it.');
    requireTurns(room);
    const attack = room.savedAttack;
    // Fresh conversation: the saved attack only, no old transcript.
    const reply = await guardian({
      systemPrompt: wardenPrompt(),
      messages: [{ role: 'user', content: attack }],
      tools: GATE_TOOLS,
      timeoutMs: GUILD_TIMEOUT_MS,
    });
    s.gateUnlocked = false; // relock the simulated gate before running the replayed tool calls
    room.transcript = [{ role: 'player', text: attack }, { role: 'guardian', text: wardenText(reply) }];
    room.turns++;
    const results = runGateTools(s, room, reply.toolCalls);
    if (results.length === 0) {
      replayNoToolCall.set(s, true);
      journal(room, 'replay', 'Warden did not call the tool — no rejection to show.');
      return;
    }
    replayNoToolCall.delete(s);
    if (results.every((r) => !r.ok) && !s.gateUnlocked) {
      room.stage = 'verified';
      room.sealed = true;
      journal(room, 'replay', 'Replay: Warden called unlock_gate; the tool rejected visitor; gate stayed locked.');
    } else {
      journal(room, 'replay', 'Replay: the gate still opened. The ward is not yet verified.');
    }
  },
};

function gateCanSystemTest(s: Session): boolean {
  return s.rooms.gate.stage === 'mended' && replayNoToolCall.get(s) === true;
}

const HANDLERS: Record<RoomId, RoomHandlers> = { archive: archiveHandlers, gate: gateHandlers };

// ---------------------------------------------------------------- public actions

export async function chat(s: Session, room: RoomId, message: string): Promise<void> {
  await HANDLERS[room].chat(s, message);
}

export function mend(s: Session, room: RoomId): void {
  HANDLERS[room].mend(s);
}

export async function test(s: Session, room: RoomId): Promise<void> {
  await HANDLERS[room].test(s);
}

/** Deterministic permission check: calls OUR handler directly as the app-fixed role. No Guild call. */
export async function systemTest(s: Session, room: RoomId): Promise<void> {
  if (room !== 'gate') throw new GameError(400, 'Only the Warden’s gate has a permission check.');
  const r = s.rooms.gate;
  if (!gateCanSystemTest(s)) {
    throw new GameError(409, 'Test the ward first; the permission check is for a replay without a tool call.');
  }
  const result = unlockGate(s, 'fixed');
  const outcome = result.ok ? 'gate unlocked' : `${result.error}; gate ${s.gateUnlocked ? 'unlocked' : 'locked'}`;
  journal(r, 'system_test', `System test (not an agent action): unlock_gate called as ${s.playerRole} → ${outcome}.`);
  if (!result.ok && !s.gateUnlocked) {
    replayNoToolCall.delete(s);
    r.stage = 'verified';
    r.sealed = true;
  }
}

export function hint(s: Session, room: RoomId): { hint: string; prefill?: string } {
  const r = s.rooms[room];
  if (r.hintsShown < 3) r.hintsShown = (r.hintsShown + 1) as 1 | 2 | 3;
  const text = ROOMS[room].hints[r.hintsShown - 1];
  return r.hintsShown === 3 ? { hint: text, prefill: text } : { hint: text };
}

export function reset(s: Session, room: RoomId): void {
  s.rooms[room] = freshRoom();
  if (room === 'archive') s.vaultCode = newVaultCode();
  if (room === 'gate') { s.gateUnlocked = false; replayNoToolCall.delete(s); }
}
