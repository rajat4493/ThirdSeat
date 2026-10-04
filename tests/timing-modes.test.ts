// Proactive / reactive / retroactive: ThirdSeat chooses when to contribute based on the question and situation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, setup } from './helpers.ts';
import { buildReport } from '../src/metrics/report.ts';

const OBJ = { id: 't', title: 'timing', objective: 'Decide which collaboration platform to integrate with first.' };

test('PROACTIVE: research starts when the question is asked; answer offered once nobody answers (no "not sure" needed)', async () => {
  const env = setup(OBJ);
  env.engine.ingest({ speaker: 'A', text: "Does Slack's API let apps read huddle transcripts?" });
  await env.engine.drain();
  const g = env.gaps().find((x) => x.type === 'KNOWLEDGE')!;
  assert.equal(g.timing.researchStartedAt, g.timing.triggerAt, 'research began at the question, not after a human signal');
  assert.equal(env.interventions.length, 0, 'grace period: give the humans a chance to answer first');

  env.clock.advance(4000);
  env.engine.ingest({ speaker: 'B', text: 'Our users mostly live in Slack anyway.' });
  await env.engine.drain();
  assert.equal(env.interventions.length, 0);
  env.clock.advance(3000);
  env.engine.ingest({ speaker: 'A', text: 'Right, and the onboarding there is simple.' });
  await env.engine.drain();
  assert.equal(env.interventions.length, 1);
  assert.equal(g.timingMode, 'PROACTIVE');
  assert.match(env.interventions[0].intervention.text, /^Looked this up while you were talking/);
  assert.equal(g.timing.surfacedAt! - g.timing.triggerAt, 7000);
});

test('PROACTIVE: a question asked to the room is answered as soon as the answer is ready', async () => {
  const env = setup(OBJ);
  env.engine.ingest({ speaker: 'A', text: 'Does anyone know if Zoom lets apps receive raw meeting audio in real time?' });
  await env.engine.drain();
  assert.equal(env.interventions.length, 1);
  assert.equal(env.interventions[0].gap.timingMode, 'PROACTIVE');
  assert.match(env.interventions[0].intervention.text, /You asked the room/);
  assert.equal(env.interventions[0].gap.timing.surfacedAt! - env.interventions[0].gap.timing.triggerAt, 0);
});

test('PROACTIVE: a tentative factual claim is checked without anyone asking', async () => {
  const env = setup(OBJ);
  env.engine.ingest({ speaker: 'B', text: 'I think Notion supports webhooks for database changes, so syncing would be easy.' });
  await env.engine.drain();
  assert.equal(env.interventions.length, 1);
  const g = env.interventions[0].gap;
  assert.equal(g.timingMode, 'PROACTIVE');
  assert.match(g.interpretedQuestion, /^Is it true that Notion supports webhooks/);
  assert.match(env.interventions[0].intervention.text, /^Checked the assumption/);
});

test('no proactive card when a human answers within the grace period', async () => {
  const env = setup(OBJ);
  env.engine.ingest({ speaker: 'A', text: "Does Slack's API let apps read huddle transcripts?" });
  env.clock.advance(3000);
  env.engine.ingest({ speaker: 'B', text: "No, huddle transcripts aren't exposed to apps, we checked last quarter." });
  await env.engine.drain();
  env.clock.advance(30_000);
  env.engine.tick();
  assert.equal(env.interventions.length, 0);
  assert.equal(env.gaps().find((x) => x.type === 'KNOWLEDGE')?.status, 'NATURALLY_RESOLVED');
});

test('hedged replies to a question are not mistaken for new claims', async () => {
  const env = setup(OBJ);
  env.engine.ingest({ speaker: 'A', text: 'Can Teams actually give an external product access to live transcript data?' });
  env.engine.ingest({ speaker: 'B', text: 'I think Teams supports that.' });
  await env.engine.drain();
  assert.equal(env.gaps().filter((g) => g.type === 'KNOWLEDGE').length, 1);
  assert.equal(env.gaps()[0].reason, 'LOW_CONFIDENCE_HUMAN_RESPONSE');
  assert.equal(env.gaps()[0].timingMode, 'REACTIVE');
});

test('REACTIVE: "not sure" gets the answer immediately because it was prepared in advance', async () => {
  const env = setup(OBJ, { gated: true });
  env.engine.ingest({ speaker: 'A', text: 'Does BigQuery support row-level security?' });
  await env.engine.analysed();
  env.clock.advance(1500);
  env.fixture.release(); // research finishes before anyone replies
  await env.engine.drain();
  assert.equal(env.interventions.length, 0);
  env.clock.advance(1500);
  env.engine.ingest({ speaker: 'B', text: "I'm not sure." });
  await env.engine.drain();
  assert.equal(env.interventions.length, 1);
  const g = env.interventions[0].gap;
  assert.equal(g.timingMode, 'REACTIVE');
  assert.equal(g.timing.surfacedAt! - g.timing.triggerAt, 3000, 'surfaced the moment uncertainty was voiced');
  assert.ok(g.timing.answeredAt! < g.timing.qualifiedAt!, 'answer existed before the gap qualified');
});

test('RETROACTIVE: an answer that arrives after the conversation moved on is framed as returning to it', async () => {
  const env = setup(OBJ, { gated: true });
  env.engine.ingest({ speaker: 'A', text: 'What is the maximum row size in Amazon Redshift?' });
  env.clock.advance(3000);
  env.engine.ingest({ speaker: 'B', text: "Let's check that after the meeting." });
  await env.engine.analysed();
  const lines = ['The dashboards need to load in under two seconds.', 'We could cache the heavy queries overnight.', 'Caching also cuts the cloud bill.', 'Then the pricing page can promise fast dashboards.'];
  for (const t of lines) {
    env.clock.advance(30_000);
    env.engine.ingest({ speaker: 'A', text: t });
    await env.engine.analysed();
  }
  env.fixture.release();
  await env.engine.drain();
  assert.equal(env.interventions.length, 1);
  assert.equal(env.interventions[0].gap.timingMode, 'RETROACTIVE');
  assert.match(env.interventions[0].intervention.text, /^Back to “What is the maximum row size in Amazon Redshift\?” \(raised 2 min ago\)/);
});

test('scenario s11 exercises all three modes and the report counts them', async () => {
  const { engine, interventions } = await run('s11');
  const modes = interventions.map((i) => i.gap.timingMode);
  assert.ok(modes.includes('PROACTIVE'));
  assert.ok(modes.includes('RETROACTIVE'));
  const r = buildReport(engine, { analyzer: 'heuristic', tools: [], now: Date.now() });
  assert.equal(r.timing.PROACTIVE.surfaced + r.timing.REACTIVE.surfaced + r.timing.RETROACTIVE.surfaced, r.metrics.interventionsSurfaced);
  assert.ok(r.timing.PROACTIVE.surfaced >= 3);
});
