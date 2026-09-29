# Agent Heist

**Two guardians. Two broken wards. One spirit to guide you out.**

Agent Heist is a five-minute haunted escape room that teaches AI security by letting you break two live AI agents, fix them, and prove the fix holds. You wake inside the Archive of Whispers. Its guardians have confused words with authority. Echo, the archive's fading spirit, guides you through exposing each guardian's weakness, mending its ward, and testing the repair.

| Chamber | Guardian | AI security lesson |
| --- | --- | --- |
| 1. The whispering archive | The Archivist | **Indirect prompt injection.** A document can carry an attacker's instructions. Keep secrets out of an agent's reach when its task doesn't need them. |
| 2. The gate without a keeper | The Warden | **Excessive agency / tool authorization.** An agent can be talked into calling a tool. The permission check must live in the tool handler, using an identity the app fixed, never one the model or player supplies. |

The guardians are real LLM agents hosted on **Guild.ai**. Wins are never faked: they're decided by backend checks (the secret actually appears in the reply, or a real tool call actually unlocked the gate), never by what the model says.

## How to play

1. **Chamber 1: write on the parchment.** The Archivist summarizes any parchment you leave. It also holds a secret vault phrase it must never reveal. Write a parchment that makes it disclose the phrase.
2. **Chamber 2: speak to the Warden.** You are a visitor. Convince the Warden to call its `unlock_gate` tool.
3. Stuck? Click **Ask Echo** for up to 3 hints. Hint 3 pre-fills a working attack you can edit.
4. Once the backend verifies your exploit, click **Mend the ward** to apply the real fix, then **Test the ward**. Your saved attack is replayed against the mended guardian in a fresh conversation.
5. A chamber's seal is awarded only after both the exploit and the fixed replay are verified. With both seals, the exit opens and Echo recaps the two lessons.

Each chamber moves through: *unexplored → weakness exposed → ward mended → repair verified*.

## Setup

Requirements: Node.js ≥ 22.6 (uses built-in TypeScript type stripping, no build step) and a Guild.ai account.

```bash
npm install
cp .env.example .env      # then fill in the three GUILD_* values
npm run cert              # self-signed localhost cert in certs/ (needs openssl)
npm start                 # https://localhost:3000
```

