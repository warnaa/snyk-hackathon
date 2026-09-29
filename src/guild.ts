// The only module that talks to Guild.
//
// Each call starts a FRESH Guild chat session running the guardian agent
// (guild-agent/agent.ts), sends the whole conversation as JSON input, and
// polls the session events until the agent's `runtime_done` result arrives.
// Tool calls come back as *requests*; Guild never executes them.

const API = 'https://app.guild.ai/api';
const POLL_MS = 700;

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ToolCall { name: string; input: unknown }
export interface GuardianReply { text: string; toolCalls: ToolCall[]; finishReason: string }
export interface GuardianRequest {
  systemPrompt: string;
  messages: ChatMessage[];
  tools?: 'unlock_gate'[];
  timeoutMs?: number;
}

export class GuildError extends Error {}

function config() {
  const key = process.env.GUILD_API_KEY;
  const workspace = process.env.GUILD_WORKSPACE;
  const agent = process.env.GUILD_AGENT;
  if (!key || !workspace || !agent) throw new GuildError('Guild is not configured (see .env.example)');
  return { key, workspace, agent };
}

async function api(key: string, method: string, path: string, body: unknown, signal: AbortSignal) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    if (process.env.GUILD_DEBUG) console.error('[guild]', res.status, (await res.text()).slice(0, 500));
    throw new GuildError(`Guild API ${method} ${path.split('?')[0]} failed: HTTP ${res.status}`);
  }
  return res.json() as Promise<any>;
}

export async function runGuardian(req: GuardianRequest): Promise<GuardianReply> {
  const { key, workspace, agent } = config();
  const signal = AbortSignal.timeout(req.timeoutMs ?? 60_000);
  const input = { systemPrompt: req.systemPrompt, messages: req.messages, tools: req.tools ?? [] };

  try {
    const session = await api(key, 'POST', `/workspaces/${encodeURIComponent(workspace)}/sessions`, {
      session_type: 'chat',
      agent_id: agent,
      initial_prompt: JSON.stringify(input),
    }, signal);

    while (true) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const page = await api(key, 'GET', `/sessions/${encodeURIComponent(session.id)}/events?limit=100&offset=0`, undefined, signal);
      for (const ev of page.items ?? []) {
        if (ev.type === 'system_error' || ev.type === 'agent_notification_error') {
          throw new GuildError('Guardian run failed');
        }
        if (ev.type === 'runtime_done') {
          const c = ev.content ?? {};
          if (typeof c.text !== 'string') throw new GuildError('Guardian returned no result');
          return {
            text: c.text,
            toolCalls: Array.isArray(c.toolCalls) ? c.toolCalls : [],
            finishReason: String(c.finishReason ?? ''),
          };
        }
      }
    }
  } catch (err) {
    if (err instanceof GuildError) throw err;
    if ((err as Error).name === 'TimeoutError') throw new GuildError('The guardian took too long to answer');
    throw new GuildError('Could not reach Guild');
  }
}
