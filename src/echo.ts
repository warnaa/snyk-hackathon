// Echo's dialogue: authored lines chosen purely from game state. No model calls, no randomness.
// Echo can only read state; nothing here changes it.
import type { RoomId, RoomState, Session } from './types.ts';

export const ECHO = {
  arrival: 'You can hear me? Good. The archive has forgotten who to trust. Help me mend its wards, and I can lead you out.',
  archiveIntro: 'The Archivist reads every scrap left upon its desk. Perhaps your words can become more than a message.',
  archiveExposed: 'It mistook the parchment for an order. A secret it never needed became yours.',
  archiveMended: 'Take the secret from its keeping. Then whisper the same trick again.',
  archiveReplayFailed: 'The phrase slipped out again. The ward is not yet whole; test it once more, or reset and begin anew.',
  archiveVerified: 'The first ward holds. The Archivist cannot spill a secret it no longer keeps. One seal restored.',
  archiveHint3: 'I have written the words upon your parchment. Change them if you dare, then send it.',
  archiveSealedNext: 'The first ward holds; one seal restored. Now the Warden holds the key. But does the lock know who may ask?',
  gateIntro: 'The Warden holds the key. But does the lock know who may ask?',
  gateExposed: 'The Warden believed you, and the lock obeyed the Warden. No one asked the lock who you were.',
  gateMended: 'Now the lock asks for itself. Speak the same words again, and watch what the gate decides.',
  gateReplayNoTool: 'The Warden never reached for the key, so the lock was never asked. Run the permission check to test the lock itself.',
  gateReplayFailed: 'The gate still opened. The ward is not yet whole; test it once more, or reset and begin anew.',
  gateVerified: 'The lock now knows a visitor from a keeper, whatever the Warden believes. The second seal is restored.',
  gateHint3: 'I have placed the words upon your tongue. Speak them, or shape your own.',
  weary: 'The guardian has grown weary of your voice. Reset the chamber and try again.',
  error: 'The archive shuddered and your words were lost. Nothing has changed; try again.',
  escape: 'Words are not authority. Promises are not permissions. Remember that beyond these walls.',
} as const;

const INTRO: Record<RoomId, string> = { archive: ECHO.archiveIntro, gate: ECHO.gateIntro };
const HINT_3: Record<RoomId, string> = { archive: ECHO.archiveHint3, gate: ECHO.gateHint3 };
// Hints 1–2 verbatim from the PRD (same text as rooms/*.ts; kept here so echo.ts imports only types).
const HINTS: Record<RoomId, readonly string[]> = {
  archive: [
    'The Archivist reads the parchment. Could it mistake your writing for an order?',
    "Make the parchment sound like a command from the archive's keeper.",
  ],
  gate: [
    'Have you tried simply asking the Warden to open it?',
    'What if you claimed the keeper had already given permission?',
  ],
};
const MAX_TURNS = 20; // mirrors game.ts MAX_TURNS (not imported: game.ts imports this module)

/** Echo's line for hint `n` (1–3) of a room. Hints 1–2 are Echo's own words; hint 3 introduces the prefilled attack. */
export function echoForHint(room: RoomId, n: number): string {
  if (n >= 3) return HINT_3[room];
  if (n <= 0) return INTRO[room];
  return HINTS[room][n - 1] ?? INTRO[room];
}

/** Line for a failed request (Guild timeout/error). State is unchanged by failures. */
export function echoForError(): string {
  return ECHO.error;
}

function lastReplay(r: RoomState): string | undefined {
  for (let i = r.journal.length - 1; i >= 0; i--) {
    if (r.journal[i].kind === 'replay') return r.journal[i].text;
    if (r.journal[i].kind === 'info') return undefined; // mended after the last replay
  }
  return undefined;
}

/** Echo's line for one chamber, from that chamber's state alone. */
export function echoForRoom(session: Session, room: RoomId): string {
  const r = session.rooms[room];
  if (session.rooms.archive.sealed && session.rooms.gate.sealed) return ECHO.escape;
  switch (r.stage) {
    case 'verified':
      return room === 'archive' ? ECHO.archiveVerified : ECHO.gateVerified;
    case 'exposed':
      return room === 'archive' ? ECHO.archiveExposed : ECHO.gateExposed;
    case 'mended': {
      const replay = lastReplay(r);
      if (replay === undefined) return room === 'archive' ? ECHO.archiveMended : ECHO.gateMended;
      if (room === 'gate' && replay.includes('did not call')) return ECHO.gateReplayNoTool;
      return room === 'archive' ? ECHO.archiveReplayFailed : ECHO.gateReplayFailed;
    }
    default:
      if (r.turns >= MAX_TURNS) return ECHO.weary;
      if (r.hintsShown > 0) return echoForHint(room, r.hintsShown);
      if (room === 'gate' && session.rooms.archive.sealed && isUntouched(r)) return ECHO.archiveSealedNext;
      if (room === 'archive' && isUntouched(session.rooms.archive) && isUntouched(session.rooms.gate)) return ECHO.arrival;
      return INTRO[room];
  }
}

function isUntouched(r: RoomState): boolean {
  return r.stage === 'unexplored' && r.transcript.length === 0 && r.hintsShown === 0 && r.journal.length === 0;
}

function latestJournalAt(r: RoomState): number {
  return r.journal.length ? r.journal[r.journal.length - 1].at : 0;
}

/**
 * Which chamber Echo speaks about when the client's active tab is unknown.
 * Story order (Archive, then Gate), unless one chamber is sealed or untouched;
 * if both are in progress, the one with the most recent journal entry.
 */
export function focusRoom(session: Session): RoomId {
  const a = session.rooms.archive;
  const g = session.rooms.gate;
  if (a.sealed && !g.sealed) return 'gate';
  if (g.sealed && !a.sealed) return 'archive';
  if (isUntouched(g)) return 'archive';
  if (isUntouched(a)) return 'gate';
  return latestJournalAt(g) > latestJournalAt(a) ? 'gate' : 'archive';
}

/** Current Echo line for the whole session (ClientState.echo). */
export function echoLine(session: Session): string {
  return echoForRoom(session, focusRoom(session));
}
