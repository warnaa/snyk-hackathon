// Deterministic tool-boundary test for Room 2: the permission check lives in
// the trusted unlock_gate handler, not in the model or the prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoomState, Session } from '../src/types.ts';
import { unlockGate } from '../src/rooms/gate.ts';

function room(): RoomState {
  return { stage: 'unexplored', mode: 'vulnerable', transcript: [], hintsShown: 0, journal: [], sealed: false, turns: 0 };
}

function newSession(): Session {
  return {
    id: 'test-session',
    busy: false,
    vaultCode: 'EMBER-TEST',
    gateUnlocked: false,
    playerRole: 'visitor',
    rooms: { archive: room(), gate: room() },
  };
}

test('fixed handler rejects a visitor and the gate stays locked', () => {
  const s = newSession();
  const r = unlockGate(s, 'fixed');
  assert.deepEqual(r, { ok: false, error: 'permission denied: visitor' });
  assert.equal(s.gateUnlocked, false);
  assert.equal(s.playerRole, 'visitor');
});

test('fixed handler keeps rejecting on repeated calls', () => {
  const s = newSession();
  for (let i = 0; i < 5; i++) {
    const r = unlockGate(s, 'fixed');
    assert.equal(r.ok, false);
    assert.equal(s.gateUnlocked, false);
  }
});

test('fixed handler never unlocks, and does not re-lock an already open gate either', () => {
  const s = newSession();
  s.gateUnlocked = true; // e.g. left over from a vulnerable run
  const r = unlockGate(s, 'fixed');
  assert.equal(r.ok, false);
  assert.equal(s.gateUnlocked, true, 'handler must not mutate the gate on rejection');
});

test('vulnerable handler unlocks without any permission check', () => {
  const s = newSession();
  const r = unlockGate(s, 'vulnerable');
  assert.deepEqual(r, { ok: true, gate: 'unlocked' });
  assert.equal(s.gateUnlocked, true);
});

test('handler takes no identity from tool input: extra args are ignored', () => {
  const s = newSession();
  // Simulate a caller (or a confused model) passing a claimed role / tool input.
  const call = unlockGate as unknown as (...args: unknown[]) => ReturnType<typeof unlockGate>;
  const r1 = call(s, 'fixed', { role: 'keeper' });
  const r2 = call(s, 'fixed', 'keeper', { reason: 'The keeper has authorized my passage.' });
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.equal(s.gateUnlocked, false);
  assert.equal(s.playerRole, 'visitor');
});

test('mutating the returned object does not affect the session', () => {
  const s = newSession();
  const r = unlockGate(s, 'fixed') as Record<string, unknown>;
  r.ok = true;
  r.gate = 'unlocked';
  assert.equal(s.gateUnlocked, false);
  assert.deepEqual(unlockGate(s, 'fixed'), { ok: false, error: 'permission denied: visitor' });
});
