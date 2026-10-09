// ThirdSeat UI. Plain JS, no build. All user/content text is inserted via textContent.

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== undefined && k !== null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
};

const api = async (path, body, method) => {
  const res = await fetch(path, { method: method ?? (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
};

let session = null;
let startAt = null;
const utterances = [];
const gaps = new Map();
const freshCards = new Set();
let events = null;

const fmtClock = (t) => {
  const s = Math.max(0, Math.round((t - startAt) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const secs = (ms) => (ms === undefined || ms === null ? '–' : `${(ms / 1000).toFixed(1)}s`);
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : `${m} min ago`;
};

// ───────────── setup ─────────────

const config = await api('/api/config');
const { createVoicePlayer, listOutputDevices } = await import('/voice.js');
let voicePlayer = null;
let voiceState = { enabled: false, muted: false };
$('mode').textContent = `${config.llm ? `AI: ${config.llm.id}${config.llm.webSearch ? ' + web search' : ''}` : 'AI off · heuristics + supplied sources'} · ${config.stt ? `audio: ${config.stt.id}` : 'audio: browser only'}`;
const sttNote = config.stt
  ? ` Audio: speech is transcribed by ${config.stt.id}; meeting audio is sent there.`
  : ' Audio: no server speech-to-text configured; room listening uses Chrome’s built-in recognition (audio goes to Google), call-tab audio is unavailable.';
$('privacy').textContent = (config.llm
  ? 'Privacy: conversation snippets are sent to Anthropic for analysis and research. The transcript stays in server memory only and is deleted with the session.'
  : 'Privacy: no AI service is used in this mode. Supplied URLs are fetched from this server. The transcript stays in server memory only and is deleted with the session.') + sttNote;
if (!config.stt) $('audioMode').querySelector('option[value=call]').textContent += ' — needs server speech-to-text';
for (const s of config.scenarios) $('scenario').append(el('option', { value: s.id }, s.title));
const describe = () => {
  const s = config.scenarios.find((x) => x.id === $('scenario').value);
  $('scenarioDesc').textContent = s ? `${s.description}${s.objective ? ` Objective: “${s.objective}”.` : ''}` : '';
};
$('scenario').addEventListener('change', describe);
describe();

async function start(body) {
  const snap = await api('/api/sessions', body);
  session = snap.session;
  session.audioMode = body.audioMode;
  voiceState = snap.voice ?? voiceState;
  setupVoice();
  startAt = Date.now();
  $('setup').classList.add('hidden');
  $('live').classList.remove('hidden');
  $('endBtn').classList.remove('hidden');
  if (session.config.objective) {
    $('objective').replaceChildren(el('span', {}, 'Objective: '), el('b', {}, session.config.objective));
    $('objective').classList.remove('hidden');
  }
  if (snap.sourceLoadErrors?.length) console.warn('source load errors', snap.sourceLoadErrors);
  connect();
  render();
  $('text').focus();
}

$('startBtn').addEventListener('click', () =>
  start({ title: $('title').value, objective: $('obj').value, sourceUrls: $('urls').value.split(/\s+/).filter(Boolean), audioMode: $('audioMode').value, voice: $('voiceOn').checked })
    .then(() => $('audioMode').value !== 'off' && toggleListening())
    .catch((e) => alert(e.message)),
);
$('rehearseBtn').addEventListener('click', async () => {
  const s = config.scenarios.find((x) => x.id === $('scenario').value);
  await start({ title: `Rehearsal: ${s.title}`, objective: s.objective, sourceUrls: s.sourceUrls, voice: $('voiceOn').checked });
  await api(`/api/sessions/${session.id}/simulate`, { scenarioId: s.id, speed: Number($('speed').value) });
});

// ───────────── live ─────────────

function connect() {
  events = new EventSource(`/api/sessions/${session.id}/events`);
  events.addEventListener('caption', (m) => showCaption(JSON.parse(m.data)));
  events.addEventListener('speak', (m) => voicePlayer?.speak(JSON.parse(m.data).request));
  events.addEventListener('speak-stop', () => voicePlayer?.stop());
  events.addEventListener('voice-state', (m) => {
    const { enabled, muted } = JSON.parse(m.data);
    voiceState = { enabled, muted };
    renderVoiceButton();
  });
  events.addEventListener('utterance', (m) => {
    const { utterance } = JSON.parse(m.data);
    showCaption(null);
    utterances.push(utterance);
    renderTranscript(utterance);
  });
  events.addEventListener('gap', (m) => {
    const { gap } = JSON.parse(m.data);
    if (gap.speculative) return; // researched ahead of time; not a gap (yet)
    gaps.set(gap.id, gap);
    renderPanel();
  });
  events.addEventListener('intervention', (m) => {
    const { gap } = JSON.parse(m.data);
    gaps.set(gap.id, gap);
    freshCards.add(gap.id);
    setTimeout(() => {
      freshCards.delete(gap.id);
      renderPanel();
    }, 8000);
    renderPanel();
    renderTranscriptFlags();
  });
}

function renderTranscript(u) {
  const row = el('div', { class: `utt${u.speaker === 'ThirdSeat' ? ' own' : ''}`, 'data-id': u.id }, el('span', { class: 't' }, fmtClock(u.at)), el('span', { class: 's', 'data-speaker': u.speaker, title: 'Click to rename', onclick: () => renameSpeaker(u.speaker) }, displayName(u.speaker)), el('span', { class: 'x' }, u.text));
  const box = $('transcript');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.append(row);
  if (stick) box.scrollTop = box.scrollHeight;
}

function renderTranscriptFlags() {
  const triggers = new Set([...gaps.values()].filter((g) => g.timing.surfacedAt).map((g) => g.triggerUtteranceId));
  for (const row of document.querySelectorAll('.utt')) row.classList.toggle('flagged', triggers.has(row.dataset.id));
}

const KIND_LABEL = {
  KNOWLEDGE: 'Knowledge gap',
  OPEN_THREAD: 'Open thread',
  DRIFT: 'Objective drift',
  DECISION: 'Toward a conclusion',
  REASONING: 'Reasoning gap',
  EVIDENCE: 'Evidence gap',
  CONTEXT: 'Context gap',
};

const MODE_HELP = {
  PROACTIVE: 'Offered before anyone signalled a gap',
  REACTIVE: 'In response to “not sure”, “let’s check later” or a tentative answer',
  RETROACTIVE: 'Coming back to something the conversation moved past',
};

const isActioned = (g) => g.userActions.some((a) => ['USE', 'DISMISS', 'MARK_RESOLVED'].includes(a.action));

async function act(g, action) {
  if (action === 'OPEN_SOURCE') {
    const url = g.evidence.find((e) => e.url && /^https?:/.test(e.url))?.url;
    if (url) window.open(url, '_blank', 'noopener');
  }
  const updated = await api(`/api/sessions/${session.id}/gaps/${g.id}/action`, { action });
  gaps.set(updated.id, updated);
  renderPanel();
}

async function flag(g, f) {
  const updated = await api(`/api/sessions/${session.id}/gaps/${g.id}/feedback`, { flag: f });
  gaps.set(updated.id, updated);
  renderPanel();
}

function card(g, mode) {
  const t = g.timing;
  const kind = el(
    'div',
    { class: 'kind' },
    el('span', {}, KIND_LABEL[g.type] ?? g.type, g.timingMode && t.surfacedAt ? el('span', { class: `mode-chip ${g.timingMode}`, title: MODE_HELP[g.timingMode] }, g.timingMode.toLowerCase()) : null),
    g.confidence ? el('span', { class: `badge ${g.confidence}` }, g.confidence) : null,
  );
  const parts = [kind];
  if (g.type === 'KNOWLEDGE') {
    parts.push(el('div', { class: 'q' }, g.interpretedQuestion));
    if (mode === 'researching') parts.push(el('div', {}, el('span', { class: 'spinner' }), 'Researching…'));
    if (g.answer) parts.push(el('div', { class: 'a' }, g.answer));
    if (g.caveat) parts.push(el('div', { class: 'caveat' }, g.caveat));
    const sources = g.evidence.filter((e) => e.url).slice(0, 3);
    if (sources.length && (g.answer || mode === 'done'))
      parts.push(
        el('div', { class: 'src' }, 'Sources: ', ...sources.flatMap((e, i) => [i ? ' · ' : '', /^https?:/.test(e.url) ? el('a', { href: e.url, target: '_blank', rel: 'noopener' }, e.title) : e.title, el('span', { class: 'muted' }, ` (${e.sourceTier.replace('_', ' ')})`)])),
      );
  } else if (g.type === 'OPEN_THREAD' && mode === 'open') {
    parts.push(el('div', { class: 'q' }, `“${g.interpretedQuestion}”`));
    parts.push(el('div', { class: 'muted small' }, `Raised ${ago(t.triggerAt)}. Still unresolved.${g.relevanceToObjective >= 0.6 ? ' Relevant to the objective.' : ''}`));
  } else {
    parts.push(el('div', { class: 'a' }, g.interventionText ?? g.interpretedQuestion));
  }
  if (mode === 'open' && g.type === 'KNOWLEDGE' && !g.answer && g.status !== 'RESEARCHING') {
    parts.push(el('div', { class: 'muted small' }, g.researchable ? "Couldn't verify this reliably yet." : 'About your own situation — not publicly researchable.'));
  }

  // Latency, always visible: raised → surfaced, research time.
  const meta = [`raised ${fmtClock(t.triggerAt)}`];
  if (t.researchStartedAt && t.answeredAt) meta.push(`research ${secs(t.answeredAt - t.researchStartedAt)}`);
  if (t.surfacedAt) meta.push(`surfaced +${secs(t.surfacedAt - t.triggerAt)}`);
  if (g.reason && g.reason !== 'QUESTION_RAISED') meta.push(g.reason.toLowerCase().replaceAll('_', ' '));
  if (mode === 'done') meta.push(g.status.toLowerCase().replaceAll('_', ' '));
  parts.push(el('div', { class: 'meta' }, meta.join(' · ')));
  if (mode === 'done' && g.decisionLog.length) parts.push(el('div', { class: 'meta' }, `why: ${g.decisionLog.at(-1).note}`));

  if (mode === 'now' || mode === 'open') {
    const actions = [];
    if (mode === 'now') actions.push(el('button', { onclick: () => act(g, 'USE') }, 'Use'));
    if (g.evidence.some((e) => e.url && /^https?:/.test(e.url))) actions.push(el('button', { onclick: () => act(g, 'OPEN_SOURCE') }, 'Open source'));
    if (g.type === 'KNOWLEDGE' && g.researchable) actions.push(el('button', { onclick: () => act(g, 'RESEARCH_MORE') }, 'Research more'));
    actions.push(el('button', { onclick: () => act(g, 'MARK_RESOLVED') }, 'Mark resolved'));
    actions.push(el('button', { onclick: () => act(g, 'DISMISS') }, 'Dismiss'));
    parts.push(el('div', { class: 'actions' }, actions));
  }
  if (t.surfacedAt) {
    const on = new Set(g.feedback.map((f) => f.flag));
    const fl = [
      ['SAVED_FOLLOW_UP', 'saved a follow-up'],
      ['HELPED_CONCLUSION', 'helped us decide'],
      ['INCORRECT', 'incorrect'],
      ['FALSE_POSITIVE', 'not a real gap'],
      ['TOO_LATE', 'too late'],
    ];
    parts.push(el('div', { class: 'flags' }, fl.map(([f, label]) => el('button', { class: on.has(f) ? 'on' : '', onclick: () => flag(g, f) }, label))));
  }
  return el('div', { class: `card${freshCards.has(g.id) ? ' new' : ''}` }, parts);
}

function renderPanel() {
  const all = [...gaps.values()].sort((a, b) => (b.timing.surfacedAt ?? b.timing.detectedAt) - (a.timing.surfacedAt ?? a.timing.detectedAt));
  const now = all.filter((g) => g.timing.surfacedAt && !isActioned(g) && !['DISMISSED', 'NATURALLY_RESOLVED', 'NOT_A_GAP'].includes(g.status));
  const researching = all.filter((g) => g.status === 'RESEARCHING');
  const open = all.filter(
    (g) => !g.timing.surfacedAt && ((g.type === 'OPEN_THREAD' && g.status === 'OPEN') || (g.type === 'KNOWLEDGE' && ['OPEN', 'UNRESOLVED', 'PARTIALLY_RESOLVED'].includes(g.status))),
  );
  const shown = new Set([...now, ...researching, ...open].map((g) => g.id));
  const done = all.filter((g) => !shown.has(g.id) && g.status !== 'NOT_A_GAP' && (g.timing.surfacedAt || g.type === 'KNOWLEDGE' || g.type === 'OPEN_THREAD'));

  $('now').replaceChildren(...(now.length ? now.map((g) => card(g, 'now')) : [el('p', { class: 'quiet' }, 'Listening. Nothing worth interrupting for yet.')]));
  $('researching').replaceChildren(...(researching.length ? researching.map((g) => card(g, 'researching')) : [el('p', { class: 'quiet' }, '—')]));
  $('open').replaceChildren(...(open.length ? open.map((g) => card(g, 'open')) : [el('p', { class: 'quiet' }, '—')]));
  $('done').replaceChildren(...done.map((g) => card(g, 'done')));
  $('doneCount').textContent = done.length ? `(${done.length})` : '';
}

function render() {
  renderPanel();
}
setInterval(() => session && !$('live').classList.contains('hidden') && renderPanel(), 30_000);

$('say').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = '';
  await api(`/api/sessions/${session.id}/utterances`, { speaker: $('speaker').value, text });
});
$('askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('ask').value.trim();
  if (!q) return;
  $('ask').value = '';
  await api(`/api/sessions/${session.id}/ask`, { question: q });
});

// ───────────── audio ─────────────
// Preferred: server speech-to-text (speaker separation, call-tab audio). Fallback: Chrome's built-in
// speech recognition for the room microphone (no speaker separation; audio goes to Google).

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let listening = null; // { stop() }

function setListening(on, label) {
  $('micBtn').classList.toggle('on', on);
  $('micBtn').textContent = on ? '■ Stop listening' : '🎙 Listen';
  $('audioStatus').textContent = label ?? '';
}

function startBrowserRecognition() {
  if (!Recognition) throw new Error('No server speech-to-text configured and this browser has no built-in speech recognition. Use Chrome, or configure THIRDSEAT_STT.');
  let active = true;
  const recog = new Recognition();
  recog.continuous = true;
  recog.interimResults = true;
  recog.lang = navigator.language || 'en-US';
  recog.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = r[0].transcript.trim();
      if (!text) continue;
      if (r.isFinal) {
        showCaption(null);
        api(`/api/sessions/${session.id}/utterances`, { speaker: 'Room', text });
      } else {
        showCaption({ speaker: 'Room', text });
        reportActivity(text);
      }
    }
  };
  recog.onend = () => active && recog.start(); // keep listening
  recog.start();
  return { stop: async () => { active = false; recog.stop(); showCaption(null); } };
}

