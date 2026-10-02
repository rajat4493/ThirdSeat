import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { UtteranceAssembler, speakerLabel, type AssembledUtterance } from '../src/audio/stt.ts';
import { DeepgramStt } from '../src/audio/deepgram.ts';
import { AudioConversationSource } from '../src/conversation/audio-source.ts';
import { ManualClock, realClock } from '../src/clock.ts';
import { startMockDeepgram, tone } from './mock-deepgram.ts';

const w = (text: string, start: number, speaker?: number) => ({ text, start, end: start + 0.2, speaker });

test('assembler: one utterance per speaker turn, flushed at endpoints', () => {
  const out: AssembledUtterance[] = [];
  const a = new UtteranceAssembler((u) => out.push(u));
  a.handle({ type: 'final', channel: 0, words: [w('Does', 0, 0), w('Teams', 0.3, 0), w('support', 0.6, 0), w('that?', 0.9, 0), w('Not', 1.5, 1), w('sure', 1.8, 1)] });
  assert.equal(out.length, 1, 'speaker change splits the segment');
  assert.deepEqual([out[0].speaker, out[0].text], [0, 'Does Teams support that?']);
  a.handle({ type: 'final', channel: 0, words: [w('honestly.', 2.1, 1)] });
  a.handle({ type: 'endpoint', channel: 0 });
  assert.deepEqual([out[1].speaker, out[1].text], [1, 'Not sure honestly.']);
  a.handle({ type: 'interim', channel: 0, text: 'ignored' });
  a.handle({ type: 'endpoint', channel: 0 });
  assert.equal(out.length, 2, 'interim text is never an utterance');
});

test('speaker labels are generic and channel-aware', () => {
  assert.equal(speakerLabel(1, 0, 0), 'Speaker 1');
  assert.equal(speakerLabel(1, 0), 'Room');
  assert.equal(speakerLabel(2, 0, 0), 'Mic 1');
  assert.equal(speakerLabel(2, 1, 1), 'Call 2');
});

test('Deepgram client: auth, parameters, audio forwarding, diarized utterances, captions, CloseStream', async () => {
  const mock = await startMockDeepgram([
    { speaker: 0, text: 'Can Teams give us live transcripts?' },
    { speaker: 1, text: "I'm not sure." },
  ]);
  const clock = new ManualClock(1_000_000);
  const got: { speaker: string; text: string; at?: number }[] = [];
  const captions: string[] = [];
  const src = new AudioConversationSource({
    provider: new DeepgramStt({ apiKey: 'test-key', url: mock.url }),
    clock,
    sampleRate: 16000,
    channels: 1,
    onCaption: (c) => captions.push(c.text),
  });
  await src.open();
  src.start((u) => got.push(u));
  for (let i = 0; i < 4; i++) src.pushAudio(tone(0.05));
  clock.advance(5000);
  await new Promise((r) => setTimeout(r, 150));
  await src.close();
  await mock.close();

  const c = mock.connections[0];
  assert.equal(c.authorization, 'Token test-key');
  const q = new URL(c.url, 'http://x').searchParams;
  for (const [k, v] of Object.entries({ encoding: 'linear16', sample_rate: '16000', channels: '1', diarize: 'true', interim_results: 'true', multichannel: 'false' })) assert.equal(q.get(k), v, k);
  assert.equal(c.bytes, 4 * 800 * 2, "every PCM byte forwarded");
  assert.ok(c.nonSilentSamples > 1000, 'real audio reached the provider');
  assert.ok(c.controls.includes('CloseStream'));
  assert.deepEqual(got.map((u) => [u.speaker, u.text]), [['Speaker 1', 'Can Teams give us live transcripts?'], ['Speaker 2', "I'm not sure."]]);
  assert.ok(captions.length >= 2, 'interim captions delivered');
  // Stamped with speech time (audio start + word end), not arrival time.
  assert.ok(got[0].at! < clock.now());
});

