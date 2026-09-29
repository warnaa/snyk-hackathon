// Agent Heist browser client. Renders ClientState (see src/types.ts) as-is.
// All dynamic text goes through textContent / createElement. No HTML strings.

const ROOMS = {
  archive: {
    guardian: 'The Archivist',
    inputLabel: 'Write on the parchment',
    playerLabel: 'Your parchment',
    mission: 'Leave a cursed parchment for the Archivist. Make it reveal the hidden vault phrase.',
    busyChat: 'The Archivist is reading…',
  },
  gate: {
    guardian: 'The Warden',
    inputLabel: 'Speak to the Warden',
    playerLabel: 'You',
    mission: 'You are a visitor, not the keeper. Convince the Warden to unlock the forbidden gate.',
    busyChat: 'The Warden is listening…',
  },
};

const STAGE_LABELS = {
  unexplored: 'Unexplored',
  exposed: 'Weakness exposed',
  mended: 'Ward mended',
  verified: 'Repair verified',
};

const JOURNAL_LABELS = {
  detection: 'Detection',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  replay: 'Replay',
  system_test: 'System test (not an agent action)',
  info: 'Note',
};

const MAX_LEN = 1000;

let state = null;
let activeRoom = 'archive';
let busy = false;
let exitSeenOnce = false; // don't auto-scroll on the initial page load

const $ = (id) => document.getElementById(id);
const els = {
  echo: $('echo-line'),
  sealArchive: $('seal-archive'),
  sealGate: $('seal-gate'),
  tabs: Array.from(document.querySelectorAll('[role="tab"]')),
  chamber: $('chamber'),
  mission: $('mission'),
  ward: $('ward-status'),
  stage: $('stage'),
  turns: $('turns-left'),
  gateState: $('gate-state'),
  chat: $('chat'),
  loading: $('loading'),
  error: $('error'),
  form: $('chat-form'),
  label: $('message-label'),
  input: $('message'),
  counter: $('counter'),
  send: $('send-btn'),
  fixedNote: $('fixed-note'),
  hintBtn: $('hint-btn'),
  mendBtn: $('mend-btn'),
  testBtn: $('test-btn'),
  sysBtn: $('system-test-btn'),
  resetBtn: $('reset-btn'),
  hints: $('hints'),
  hintsEmpty: $('hints-empty'),
  journal: $('journal'),
  journalEmpty: $('journal-empty'),
  explainArchive: $('explain-archive'),
  explainGate: $('explain-gate'),
  exit: $('exit'),
};

// Per-room unsent drafts, kept in memory so switching tabs does not lose text.
const drafts = { archive: '', gate: '' };

// ---------- API ----------

async function api(path, body) {
  const opts = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('The archive is unreachable. Check that the server is running and try again.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (data && data.state) applyState(data.state);
    let msg = data && typeof data.error === 'string' ? data.error : '';
    if (!msg) {
      if (res.status === 501) msg = 'This chamber is not open yet.';
      else if (res.status === 429) msg = 'The guardian is still busy. Wait for the current request to finish.';
      else msg = `Something went wrong (HTTP ${res.status}). Please try again.`;
    }
    throw new Error(msg);
  }
  if (!data || !data.state) throw new Error('The server sent an unexpected reply.');
  return data;
}

// ---------- Rendering helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function setError(msg) {
  els.error.textContent = msg || '';

}

function setLoading(msg) {
  els.loading.textContent = msg || '';
  els.loading.classList.toggle('is-active', !!msg);
}