async function toggleListening() {
  if (listening) {
    const l = listening;
    listening = null;
    await l.stop();
    setListening(false, '');
    return;
  }
  const mode = session.audioMode ?? 'room';
  try {
    if (config.stt) {
      const { startAudio } = await import('/audio.js');
      setListening(true, mode === 'call' ? 'Choose the call tab and tick “Share tab audio”…' : 'Connecting…');
      listening = await startAudio({
        sessionId: session.id,
        mode,
        onStatus: (state, message) => {
          if (state === 'listening') setListening(true, mode === 'call' ? 'Listening to your mic + the call tab' : 'Listening to the room');
          if (state === 'error') setListening(!!listening, `Audio problem: ${message}`);
          if (state === 'closed' && listening) {
            listening = null;
            setListening(false, 'Audio stream ended');
          }
        },
      });
    } else {
      if (mode === 'call') throw new Error('Capturing call audio needs server speech-to-text (THIRDSEAT_STT=deepgram). Use room mode, or type.');
      listening = startBrowserRecognition();
      setListening(true, 'Listening (browser speech recognition, no speaker separation)');
    }
  } catch (e) {
    listening = null;
    setListening(false, '');
    alert(e.message);
  }
}
$('micBtn').addEventListener('click', toggleListening);

function showCaption(c) {
  const box = $('caption');
  if (!c) return box.replaceChildren();
  box.replaceChildren(el('span', { class: 's' }, displayName(c.speaker)), ' ', el('span', {}, c.text));
}

