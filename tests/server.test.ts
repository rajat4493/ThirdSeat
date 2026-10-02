// Smoke test of the HTTP API + SSE stream with a real server process (heuristic mode, no network sources).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 4300 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}`;

test('API: create session, stream events, ingest utterances, act, report, delete', async (t) => {
  const proc = spawn(process.execPath, ['src/server/main.ts'], { env: { ...process.env, PORT: String(PORT), THIRDSEAT_LLM: 'off' }, stdio: 'pipe' });
  t.after(() => proc.kill());
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  for (let i = 0; i < 50 && !logs.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));

  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.llm, null);
  assert.doesNotMatch(JSON.stringify(config), /sk-ant|api[_-]?key/i, 'no credentials exposed to the client');

  const snap = await (await fetch(`${base}/api/sessions`, { method: 'POST', body: JSON.stringify({ title: 't', objective: 'Decide whether this idea deserves validation' }) })).json();
  const id = snap.session.id;

  const events: string[] = [];
  const ac = new AbortController();
  const sse = fetch(`${base}/api/sessions/${id}/events`, { signal: ac.signal })
    .then(async (res) => {
      const reader = res.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        events.push(new TextDecoder().decode(value));
      }
    })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 100));

  const say = (speaker: string, text: string) => fetch(`${base}/api/sessions/${id}/utterances`, { method: 'POST', body: JSON.stringify({ speaker, text }) });
  assert.equal((await say('A', "Why wouldn't Microsoft just build this into Copilot?")).status, 202);
  await say('B', "That's a good point.");
  await say('A', 'Anyway, the bot joins the call and streams audio to us.');
  await say('B', 'And we transcribe it in our own service.');
  await new Promise((r) => setTimeout(r, 400));
  const after = await (await fetch(`${base}/api/sessions/${id}`)).json();
  const thread = after.gaps.find((g: { type: string }) => g.type === 'OPEN_THREAD');
  assert.ok(thread, 'open thread tracked via API');
  assert.ok(events.join('').includes('event: utterance'));
  assert.ok(events.join('').includes('event: gap'));

  const acted = await (await fetch(`${base}/api/sessions/${id}/gaps/${thread.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'MARK_RESOLVED' }) })).json();
  assert.equal(acted.status, 'RESOLVED');
  assert.equal((await fetch(`${base}/api/sessions/${id}/gaps/${thread.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'HACK' }) })).status, 400);

  const report = await (await fetch(`${base}/api/sessions/${id}/end`, { method: 'POST', body: JSON.stringify({ humanValidation: { useful: 'x' } }) })).json();
  assert.equal(report.metrics.openThreadsTracked, 1);
  assert.equal(report.humanValidation.useful, 'x');
  assert.equal(report.transcript, undefined, 'report excludes the transcript');
  assert.doesNotMatch(logs, /streams audio/, 'server logs do not contain utterance text');

  assert.equal((await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/sessions/${id}`)).status, 404, 'session data deleted');
  ac.abort();
  await sse;
});