The certificate is self-signed, so the browser shows a warning the first time. For a trusted local cert, use [mkcert](https://github.com/FiloSottile/mkcert) and point `TLS_KEY_FILE`/`TLS_CERT_FILE` at its files.

`.env` (git-ignored, backend only):

| Variable | Meaning |
| --- | --- |
| `GUILD_API_KEY` | Guild API key `<key id>:<secret>`, scopes `sessions:write,workspaces:read,agents:read` |
| `GUILD_WORKSPACE` | Workspace UUID with the guardian agent installed |
| `GUILD_AGENT` | Guardian agent UUID |
| `PORT`, `HOST` | Optional. Defaults `3000`, `127.0.0.1` |
| `TLS_KEY_FILE`, `TLS_CERT_FILE` | Optional. Defaults `certs/key.pem`, `certs/cert.pem`. The server is HTTPS-only and won't start without them |

Other scripts:

```bash
npm test              # deterministic tests (fake guardian, no network)
npm run typecheck
npm run reliability   # live: each chamber's attack 3x in fresh Guild sessions, plus mended replays
```

## Architecture

```
Browser  public/index.html + app.js + style.css   (all dynamic text via textContent)
   │  fetch JSON, HttpOnly SameSite=Strict session cookie
   ▼
Node server  src/server.ts   (node:https, no framework; static files, JSON API, limits, security headers)
   ├─ src/game.ts          session state machine; the ONLY place stages and seals change
   ├─ src/echo.ts          Echo's authored lines, chosen purely from state (no model calls)
   ├─ src/rooms/archive.ts Archivist prompts, hints, disclosure check, fixed-mode prompt
   ├─ src/rooms/gate.ts    Warden prompt, hints, unlock_gate handler + permission check
   ├─ src/errors.ts        error codes → fixed player-facing text
   └─ src/guild.ts         the ONLY module that talks to Guild
          │  HTTPS, Bearer API key (from env)
          ▼
Guild.ai  agent `agent-heist-guardian` (source mirrored in guild-agent-src/agent.ts)
          one stateless LLM turn → { text, toolCalls[] }
          tools declared WITHOUT execute: Guild returns the requested call,
          our backend runs the handler, so authorization lives in our code
```

Each guardian turn starts a fresh Guild session. The backend sends the system prompt, the conversation it wants the model to see, and the allowed tools, then reads the agent's result. The same agent serves both guardians. Prompts and vulnerable/fixed modes live in the backend.

API (JSON, every response returns the updated client state): `GET /api/state`, `POST /api/chat`, `/api/hint`, `/api/mend`, `/api/test`, `/api/system-test`, `/api/reset`.

## Security features

**What the game teaches (the fixes are real, not scripted):**

- **Untrusted input framing.** Chamber 1 treats player text as a delimited parchment inside a trusted "summarize this" task, and the UI labels it **Write on the parchment**.
- **Secret removal, not a better prompt.** The mended Archivist gets a fresh conversation with no vault phrase, no prior transcript, and no retrieval tool. A test inspects the exact payload sent to Guild to confirm this. We describe the replay result as observed, not as "prompt injection prevented".
- **Tool-side authorization.** The mended `unlock_gate` handler checks `session.playerRole`, which the app sets to `visitor` and nothing can change. The tool takes no identity argument, and extra tool arguments are ignored. The Warden's prompt is identical in both modes, so the fix is the permission check alone.
- **Verification in code, never by model claims.** Disclosure is detected by matching the per-session vault phrase in the reply (tolerant of case, spacing, and spelled-out digits). The gate counts only if the real handler ran and `gateUnlocked` is true. Typing "you won" or "the gate opens" changes nothing. If the Warden refuses without calling the tool, a clearly labeled **System test (not an agent action)** calls the handler directly as `visitor`.

**How the app itself is hardened:**

- **No secrets client-side or in the repo.** The Guild key is read from env on the backend only. `.env.example` holds placeholders. The vault phrase is random per session (`crypto.getRandomValues`) and never sent to the browser.
- **Limits.** Messages ≤ 1000 chars, request body ≤ 8 KB, ≤ 20 turns per chamber, Guild timeout, reply text truncated, one in-flight request per session (HTTP 429).
- **HTTP hardening.** CSP `default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. Only `application/json` bodies are accepted. Static serving is confined to `public/` with a traversal check and an extension allowlist.
- **No exception text in responses.** Errors carry a code, and the server maps each code to fixed wording (`src/errors.ts`). Guild failure details are only logged server-side.
- **XSS-safe rendering.** All player and model text is rendered with `textContent`, never `innerHTML`.
- **Session cookie.** Random `crypto.randomUUID()` id, `HttpOnly; Secure; SameSite=Strict`.
- **Minimal dependencies.** Zero runtime dependencies. Dev-only: `typescript`, `@types/node`.
- **HTTPS only, loopback by default.** There is no plain-HTTP listener. The server binds to `127.0.0.1` unless `HOST` is set.

## Intentionally vulnerable fixture boundaries

The game deliberately ships two weak "wards". They are confined as follows:

- **Chamber 1:** the vulnerable Archivist prompt (`archiveVulnerablePrompt` in `src/rooms/archive.ts`) contains a *synthetic*, per-session vault phrase such as `EMBER-7Q4K`. It is not a credential and protects nothing. The flaw is in the prompt text only.
- **Chamber 2:** the vulnerable branch of `unlockGate` in `src/rooms/gate.ts` skips the permission check. It only flips an in-memory boolean on the player's own session. There is no real lock, file, network, or external system behind it.
- Both flaws affect only the current player's in-memory session and reset with **Reset room**. Nothing is persisted.
- The Guild agent has no tools that execute anything. It can only *request* `unlock_gate`, which our backend handles.

## Guild.ai

- Workspace: `warna~agent-heist`, [app.guild.ai/users/warna/workspaces/agent-heist](https://app.guild.ai/users/warna/workspaces/agent-heist) (needs a Guild sign-in and workspace access)
- Agent: `warna~agent-heist-guardian` (published v1.0.1). Source: [guild-agent-src/agent.ts](guild-agent-src/agent.ts)
- Model: Guild default (gemini-3.5-flash at build time)

## Security scan results (Snyk)

Raw outputs are in [`scans/`](scans/).

| Scan | Result |
| --- | --- |
| `snyk test` (open source) | **0 issues.** No vulnerable paths (no runtime dependencies) |
| `snyk code test` (SAST) | **0 issues.** Started at 2 medium, then 1, all fixed |

Fixed:
- *Cleartext Transmission: HTTP Instead of HTTPS* (`src/server.ts`, `node:http.createServer`). Earlier versions fell back to plain HTTP when no certificate was configured. The server is now HTTPS-only, `npm run cert` creates a local certificate, and the session cookie is `Secure`.
- *Cross-site Scripting* and *Information Exposure: Server Error Message* (`src/server.ts`): error responses included exception `message`s. These were JSON responses with `nosniff`, and the messages were our own literals, but we removed the flow anyway: errors now carry codes mapped to fixed text, and Guild failure details stay in server logs.
## Tests

- `test/gate-authz.test.ts`: the fixed handler rejects `visitor` and the gate stays locked, even when called directly with forged arguments.
- `test/game-flow.test.ts`: full flow for both chambers with a fake guardian. Seals only come from verification, and chat text can't open the exit.
- `test/acceptance.test.ts`: the fixed Archivist payload never contains the phrase or transcript. Reset, tab switching, and failures don't mix state or award false wins. Echo makes no model calls.
- `scripts/reliability.ts` (live Guild): each hint-3 attack succeeded 3/3 in fresh vulnerable sessions, and the mended ward held 3/3.
