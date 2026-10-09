import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import { VoiceAgent, type VoiceEvent } from '../src/voice/voice-agent.ts';
import { SpeechComposer, faithful, forSpeech, speakable, templateFor } from '../src/voice/composer.ts';
import { classifyAddressed, detectAddressed } from '../src/voice/addressed.ts';
import type { Gap } from '../src/domain/types.ts';
import type { LlmClient } from '../src/llm/client.ts';

const OBJ = { id: 'v', title: 'voice', objective: 'Decide which collaboration platform to integrate with first.' };

function withVoice(config = {}) {
  const env = setup(OBJ);
  const voice = new VoiceAgent({ engine: env.engine, clock: env.clock, config: { enabled: true, ...config } });
  const events: VoiceEvent[] = [];
  voice.on((e) => events.push(e));
  const said = () => events.filter((e) => e.type === 'speak').map((e) => (e as { request: { text: string } }).request.text);
  const hear = async (speaker: string, text: string) => {
    const r = voice.receive({ speaker, text, at: env.clock.now() });
    if (r === 'pass') env.engine.ingest({ speaker, text, at: env.clock.now() });
    await env.engine.drain();
    await new Promise((res) => setImmediate(res));
    voice.tick();
    return r;
  };
  const wait = async (ms: number) => {
    for (let t = 0; t < ms; t += 250) {
      env.clock.advance(250);
      env.engine.tick();
      voice.tick();
      await new Promise((res) => setImmediate(res));
    }
  };
  return { ...env, voice, events, said, hear, wait };
}

test('speaks a gap answer like a teammate, but only after a pause — never over people', async () => {
  const v = withVoice();
  await v.hear('A', 'Does anyone know if Zoom lets apps receive raw meeting audio in real time?');
  assert.equal(v.said().length, 0, 'not while the speaker has just finished');
  // People keep talking: activity every second for 5 s → no speech.
  for (let i = 0; i < 5; i++) {
    await v.wait(1000);
    v.voice.humanActivity();
    v.voice.tick();
  }
  assert.equal(v.said().length, 0, 'never talks over people');
  await v.wait(1750);
  assert.equal(v.said().length, 1);
  assert.match(v.said()[0], /^I can take that one\. Yes — via Realtime Media Streams, for approved apps\.$/);
  assert.ok(v.engine.state.transcript.some((u) => u.speaker === 'ThirdSeat'), 'its words are part of the transcript');
});

test('yields when someone starts talking, and does not repeat itself', async () => {
  const v = withVoice();
  await v.hear('A', 'Does anyone know if Zoom lets apps receive raw meeting audio in real time?');
  await v.wait(2000);
  assert.equal(v.said().length, 1);
  assert.ok(v.voice.isSpeaking());
  await v.wait(500);
  v.voice.humanActivity();
  assert.equal(v.voice.isSpeaking(), false);
  assert.ok(v.events.some((e) => e.type === 'speak-stop'));
  await v.wait(10_000);
  assert.equal(v.said().length, 1, 'interrupted contribution stays on screen, not repeated');
  assert.equal(v.voice.metrics.interrupted, 1);
});

test('ignores its own voice picked up by the microphone', async () => {
  const v = withVoice();
  await v.hear('A', 'Does anyone know if Zoom lets apps receive raw meeting audio in real time?');
  await v.wait(2000);
  const echo = v.said()[0].replace('I can take that one. ', '');
  assert.equal(await v.hear('Room', echo), 'drop');
  assert.equal(v.voice.metrics.echoDropped, 1);
  assert.ok(!v.engine.state.transcript.some((u) => u.speaker === 'Room'), 'echo never reaches the conversation');
});

test('weakly sourced answers are never spoken (screen only)', () => {
  const g = { type: 'KNOWLEDGE', answer: 'Possibly relevant passage', confidence: 'UNVERIFIED' } as Gap;
  assert.equal(speakable(g).ok, false);
  assert.equal(speakable({ ...g, confidence: 'LIKELY' } as Gap).ok, true);
});

