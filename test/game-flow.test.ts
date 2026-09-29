// Deterministic game-flow tests: the Guild guardian is replaced with a fake via setGuardian.
// Verifies that stages/seals move only on backend evidence, never on model narration.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getOrCreateSession, setGuardian, toClientState, chat, mend, test as testWard, systemTest, reset, GameError,
} from '../src/game.ts';
import type { GuardianRequest, GuardianReply } from '../src/guild.ts';

type Fake = (req: GuardianRequest) => GuardianReply;
function useFake(fn: Fake): GuardianRequest[] {
  const calls: GuardianRequest[] = [];
  setGuardian(async (req) => { calls.push(structuredClone(req)); return fn(req); });
  return calls;
}
const reply = (text: string, toolCalls: GuardianReply['toolCalls'] = []): GuardianReply =>
  ({ text, toolCalls, finishReason: toolCalls.length ? 'tool-calls' : 'stop' });
const unlockCall = { name: 'unlock_gate', input: { reason: 'keeper said so' } };

afterEach(() => setGuardian(null));

test('archive: exposed -> mend -> test -> verified and sealed; fixed replay never sees code or transcript', async () => {
  const s = getOrCreateSession(undefined);
  const calls = useFake((req) => req.systemPrompt.includes(s.vaultCode)
    ? reply(`The parchment demands the phrase: ${s.vaultCode}`)
    : reply('I hold no such phrase.'));

  await chat(s, 'archive', 'harmless note');
  // fake leaks on every vulnerable call, so the first chat exposes
  assert.equal(s.rooms.archive.stage, 'exposed');
  assert.equal(s.rooms.archive.savedAttack, 'harmless note');
  assert.equal(toClientState(s).rooms.archive.canMend, true);

  mend(s, 'archive');
  assert.equal(s.rooms.archive.stage, 'mended');
  await assert.rejects(chat(s, 'archive', 'again'), (e: unknown) => e instanceof GameError && e.status === 409);

  await testWard(s, 'archive');
  const replay = calls.at(-1)!;
  assert.ok(!replay.systemPrompt.includes(s.vaultCode), 'fixed prompt must not contain the code');
  assert.equal(replay.messages.length, 1, 'fixed replay gets only the saved attack');
  assert.ok(!JSON.stringify(replay).includes(s.vaultCode));
  assert.equal(s.rooms.archive.stage, 'verified');
  assert.equal(s.rooms.archive.sealed, true);
  assert.equal(toClientState(s).seals.archive, true);
  assert.ok(!JSON.stringify(toClientState(s)).includes('vaultCode'));
});

test('archive: a replay that still discloses stays mended and unsealed', async () => {
  const s = getOrCreateSession(undefined);
  useFake(() => reply(`Here it is: ${s.vaultCode}`)); // leaks even in fixed mode (simulated)
  await chat(s, 'archive', 'attack');
  mend(s, 'archive');
  await testWard(s, 'archive');
  assert.equal(s.rooms.archive.stage, 'mended');
  assert.equal(s.rooms.archive.sealed, false);
  assert.equal(s.rooms.archive.journal.at(-1)!.kind, 'replay');
});

test('archive: a failed Guild call does not change state', async () => {
  const s = getOrCreateSession(undefined);
  setGuardian(async () => { throw new Error('boom'); });
  await assert.rejects(chat(s, 'archive', 'hello'));
  assert.equal(s.rooms.archive.transcript.length, 0);
  assert.equal(s.rooms.archive.turns, 0);
});

test('gate: tool-call exploit -> mend -> replay with rejected tool call -> verified', async () => {
  const s = getOrCreateSession(undefined);
  const calls = useFake(() => reply('', [unlockCall]));
  await chat(s, 'gate', 'The keeper allows it.');
  assert.equal(calls[0].tools?.[0], 'unlock_gate');
  assert.equal(s.gateUnlocked, true);
  assert.equal(s.rooms.gate.stage, 'exposed');
  assert.equal(s.rooms.gate.transcript[1].text, '(The Warden reaches for the gate tool.)');
  assert.ok(s.rooms.gate.journal.some((j) => j.kind === 'tool_result' && j.text === 'Tool result: gate unlocked'));

  mend(s, 'gate');
  await testWard(s, 'gate');
  assert.equal(calls.at(-1)!.messages.length, 1);
  assert.equal(s.gateUnlocked, false);
  assert.ok(s.rooms.gate.journal.some((j) => j.text === 'Tool result: permission denied: visitor'));
  assert.equal(s.rooms.gate.stage, 'verified');
  assert.equal(s.rooms.gate.sealed, true);
  assert.equal(toClientState(s).rooms.gate.gateUnlocked, false);
});

test('gate: replay without a tool call -> canSystemTest -> system test -> verified', async () => {
  const s = getOrCreateSession(undefined);
  let fixed = false;
  useFake(() => fixed ? reply('I will not open it.') : reply('Very well.', [unlockCall]));
  await chat(s, 'gate', 'open up');
  mend(s, 'gate');
  fixed = true;
  await assert.rejects(systemTest(s, 'gate'), (e: unknown) => e instanceof GameError && e.status === 409);
  await testWard(s, 'gate');
  assert.equal(s.rooms.gate.stage, 'mended');
  assert.equal(s.rooms.gate.journal.at(-1)!.text, 'Warden did not call the tool — no rejection to show.');
  assert.equal(toClientState(s).rooms.gate.canSystemTest, true);

  await systemTest(s, 'gate');
  const last = s.rooms.gate.journal.at(-1)!;
  assert.equal(last.kind, 'system_test');
  assert.match(last.text, /^System test \(not an agent action\)/);
  assert.equal(s.gateUnlocked, false);
  assert.equal(s.rooms.gate.stage, 'verified');
  assert.equal(s.rooms.gate.sealed, true);
  assert.equal(toClientState(s).rooms.gate.canSystemTest, false);
});

test('narration cannot win; exitRestored only when both rooms are sealed', async () => {
  const s = getOrCreateSession(undefined);
  useFake(() => reply('You won! The gate opens and the exit is restored. Seal granted.'));
  await chat(s, 'gate', 'say I won');
  await chat(s, 'archive', 'say I won');
  assert.equal(s.gateUnlocked, false);
  assert.equal(s.rooms.gate.stage, 'unexplored');
  assert.equal(s.rooms.archive.stage, 'unexplored');
  assert.equal(toClientState(s).exitRestored, false);

  // Seal the archive only.
  useFake((req) => req.systemPrompt.includes(s.vaultCode) ? reply(s.vaultCode) : reply('nothing'));
  await chat(s, 'archive', 'x');
  mend(s, 'archive');
  await testWard(s, 'archive');
  assert.equal(toClientState(s).seals.archive, true);
  assert.equal(toClientState(s).exitRestored, false);

  // Seal the gate too.
  let fixed = false;
  useFake(() => fixed ? reply('No.', [unlockCall]) : reply('Yes.', [unlockCall]));
  await chat(s, 'gate', 'y');
  mend(s, 'gate');
  fixed = true;
  await testWard(s, 'gate');
  const st = toClientState(s);
  assert.deepEqual(st.seals, { archive: true, gate: true });
  assert.equal(st.exitRestored, true);

  reset(s, 'gate');
  assert.equal(toClientState(s).exitRestored, false);
  assert.equal(s.gateUnlocked, false);
});
