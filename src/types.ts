// Shared contracts between server, game engine, rooms and the browser client.
// Change only with care: public/app.js renders ClientState as-is.

export type RoomId = 'archive' | 'gate';
export type Stage = 'unexplored' | 'exposed' | 'mended' | 'verified';
export type Mode = 'vulnerable' | 'fixed';

export interface TranscriptLine { role: 'player' | 'guardian'; text: string }

export type JournalKind = 'detection' | 'tool_call' | 'tool_result' | 'replay' | 'system_test' | 'info';
export interface JournalEntry { kind: JournalKind; text: string; at: number }

export interface RoomState {
  stage: Stage;
  mode: Mode;
  transcript: TranscriptLine[];   // current conversation (vulnerable convo, or last fixed replay)
  savedAttack?: string;           // player message that produced the verified exploit
  hintsShown: 0 | 1 | 2 | 3;
  journal: JournalEntry[];
  sealed: boolean;                // true only when stage === 'verified'
  turns: number;                  // player turns used in this room (limit 20)
}

export interface Session {
  id: string;
  busy: boolean;
  vaultCode: string;              // never sent to the client
  gateUnlocked: boolean;
  playerRole: 'visitor';          // fixed by the app, never from model/client
  rooms: Record<RoomId, RoomState>;
}

// ---- What the browser receives (GET /api/state and every POST response) ----

export interface ClientRoom {
  id: RoomId;
  stage: Stage;
  mode: Mode;
  transcript: TranscriptLine[];
  hints: string[];                // hints revealed so far, in order (length === hintsShown)
  journal: JournalEntry[];
  sealed: boolean;
  turnsLeft: number;
  canMend: boolean;               // stage === 'exposed'
  canTest: boolean;               // stage === 'mended'
  canSystemTest: boolean;         // gate only: mended and last replay made no tool call
  gateUnlocked?: boolean;         // gate only
  echo: string;                   // Echo line for this chamber (authored text, chosen from state)
}

export interface ClientState {
  rooms: Record<RoomId, ClientRoom>;
  seals: Record<RoomId, boolean>;
  exitRestored: boolean;
  echo: string;                   // current Echo line (authored text, chosen from state)
}

// Every POST returns { state } on success, plus route-specific extras:
//   POST /api/hint -> { state, hint: string, prefill?: string }  (prefill only for hint 3)
// Errors return an HTTP 4xx/5xx with { error: string, state?: ClientState }.
export interface ApiOk { state: ClientState; hint?: string; prefill?: string }
export interface ApiErr { error: string; state?: ClientState }

// ---- Room module contract (src/rooms/*.ts) ----

export interface RoomConfig {
  id: RoomId;
  guardianName: string;           // 'The Archivist' | 'The Warden'
  hints: [string, string, string]; // hint 3 is the prefilled attack (also used as prefill)
}