test('if the floor never frees up, the moment passes and it stays silent', async () => {
  const v = withVoice();
  await v.hear('A', 'Does anyone know if Zoom lets apps receive raw meeting audio in real time?');
  for (let i = 0; i < 25; i++) {
    await v.wait(1000);
    v.voice.humanActivity();
  }
  await v.wait(3000);
  assert.equal(v.said().length, 0);
  assert.equal(v.voice.metrics.droppedMomentPassed, 1);
});

test('paces unsolicited contributions (cooldown)', async () => {
  const v = withVoice();
  await v.hear('A', 'Does anyone know if Zoom lets apps receive raw meeting audio in real time?');
  await v.wait(2000);
  await v.wait(4000); // finish speaking
  await v.hear('B', 'I think Notion supports webhooks for database changes, so syncing would be easy.');
  await v.wait(3000);
  assert.equal(v.said().length, 1, 'second contribution waits for the cooldown');
  await v.wait(25_000);
  assert.equal(v.said().length, 2);
  assert.match(v.said()[1], /^Quick check on that/);
});

test('addressed by name: answers within its job, deflects everything else', async () => {
  const v = withVoice();
  await v.hear('A', 'Does anyone know if Zoom lets apps receive raw meeting audio in real time?');
  await v.wait(6000);
  assert.equal(await v.hear('B', "ThirdSeat, where's that from?"), 'handled');
  await v.wait(2000);
  assert.match(v.said().at(-1)!, /^That's from Zoom developer docs — RTMS\. The link is on screen\.$/);
  await v.wait(4000);
  await v.hear('A', 'How sure are you, ThirdSeat?');
  await v.wait(2000);
  assert.match(v.said().at(-1)!, /^Pretty sure/);
  await v.wait(4000);
  await v.hear('B', 'ThirdSeat, what do you think we should charge?');
  await v.wait(2000);
  assert.match(v.said().at(-1)!, /^That one's yours/);
  await v.wait(4000);
  const before = v.said().length;
  await v.hear('A', 'Thanks ThirdSeat');
  await v.wait(3000);
  assert.equal(v.said().length, before, '"thanks" needs no reply');
  assert.ok(!v.engine.state.gaps.size || [...v.engine.state.gaps.values()].every((g) => !/charge/.test(g.interpretedQuestion)), 'addressed lines are not analysed as conversation');
});

test('addressed research: acknowledges, looks it up, then says the answer', async () => {
  const v = withVoice();
  await v.hear('A', 'ThirdSeat, does Slack let apps read huddle transcripts?');
  await v.wait(2000);
  assert.equal(v.said()[0], 'Let me check.');
  await v.wait(4000);
  assert.match(v.said()[1], /huddle transcripts are not available to apps/);
  const g = [...v.engine.state.gaps.values()].find((x) => x.reason === 'USER_REQUESTED')!;
  assert.ok(g);
});

test('"that\'s wrong" flags the last answer; "quiet" mutes everything; it can be brought back', async () => {
  const v = withVoice();
  await v.hear('A', 'Does anyone know if Zoom lets apps receive raw meeting audio in real time?');
  await v.wait(6000);
  await v.hear('B', "ThirdSeat, that's wrong, they changed it.");
  await v.wait(2000);
  assert.match(v.said().at(-1)!, /flagged/);
  const g = [...v.engine.state.gaps.values()].find((x) => /Zoom/.test(x.interpretedQuestion))!;
  assert.ok(g.feedback.some((f) => f.flag === 'INCORRECT'));
  await v.wait(4000);
  await v.hear('A', 'ThirdSeat, be quiet for now.');
  const n = v.said().length;
  await v.hear('B', 'Does anyone know if Notion has a public API for comments?');
  await v.hear('A', 'ThirdSeat, what is still open?');
  await v.wait(40_000);
  assert.equal(v.said().length, n, 'muted: says nothing at all');
  await v.hear('A', 'ThirdSeat, you can talk again.');
  await v.wait(2000);
  assert.equal(v.said().at(-1), "I'm back.");
});

test('name used in passing is not addressing it', () => {
  assert.equal(detectAddressed('Our tagline could be your third seat at the table.', ['ThirdSeat', 'Third Seat']), undefined);
  assert.ok(detectAddressed('Hey ThirdSeat, how sure are you?', ['ThirdSeat']));
  assert.ok(detectAddressed('Where is that from, ThirdSeat?', ['ThirdSeat']));
  assert.equal(classifyAddressed('can you check whether Meet add-ons work on mobile').intent, 'RESEARCH');
  assert.equal(classifyAddressed('write a summary email for us').intent, 'OUT_OF_SCOPE');
});

test('voice off: never speaks; addressed lines are ordinary conversation', async () => {
  const v = withVoice({ enabled: false });
  assert.equal(await v.hear('A', 'ThirdSeat, does Slack let apps read huddle transcripts?'), 'pass');
  await v.wait(10_000);
  assert.equal(v.said().length, 0);
});

test('spoken phrasing: no URLs/markers, retroactive and thread wording; LLM rephrasing cannot add facts', async () => {
  assert.equal(forSpeech('See https://x.y/z FIXTURE: Yes “quoted”.'), 'See Yes quoted.');
  const base = { id: 'g', type: 'KNOWLEDGE', reason: 'DEFERRED_FOR_LATER', interpretedQuestion: 'Is RTMS generally available?', answer: 'RTMS is generally available.', confidence: 'HIGH', timingMode: 'RETROACTIVE', evidence: [], timing: { triggerAt: 0, detectedAt: 0 } } as unknown as Gap;
  assert.equal(templateFor(base), 'Going back to the question about RTMS — RTMS is generally available.');
  assert.match(templateFor({ ...base, type: 'OPEN_THREAD', interpretedQuestion: 'Why would a team pay for this?' } as Gap), /^Before we decide — we never settled this: Why would a team pay for this\? Does that change anything\?$/);
  assert.equal(faithful('It costs 4 dollars on Zoom.', 'Zoom pricing is usage-based.'), false, 'invented number');
  assert.equal(faithful('Webex does this too.', 'Zoom supports it.'), false, 'invented product');
  const fake = (speech: string): LlmClient => ({ id: 'f', json: async <T>() => ({ speech }) as T, webSearch: async () => ({ text: '', citations: [], results: [] }) });
  const c1 = new SpeechComposer(fake('Good news — RTMS went GA in 2025 for everyone.'));
  assert.match(await c1.compose(base), /^Going back to/, 'rejected rephrasing → template');
  assert.equal(c1.rejected.length, 1);
  const c2 = new SpeechComposer(fake('Quick follow-up: RTMS is generally available now.'));
  assert.equal(await c2.compose(base), 'Quick follow-up: RTMS is generally available now.');
});

test('server voice (Deepgram TTS) request shape, against a local stand-in', async () => {
  const { createServer } = await import('node:http');
  const { DeepgramTts } = await import('../src/voice/tts.ts');
  let seen: { auth?: string; model?: string | null; body?: string } = {};
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen = { auth: req.headers.authorization, model: new URL(req.url!, 'http://x').searchParams.get('model'), body };
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from([0xff, 0xf3, 0x44]));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const tts = new DeepgramTts({ apiKey: 'k', url: `http://127.0.0.1:${port}/v1/speak` });
  const out = await tts.synthesize('Meet add-ons are desktop-only.');
  srv.close();
  assert.equal(seen.auth, 'Token k');
  assert.equal(seen.model, 'aura-2-thalia-en');
  assert.deepEqual(JSON.parse(seen.body!), { text: 'Meet add-ons are desktop-only.' });
  assert.equal(out.contentType, 'audio/mpeg');
  assert.equal(out.audio.length, 3);
});