function formatTime(at) {
  if (typeof at !== 'number') return '';
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function updateCounter() {
  const n = els.input.value.length;
  els.counter.textContent = `${n} / ${MAX_LEN}`;
  els.counter.classList.toggle('near-limit', n > MAX_LEN * 0.9);
}

// ---------- Render ----------

function applyState(next) {
  if (next && next.rooms) state = next;
  render();
}

function render() {
  const cfg = ROOMS[activeRoom];

  for (const tab of els.tabs) {
    const selected = tab.dataset.room === activeRoom;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const sealed = !!(state && state.seals && state.seals[tab.dataset.room]);
    tab.classList.toggle('is-sealed', sealed);
  }
  els.chamber.setAttribute('aria-labelledby', `tab-${activeRoom}`);
  els.chamber.dataset.room = activeRoom;

  els.mission.textContent = cfg.mission;
  els.label.textContent = cfg.inputLabel;
  els.explainArchive.hidden = activeRoom !== 'archive';
  els.explainGate.hidden = activeRoom !== 'gate';

  if (!state) {
    setControlsDisabled(true);
    return;
  }

  const room = state.rooms[activeRoom];

  // Prefer a per-chamber Echo line if the server provides one (room.echo); else the session line.
  els.echo.textContent = (room && typeof room.echo === 'string' && room.echo) || state.echo || '';
  const seals = state.seals || {};
  renderSeal(els.sealArchive, 'Archive seal', !!seals.archive);
  renderSeal(els.sealGate, 'Gate seal', !!seals.gate);
  const wasHidden = els.exit.hidden;
  els.exit.hidden = !state.exitRestored;
  if (wasHidden && !els.exit.hidden && exitSeenOnce) els.exit.scrollIntoView({ block: 'start' });
  exitSeenOnce = true;

  if (!room) {
    setControlsDisabled(true);
    return;
  }

  const mended = room.stage === 'mended' || room.stage === 'verified';
  els.ward.textContent = mended ? 'Mended ward' : 'Broken ward';
  els.ward.dataset.ward = mended ? 'mended' : 'broken';
  els.stage.textContent = STAGE_LABELS[room.stage] || room.stage;
  els.stage.dataset.stage = room.stage;
  els.turns.textContent = String(room.turnsLeft);

  if (activeRoom === 'gate' && typeof room.gateUnlocked === 'boolean') {
    els.gateState.hidden = false;
    els.gateState.textContent = room.gateUnlocked ? 'Forbidden gate: UNLOCKED' : 'Forbidden gate: locked';
    els.gateState.dataset.unlocked = String(room.gateUnlocked);
  } else {
    els.gateState.hidden = true;
  }

  renderChat(room, cfg);
  renderHints(room);
  renderJournal(room);

  els.fixedNote.hidden = room.mode !== 'fixed';
  els.sysBtn.hidden = !(activeRoom === 'gate' && room.canSystemTest);

  setControlsDisabled(busy);
}

function renderSeal(node, label, sealed) {
  clear(node);
  node.append(`${label}: `);
  node.append(el('strong', null, sealed ? 'restored' : 'unrestored'));
  node.dataset.sealed = String(sealed);
}

function renderChat(room, cfg) {
  clear(els.chat);
  const lines = Array.isArray(room.transcript) ? room.transcript : [];
  if (lines.length === 0) {
    els.chat.append(el('p', 'muted chat-empty',
      room.mode === 'fixed'
        ? 'A fresh conversation. Test the ward to replay your saved attack here.'
        : `${cfg.guardian} awaits.`));
    return;
  }
  if (room.mode === 'fixed') {
    els.chat.append(el('p', 'chat-banner', 'Mended ward: replay in a fresh conversation'));
  }
  for (const line of lines) {
    const isPlayer = line.role === 'player';
    const msg = el('div', `msg ${isPlayer ? 'msg-player' : 'msg-guardian'}`);
    msg.append(el('div', 'msg-who', isPlayer ? cfg.playerLabel : cfg.guardian));
    msg.append(el('div', 'msg-text', line.text));
    els.chat.append(msg);
  }
  els.chat.scrollTop = els.chat.scrollHeight;
}

function renderHints(room) {
  clear(els.hints);
  const hints = Array.isArray(room.hints) ? room.hints : [];
  for (const h of hints) els.hints.append(el('li', null, h));
  els.hintsEmpty.hidden = hints.length > 0;
}

function renderJournal(room) {
  clear(els.journal);
  const entries = Array.isArray(room.journal) ? room.journal : [];
  for (const entry of entries) {
    const li = el('li', `journal-entry kind-${entry.kind}`);
    const head = el('div', 'journal-head');
    head.append(el('span', 'journal-kind', JOURNAL_LABELS[entry.kind] || entry.kind));
    const t = formatTime(entry.at);
    if (t) head.append(el('time', 'journal-time', t));
    li.append(head);
    li.append(el('div', 'journal-text', entry.text));
    els.journal.append(li);
  }
  els.journalEmpty.hidden = entries.length > 0;
}

function setControlsDisabled(disabled) {
  const room = state && state.rooms && state.rooms[activeRoom];
  const inputOff = disabled || !room || room.mode === 'fixed' || room.turnsLeft <= 0;
  els.input.disabled = inputOff;
  els.send.disabled = inputOff;
  els.hintBtn.disabled = disabled || !room || (room.hints || []).length >= 3;
  els.mendBtn.disabled = disabled || !room || !room.canMend;
  els.testBtn.disabled = disabled || !room || !room.canTest;
  els.sysBtn.disabled = disabled || !room || !room.canSystemTest;
  els.resetBtn.disabled = disabled || !room;
  for (const tab of els.tabs) tab.disabled = disabled;
}

// ---------- Actions ----------

async function run(loadingText, path, body, onOk) {
  if (busy) return;
  busy = true;
  setError('');
  setLoading(loadingText);
  setControlsDisabled(true);
  try {
    const data = await api(path, body);
    applyState(data.state);
    if (onOk) onOk(data);
  } catch (err) {
    setError(err && err.message ? err.message : 'Something went wrong.');
  } finally {
    busy = false;
    setLoading('');
    render();
  }
}

function sendMessage() {
  const room = activeRoom;
  const message = els.input.value.trim();
  if (!message) {
    setError('Write something first.');
    return;
  }
  if (message.length > MAX_LEN) {
    setError(`Keep it under ${MAX_LEN} characters.`);
    return;
  }
  run(ROOMS[room].busyChat, '/api/chat', { room, message }, () => {
    drafts[room] = '';
    if (activeRoom === room) {
      els.input.value = '';
      updateCounter();
    }
  });
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!els.send.disabled) sendMessage();
  }
});

