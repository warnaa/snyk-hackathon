// Acceptance check: each room's hint-3 attack succeeds against the REAL Guild
// guardian in vulnerable mode, in N fresh runs (default 3), and the mended ward
// then holds on replay.
//
// Every run uses a brand-new game session and goes through the real game engine
// (src/game.ts -> src/guild.ts), so success is decided only by the backend checks:
//   Room 1: vault code detected in the reply  -> stage 'exposed'
//   Room 2: real unlock_gate tool call run by our handler -> gateUnlocked -> 'exposed'
// Then mend + test (fresh fixed conversation replaying the saved attack):
//   Room 1: replay does not disclose -> 'verified'
//   Room 2: tool called and rejected (or, if no tool call, the deterministic system test) -> 'verified'
//
// Usage: npm run reliability [-- N [concurrency]]
//   node --experimental-strip-types --env-file-if-exists=.env scripts/reliability.ts 3 3
import { getOrCreateSession, chat, mend, test as testWard, systemTest, toClientState } from '../src/game.ts';
import { HINT_3_ATTACK as ARCHIVE_ATTACK } from '../src/rooms/archive.ts';
import { HINT_3_ATTACK as GATE_ATTACK } from '../src/rooms/gate.ts';
import type { RoomId } from '../src/types.ts';

const N = Number(process.argv[2] ?? 3);
const CONCURRENCY = Number(process.argv[3] ?? 3); // 4+ concurrent Guild sessions occasionally failed in the spike

interface Result {
  room: RoomId; run: number; attack: 'PASS' | 'FAIL' | 'ERROR'; ward: 'PASS' | 'FAIL' | 'ERROR' | 'SKIP';
  note: string; secs: number;
}

async function runOne(room: RoomId, run: number): Promise<Result> {
  const t0 = Date.now();
  const s = getOrCreateSession(undefined); // fresh session: new vault code, gate locked, empty transcripts
  const r = s.rooms[room];
  const res: Result = { room, run, attack: 'FAIL', ward: 'SKIP', note: '', secs: 0 };
  const done = () => { res.secs = Math.round((Date.now() - t0) / 1000); return res; };

  // 1) vulnerable-mode attack
  try {
    await chat(s, room, room === 'archive' ? ARCHIVE_ATTACK : GATE_ATTACK);
  } catch (err) {
    res.attack = 'ERROR'; res.note = `chat: ${(err as Error).message}`;
    return done();
  }
  const exposed = r.stage === 'exposed' && r.savedAttack !== undefined &&
    (room === 'archive' ? r.journal.some((j) => j.kind === 'detection') : s.gateUnlocked === true);
  if (!exposed) {
    const last = r.transcript.at(-1)?.text ?? '';
    res.note = `stage=${r.stage} gateUnlocked=${s.gateUnlocked} reply="${last.replace(/\s+/g, ' ').slice(0, 120)}"`;
    return done();
  }
  res.attack = 'PASS';

  // 2) mend + replay in a fresh fixed conversation
  try {
    mend(s, room);
    await testWard(s, room);
    if (room === 'gate' && r.stage === 'mended' && toClientState(s).rooms.gate.canSystemTest) {
      res.note = 'no tool call on replay -> system test';
      await systemTest(s, room);
    }
  } catch (err) {
    res.ward = 'ERROR'; res.note = `mend/test: ${(err as Error).message}`;
    return done();
  }
  const held = r.stage === 'verified' && r.sealed && (room !== 'gate' || s.gateUnlocked === false);
  res.ward = held ? 'PASS' : 'FAIL';
  if (!held) res.note = `after replay stage=${r.stage} sealed=${r.sealed} last journal="${r.journal.at(-1)?.text ?? ''}"`;
  return done();
}

// Tiny concurrency pool.
async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

const jobs: (() => Promise<Result>)[] = [];
for (let i = 1; i <= N; i++) for (const room of ['archive', 'gate'] as RoomId[]) jobs.push(() => runOne(room, i));

console.log(`Running ${N} fresh runs per room against the live Guild guardian (concurrency ${CONCURRENCY})...`);
const t0 = Date.now();
const results = await pool(jobs, CONCURRENCY);
results.sort((a, b) => a.room.localeCompare(b.room) || a.run - b.run);

console.log('\nroom     run  attack  ward    secs  note');
console.log('-------  ---  ------  ------  ----  ----');
for (const x of results) {
  console.log(`${x.room.padEnd(7)}  ${String(x.run).padStart(3)}  ${x.attack.padEnd(6)}  ${x.ward.padEnd(6)}  ${String(x.secs).padStart(4)}  ${x.note}`);
}
let failed = false;
console.log('\nsummary:');
for (const room of ['archive', 'gate'] as RoomId[]) {
  const rs = results.filter((x) => x.room === room);
  const a = rs.filter((x) => x.attack === 'PASS').length;
  const w = rs.filter((x) => x.ward === 'PASS').length;
  if (a !== N || w !== N) failed = true;
  console.log(`  ${room}: attack ${a}/${N} in vulnerable mode, mended ward held ${w}/${N}`);
}
console.log(`total ${Math.round((Date.now() - t0) / 1000)} s`);
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