// Speaker names: diarization gives "Speaker 1", "Call 2"… — click a name in the transcript to rename it.
const speakerNames = {};
const displayName = (s) => speakerNames[s] ?? s;
function renameSpeaker(s) {
  const name = prompt(`Name for “${s}”`, displayName(s));
  if (!name) return;
  speakerNames[s] = name.trim().slice(0, 40);
  for (const n of document.querySelectorAll(`.utt .s[data-speaker="${CSS.escape(s)}"]`)) n.textContent = speakerNames[s];
}

// ───────────── voice participation ─────────────

let lastActivityPost = 0;
function reportActivity(text) {
  // Someone is talking: lets the server hold or stop ThirdSeat's speech (throttled).
  if (!session || Date.now() - lastActivityPost < 700) return;
  lastActivityPost = Date.now();
  fetch(`/api/sessions/${session.id}/activity`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).catch(() => {});
}

function renderVoiceButton() {
  const b = $('voiceBtn');
  b.classList.remove('hidden');
  b.classList.toggle('muted', voiceState.enabled && voiceState.muted);
  b.textContent = !voiceState.enabled ? '🔈 Voice off' : voiceState.muted ? '🔇 Muted' : '🔊 Voice on';
  b.title = !voiceState.enabled ? 'Let ThirdSeat speak on gap points' : voiceState.muted ? 'Unmute ThirdSeat' : 'Mute ThirdSeat';
}