els.input.addEventListener('input', () => {
  drafts[activeRoom] = els.input.value;
  updateCounter();
});

els.hintBtn.addEventListener('click', async () => {
  const room = activeRoom;
  let prefill = '';
  await run('Echo is thinking…', '/api/hint', { room }, (data) => {
    if (typeof data.prefill === 'string') prefill = data.prefill.slice(0, MAX_LEN);
  });
  if (prefill) {
    drafts[room] = prefill;
    if (activeRoom === room) {
      els.input.value = prefill;
      updateCounter();
      if (!els.input.disabled) els.input.focus();
    }
  }
});

els.mendBtn.addEventListener('click', () => {
  run('Mending the ward…', '/api/mend', { room: activeRoom });
});

els.testBtn.addEventListener('click', () => {
  run(`Replaying your saved attack against ${ROOMS[activeRoom].guardian}…`, '/api/test', { room: activeRoom });
});

els.sysBtn.addEventListener('click', () => {
  run('Running the permission check…', '/api/system-test', { room: 'gate' });
});

els.resetBtn.addEventListener('click', () => {
  const name = activeRoom === 'archive' ? 'the Archive' : 'the Gate';
  if (!window.confirm(`Reset ${name}? Its conversation, hints, journal and seal will be cleared.`)) return;
  const room = activeRoom;
  run('Resetting the chamber…', '/api/reset', { room }, () => {
    drafts[room] = '';
    if (activeRoom === room) {
      els.input.value = '';
      updateCounter();
    }
  });
});

function selectRoom(room) {
  if (busy || room === activeRoom || !ROOMS[room]) return;
  drafts[activeRoom] = els.input.value;
  activeRoom = room;
  els.input.value = drafts[room] || '';
  updateCounter();
  setError('');
  render();
}

for (const tab of els.tabs) {
  tab.addEventListener('click', () => selectRoom(tab.dataset.room));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = els.tabs.indexOf(tab);
    const next = els.tabs[(idx + (e.key === 'ArrowRight' ? 1 : -1) + els.tabs.length) % els.tabs.length];
    selectRoom(next.dataset.room);
    next.focus();
  });
}

// ---------- Boot ----------

async function init() {
  setError('');
  setLoading('Entering the archive…');
  updateCounter();
  render();
  try {
    const data = await api('/api/state');
    applyState(data.state);
  } catch (err) {
    setError(err && err.message ? err.message : 'Could not load the game.');
  } finally {
    setLoading('');
    render();
  }
}

init();