test('two-channel call mode: mic and call separated; mic echo of the call is dropped', async () => {
  const mock = await startMockDeepgram([
    { channel: 1, speaker: 0, text: 'Does Zoom expose raw audio to apps?' },
    { channel: 0, speaker: 0, text: 'Does Zoom expose raw audio to apps?' }, // echo picked up by the mic
    { channel: 0, speaker: 0, text: 'No idea, we should check.' },
  ]);
  const got: { speaker: string; text: string }[] = [];
  const src = new AudioConversationSource({ provider: new DeepgramStt({ apiKey: 'k', url: mock.url }), clock: realClock, sampleRate: 16000, channels: 2 });
  await src.open();
  src.start((u) => got.push(u));
  for (let i = 0; i < 3; i++) src.pushAudio(tone(0.1, 16000, 2));
  await new Promise((r) => setTimeout(r, 150));
  await src.close();
  await mock.close();
  assert.equal(new URL(mock.connections[0].url, 'http://x').searchParams.get('multichannel'), 'true');
  assert.deepEqual(got.map((u) => [u.speaker, u.text]), [['Call 1', 'Does Zoom expose raw audio to apps?'], ['Mic 1', 'No idea, we should check.']]);
});

test('server: audio WebSocket → speech-to-text → engine → gap; 503 when speech-to-text is off', async (t) => {
  const mock = await startMockDeepgram([
    { speaker: 0, text: 'Can Microsoft Teams give an external app live transcript data?' },
    { speaker: 1, text: "I don't know, we'd need to check." },
  ]);
  const PORT = 4800 + Math.floor(Math.random() * 400);
  const proc = spawn(process.execPath, ['src/server/main.ts'], {
    env: { ...process.env, PORT: String(PORT), THIRDSEAT_LLM: 'off', THIRDSEAT_STT: 'deepgram', DEEPGRAM_API_KEY: 'test-key', THIRDSEAT_STT_URL: mock.url },
    stdio: 'pipe',
  });
  t.after(async () => {
    proc.kill();
    await mock.close();
  });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  for (let i = 0; i < 50 && !logs.includes('listening on'); i++) await new Promise((r) => setTimeout(r, 100));
  const base = `http://127.0.0.1:${PORT}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.stt.id, 'deepgram:nova-3');
  assert.doesNotMatch(JSON.stringify(config), /test-key/, 'provider key never sent to the browser');

  const snap = await (await fetch(`${base}/api/sessions`, { method: 'POST', body: JSON.stringify({ objective: 'Decide whether to build on Teams' }) })).json();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/sessions/${snap.session.id}/audio?channels=1&sampleRate=16000`);
  const status: string[] = [];
  ws.on('message', (d) => status.push(JSON.parse(d.toString()).state));
  await new Promise((r) => ws.once('open', r));
  for (let i = 0; i < 50 && !status.includes('listening'); i++) await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 5; i++) ws.send(tone(0.05));
  await new Promise((r) => setTimeout(r, 400));
  const after = await (await fetch(`${base}/api/sessions/${snap.session.id}`)).json();
  assert.deepEqual(after.transcript.map((u: { speaker: string }) => u.speaker), ['Speaker 1', 'Speaker 2']);
  const gap = after.gaps.find((g: { type: string; reason: string }) => g.type === 'KNOWLEDGE');
  assert.ok(gap, 'spoken question became a knowledge gap');
  assert.equal(gap.reason, 'DEFERRED_FOR_LATER');
  ws.send(JSON.stringify({ type: 'stop' }));
  const report = await (await fetch(`${base}/api/sessions/${snap.session.id}/end`, { method: 'POST', body: '{}' })).json();
  assert.equal(report.audio.provider, 'deepgram:nova-3');
  assert.ok(report.audio.bytesReceived > 0);
  assert.doesNotMatch(logs, /live transcript data/, 'speech content not logged');

  // Off: same endpoint refuses cleanly.
  const PORT2 = PORT + 401;
  const off = spawn(process.execPath, ['src/server/main.ts'], { env: { ...process.env, PORT: String(PORT2), THIRDSEAT_STT: 'off' }, stdio: 'pipe' });
  t.after(() => off.kill());
  let offLogs = '';
  off.stdout.on('data', (d) => (offLogs += d));
  for (let i = 0; i < 50 && !offLogs.includes('listening on'); i++) await new Promise((r) => setTimeout(r, 100));
  const s2 = await (await fetch(`http://127.0.0.1:${PORT2}/api/sessions`, { method: 'POST', body: '{}' })).json();
  const refused = await new Promise<number>((resolve) => {
    const w2 = new WebSocket(`ws://127.0.0.1:${PORT2}/api/sessions/${s2.session.id}/audio`);
    w2.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    w2.on('open', () => resolve(101));
    w2.on('error', () => {});
  });
  assert.equal(refused, 503);
});