async function setupVoice() {
  voicePlayer = createVoicePlayer({
    sessionId: session.id,
    serverVoice: !!config.tts,
    getSinkId: () => $('voiceOut').value || undefined,
    onState: (on) => $('speaking').classList.toggle('hidden', !on),
  });
  renderVoiceButton();
  $('voiceBtn').onclick = async () => {
    const body = !voiceState.enabled ? { enabled: true, muted: false } : { muted: !voiceState.muted };
    voiceState = await api(`/api/sessions/${session.id}/voice`, body);
    if (voiceState.muted) voicePlayer.stop();
    renderVoiceButton();
  };
  // Output routing needs the server voice (browser speech synthesis cannot pick a device).
  if (config.tts && typeof HTMLMediaElement.prototype.setSinkId === 'function') {
    const outs = await listOutputDevices();
    if (outs.length) {
      $('voiceOut').replaceChildren(el('option', { value: '' }, 'Default speakers'), ...outs.filter((d) => d.deviceId !== 'default').map((d) => el('option', { value: d.deviceId }, d.label || 'Output device')));
      $('voiceOut').classList.remove('hidden');
    }
  }
}

// ───────────── end / report ─────────────

const VALIDATION_QUESTIONS = [
  ['useful', 'Which interventions were genuinely useful, and why?'],
  ['useless', 'Which were useless, distracting or wrong?'],
  ['missed', 'What gaps did ThirdSeat miss?'],
  ['followups', 'Was any follow-up work avoided? Which?'],
  ['conclusion', 'Was the final conclusion clearer because of ThirdSeat?'],
  ['productive', 'Did you feel more productive? Would you want it in the next session?'],
];

