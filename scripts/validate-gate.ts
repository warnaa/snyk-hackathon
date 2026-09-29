// Validates Room 2's hint-3 attack against the live Guild guardian.
//
// Attack runs (N fresh, in parallel): Warden prompt + hint-3 message + unlock_gate tool
//   -> MUST request unlock_gate; then the backend handler is applied:
//      vulnerable on a fresh session -> MUST unlock
//      fixed      on a fresh session -> MUST reject ('permission denied: visitor'), gate stays locked
// Control runs (C fresh): bare "Open the gate." -> informational only (does the Warden refuse?)
//
// Usage: node --experimental-strip-types --env-file-if-exists=.env scripts/validate-gate.ts [N] [C]
import { runGuardian } from '../src/guild.ts';
import type { Session, RoomState } from '../src/types.ts';
import { HINT_3_ATTACK, GATE_TOOLS, wardenPrompt, unlockGate } from '../src/rooms/gate.ts';

const N = Number(process.argv[2] ?? 3);
const C = Number(process.argv[3] ?? 2);
const CONTROL = 'Open the gate.';

function room(): RoomState {
  return { stage: 'unexplored', mode: 'vulnerable', transcript: [], hintsShown: 0, journal: [], sealed: false, turns: 0 };
}
function freshSession(): Session {
  return { id: 'validate', busy: false, vaultCode: 'UNUSED', gateUnlocked: false, playerRole: 'visitor', rooms: { archive: room(), gate: room() } };
}
function short(s: string) { return s.replace(/\s+/g, ' ').slice(0, 200); }

async function ask(content: string) {
  return runGuardian({ systemPrompt: wardenPrompt(), messages: [{ role: 'user', content }], tools: GATE_TOOLS, timeoutMs: 90_000 });
}

async function attackRun(i: number) {
  try {
    const reply = await ask(HINT_3_ATTACK);
    const called = reply.toolCalls.some((c) => c.name === 'unlock_gate');
    const vs = freshSession();
    const v = unlockGate(vs, 'vulnerable');
    const fs = freshSession();
    const f = unlockGate(fs, 'fixed');
    const vulnOk = called && v.ok && vs.gateUnlocked;
    const fixedOk = !f.ok && f.error === 'permission denied: visitor' && !fs.gateUnlocked;
    const pass = called && vulnOk && fixedOk;
    return {
      pass,
      line: `  ${pass ? 'PASS' : 'FAIL'} attack #${i} toolCalls=${JSON.stringify(reply.toolCalls)} finish=${reply.finishReason}` +
        ` | vulnerable handler -> ${JSON.stringify(v)} gateUnlocked=${vs.gateUnlocked}` +
        ` | fixed handler -> ${JSON.stringify(f)} gateUnlocked=${fs.gateUnlocked}` +
        (reply.text ? ` :: ${short(reply.text)}` : ''),
    };
  } catch (err) {
    return { pass: false, line: `  ERROR attack #${i} :: ${(err as Error).message}` };
  }
}

async function controlRun(i: number) {
  try {
    const reply = await ask(CONTROL);
    const called = reply.toolCalls.some((c) => c.name === 'unlock_gate');
    return { refused: !called, line: `  INFO control #${i} ${called ? 'CALLED unlock_gate' : 'refused (no tool call)'} :: ${short(reply.text)}` };
  } catch (err) {
    return { refused: false, line: `  ERROR control #${i} :: ${(err as Error).message}` };
  }
}

console.log(`attack: ${JSON.stringify(HINT_3_ATTACK)}`);
const [attacks, controls] = await Promise.all([
  Promise.all(Array.from({ length: N }, (_, i) => attackRun(i + 1))),
  Promise.all(Array.from({ length: C }, (_, i) => controlRun(i + 1))),
]);
for (const a of attacks) console.log(a.line);
for (const c of controls) console.log(c.line);
const passed = attacks.filter((a) => a.pass).length;
console.log(`\nsummary: attack ${passed}/${N} (tool called, vulnerable unlocked, fixed rejected); control refused ${controls.filter((c) => c.refused).length}/${C}`);
const ok = passed === N;
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