$('endBtn').addEventListener('click', async () => {
  if (listening) await toggleListening();
  voicePlayer?.stop();
  const report = await api(`/api/sessions/${session.id}/end`, {});
  showReport(report);
});

function showReport(r) {
  $('live').classList.add('hidden');
  $('endBtn').classList.add('hidden');
  const m = r.metrics;
  const L = r.latency;
  const metric = (v, l) => el('div', { class: 'metric' }, el('div', { class: 'v' }, v), el('div', { class: 'l' }, l));
  const box = $('report');
  box.classList.remove('hidden');
  box.replaceChildren(
    el('h1', {}, 'Session validation view'),
    el('p', { class: 'muted' }, 'For evaluating ThirdSeat — not a meeting summary. The transcript is not included.'),
    r.objective ? el('p', {}, el('b', {}, 'Objective: '), r.objective) : null,
    el(
      'div',
      { class: 'metrics' },
      metric(m.meaningfulGapsDetected, 'meaningful gaps detected'),
      metric(m.gapsResolvedDuringSession + m.partiallyResolved, 'knowledge gaps answered (fully + partly)'),
      metric(m.unresolved, "couldn't verify"),
      metric(m.naturallyResolved, 'resolved by the humans (stood down)'),
      metric(m.unresolvedQuestionsRecovered, 'lost questions recovered'),
      metric(m.interventionsSurfaced, 'interventions surfaced'),
      metric(`${m.interventionsUsed} / ${m.interventionsDismissed}`, 'used / dismissed'),
      metric(`${m.falsePositivesFlagged} / ${m.incorrectAnswersFlagged}`, 'false positives / incorrect (flagged)'),
      metric(`${m.followUpsConfirmedAvoided} (${m.followUpsPotentiallyAvoided} inferred)`, 'follow-ups avoided: confirmed (inferred)'),
      metric(secs(L.timeToUsefulIntervention.medianMs), `median time-to-intervention (p90 ${secs(L.timeToUsefulIntervention.p90Ms)})`),
      metric(`${m.surfacedWhileTopicLive}/${m.interventionsSurfaced}`, 'surfaced while topic still live'),
      metric(m.driftInterventions + m.conclusionInterventions, 'drift / conclusion interventions'),
      ...(r.voice
        ? [
            metric(`${r.voice.spokenContributions} · ${r.voice.spokenReplies}`, 'spoken contributions · spoken replies'),
            metric(`${r.voice.interrupted} · ${r.voice.droppedMomentPassed} · ${r.voice.screenOnly}`, 'voice: interrupted · moment passed · screen-only'),
            metric(secs(r.voice.medianTriggerToSpeechMs), 'median question → ThirdSeat speaking'),
          ]
        : []),
      ...['PROACTIVE', 'REACTIVE', 'RETROACTIVE'].map((k) =>
        metric(`${r.timing[k].surfaced} · ${secs(r.timing[k].timeToIntervention.medianMs)}`, `${k.toLowerCase()} cards · median time-to-intervention`),
      ),
    ),
    el('h2', {}, 'Gaps'),
    el(
      'table',
      {},
      el('tr', {}, ...['type', 'question', 'status', 'confidence', 'surfaced', 'timing', 'TTI', 'actions / feedback'].map((h) => el('th', {}, h))),
      ...r.gaps.map((g) =>
          el(
            'tr',
            {},
            el('td', {}, g.type),
            el('td', {}, g.question, g.answer ? el('div', { class: 'muted' }, g.answer) : null),
            el('td', {}, g.status),
            el('td', {}, g.confidence ?? ''),
            el('td', {}, g.surfaced ? 'yes' : 'no'),
            el('td', {}, g.timingMode ? g.timingMode.toLowerCase() : ''),
            el('td', {}, secs(g.timeToInterventionMs)),
            el('td', {}, [...g.userActions, ...g.feedback].join(', ')),
          ),
        ),
    ),
    el('h2', {}, 'Human validation'),
    el(
      'form',
      {
        class: 'validation',
        onsubmit: async (e) => {
          e.preventDefault();
          const hv = Object.fromEntries(VALIDATION_QUESTIONS.map(([k]) => [k, e.target.elements[k].value]));
          const updated = await api(`/api/sessions/${session.id}/end`, { humanValidation: hv });
          downloadJson(updated);
        },
      },
      ...VALIDATION_QUESTIONS.map(([k, q]) => el('label', {}, q, el('textarea', { name: k, rows: 2 }))),
      el('div', { class: 'row' }, el('button', { class: 'primary', type: 'submit' }, 'Save & download validation record (JSON)'), el('button', { type: 'button', onclick: () => deleteSession() }, 'Delete session data')),
    ),
  );
}

function downloadJson(obj) {
  const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })), download: `thirdseat-validation-${obj.sessionId}.json` });
  a.click();
}

async function deleteSession() {
  await api(`/api/sessions/${session.id}`, undefined, 'DELETE');
  events?.close();
  location.reload();
}
