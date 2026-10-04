// The 10 required scenarios (AGENT_SPEC §6). Research uses deterministic fixtures here; real retrieval
// is exercised by tests/supplied-sources.test.ts (local docs) and scripts/e2e-real-research.ts (network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, scenario, setup } from './helpers.ts';

test('S1 explicit factual question + uncertainty → gap detected → research → evidence-backed answer', async () => {
  const { gaps, interventions } = await run('s01');
  const g = gaps().find((x) => x.type === 'KNOWLEDGE');
  assert.ok(g, 'knowledge gap detected');
  assert.equal(g.reason, 'EXPLICIT_UNANSWERED_QUESTION');
  assert.equal(g.status, 'RESOLVED');
  assert.equal(g.confidence, 'HIGH');
  assert.ok(g.evidence.length > 0 && g.evidence[0].url, 'evidence with a source is preserved');
  assert.equal(interventions.length, 1);
  assert.equal(interventions[0].gap.id, g.id);
  // Latency is recorded at every stage.
  for (const k of ['triggerAt', 'detectedAt', 'qualifiedAt', 'researchStartedAt', 'firstEvidenceAt', 'answeredAt', 'surfacedAt'] as const) {
    assert.ok(typeof g.timing[k] === 'number', `timing.${k} recorded`);
  }
  assert.equal(g.timing.surfacedAt! - g.timing.triggerAt, 5000, 'TTI measured from the question');
  assert.ok(g.decisionLog.every((d) => d.note.length < 400), 'concise decision reasons only');
});

test('S2 question answered confidently by another human → no intervention (advance research discarded)', async () => {
  const { gaps, interventions, fixture } = await run('s02');
  assert.equal(interventions.length, 0);
  assert.equal(fixture.calls.length, 1, 'researched ahead of time (proactive)…');
  const g = gaps().find((x) => x.type === 'KNOWLEDGE');
  assert.equal(g?.status, 'NATURALLY_RESOLVED');
  assert.equal(g?.reason, 'QUESTION_RAISED');
  assert.equal(g?.timing.surfacedAt, undefined, '…but never shown, because a human answered');
  assert.ok(g?.decisionLog.some((d) => /advance research (discarded|cancelled)/.test(d.note)));
});

test('S3 weak human answer ("I think so") → verification opportunity', async () => {
  const { gaps, interventions } = await run('s03');
  const g = gaps().find((x) => x.type === 'KNOWLEDGE')!;
  assert.equal(g.reason, 'LOW_CONFIDENCE_HUMAN_RESPONSE');
  assert.equal(g.status, 'RESOLVED');
  assert.equal(interventions.length, 1);
});

test('S4 deferred question → high-priority gap, framed as avoided follow-up', async () => {
  const { gaps, interventions, engine } = await run('s04');
  const g = gaps().find((x) => x.type === 'KNOWLEDGE' && x.reason !== 'QUESTION_RAISED')!;
  assert.equal(g.reason, 'DEFERRED_FOR_LATER');
  assert.ok(g.priority >= 0.75, `priority ${g.priority}`);
  assert.match(interventions[0].intervention.text, /follow-up/);
  // "What about the onboarding flow?" proposes a topic; it must not become a gap.
  assert.equal(gaps().filter((x) => /onboarding/i.test(x.interpretedQuestion)).length, 0);
  assert.equal(engine.state.interventions.length, 1);
});

test('S5 important question abandoned after topic change → tracked, not surfaced early, recovered at decision point', async () => {
  const sc = await scenario('s05');
  const env = setup(sc);
  const { replayDeterministic } = await import('../src/conversation/sources.ts');
  const surfacedAtLine: number[] = [];
  await replayDeterministic(sc, env.clock, env.engine, {
    afterLine: (i) => {
      if (env.interventions.length > surfacedAtLine.length) surfacedAtLine.push(i);
    },
  });
  const thread = env.gaps().find((x) => x.type === 'OPEN_THREAD')!;
  assert.ok(thread, 'open thread tracked');
  assert.equal(thread.reason, 'IMPORTANT_OPEN_THREAD');
  assert.equal(env.interventions.length, 1);
  assert.equal(env.interventions[0].gap.id, thread.id);
  // Surfaced only when the group started deciding (pricing / MVP line), not right after it was raised.
  const decideLine = sc.lines.findIndex((l) => /charge/.test(l.text));
  assert.equal(surfacedAtLine[0], decideLine);
  assert.match(env.interventions[0].intervention.text, /Copilot/);
});

test('S6 sustained drift with unresolved objective items → one lightweight drift intervention', async () => {
  const { gaps, interventions } = await run('s06');
  const drift = interventions.filter((i) => i.gap.type === 'DRIFT');
  assert.equal(drift.length, 1);
  assert.match(drift[0].intervention.text, /logo|palette|chair/);
  assert.match(drift[0].intervention.text, /Copilot/, 'names what is still unresolved');
  // Short creative tangents are not policed: no drift before 3 minutes of tangent.
  assert.ok(drift[0].gap.timing.surfacedAt! - drift[0].gap.timing.triggerAt >= 180_000);
  assert.equal(gaps().filter((g) => g.type === 'DRIFT').length, 1);
});

test('S7 research finds nothing → UNRESOLVED, no fabricated answer, no interruption', async () => {
  const { gaps, interventions, fixture } = await run('s07');
  const g = gaps().find((x) => x.type === 'KNOWLEDGE')!;
  assert.equal(fixture.calls.length, 1, 'research was attempted');
  assert.equal(g.status, 'UNRESOLVED');
  assert.equal(g.answer, undefined);
  assert.equal(g.confidence, 'UNVERIFIED');
  assert.match(g.caveat ?? '', /couldn't verify/i);
  assert.equal(interventions.length, 0);
});

test('S8 multiple simultaneous gaps → prioritised and paced', async () => {
  const { gaps, interventions, engine } = await run('s08');
  const k = gaps().filter((x) => x.type === 'KNOWLEDGE');
  assert.equal(k.length, 3);
  const deferred = k.find((x) => x.reason === 'DEFERRED_FOR_LATER')!;
  const snowflake = k.find((x) => /Snowflake/.test(x.interpretedQuestion))!;
  assert.ok(deferred.priority > snowflake.priority);
  // Snowflake was ready first, but the deferred question was surfaced before it.
  assert.ok(snowflake.timing.answeredAt! < deferred.timing.answeredAt!);
  assert.ok(deferred.timing.surfacedAt! < snowflake.timing.surfacedAt!);
  // Cooldown between interruptions is respected.
  const times = interventions.map((i) => i.intervention.surfacedAt).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= engine.policy.cfg.cooldownMs);
});

test('S9 humans resolve the gap while research runs → research cancelled, intervention suppressed', async () => {
  const sc = await scenario('s09');
  const env = setup(sc, { gated: true });
  const [q, unsure, answer] = sc.lines;
  env.engine.ingest({ speaker: q.s, text: q.text });
  await env.engine.analysed();
  env.clock.advance(5000);
  env.engine.ingest({ speaker: unsure.s, text: unsure.text });
  await env.engine.analysed();
  await new Promise((r) => setImmediate(r));
  assert.equal(env.engine.researching, 1, 'research in flight');
  const g = env.gaps().find((x) => x.type === 'KNOWLEDGE')!;
  assert.equal(g.status, 'RESEARCHING');

  env.clock.advance(4000);
  env.engine.ingest({ speaker: answer.s, text: answer.text });
  await env.engine.analysed();
  env.fixture.release();
  await env.engine.drain();
  assert.equal(env.fixture.aborted, 1, 'research cancelled');
  assert.equal(g.status, 'NATURALLY_RESOLVED');
  assert.equal(env.interventions.length, 0);
  assert.ok(g.decisionLog.some((d) => /research cancelled/.test(d.note)));
  assert.ok(env.engine.state.facts.some((f) => /FCM/.test(f.text)), "humans' answer becomes established context");
});

test('S10 conclusion signal with open blockers → remaining blockers, not a summary', async () => {
  const { interventions } = await run('s10');
  assert.equal(interventions.length, 1);
  const c = interventions[0];
  assert.equal(c.gap.type, 'DECISION');
  assert.equal(c.gap.reason, 'CONCLUSION_WITH_OPEN_BLOCKERS');
  assert.match(c.intervention.text, /pay/);
  assert.match(c.intervention.text, /Copilot/);
  assert.doesNotMatch(c.intervention.text, /Zoom/, 'answered questions are not repeated as blockers');
  assert.match(c.intervention.text, /1 other question\(s\) raised were answered/);
});

test('reasoning gap (feasibility → commitment) is conservative and only surfaces in the moment', async () => {
  const sc = { id: 'r1', title: 'reasoning', objective: 'Decide whether this idea deserves validation.' };
  const env = setup(sc);
  env.engine.ingest({ speaker: 'A', text: 'We looked at the APIs and this is technically possible.' });
  env.clock.advance(5000);
  env.engine.ingest({ speaker: 'B', text: 'Then we should build it.' });
  await env.engine.drain();
  assert.equal(env.interventions.length, 1);
  assert.equal(env.interventions[0].gap.type, 'REASONING');
  // No objective → nothing to reason against → silent.
  const env2 = setup({ id: 'r2', title: 'no objective', objective: undefined });
  env2.engine.ingest({ speaker: 'A', text: 'This is technically possible.' });
  env2.engine.ingest({ speaker: 'B', text: 'Then we should build it.' });
  await env2.engine.drain();
  assert.equal(env2.interventions.length, 0);
});

test('no objective → no drift detection (nothing to drift from)', async () => {
  const sc = { ...(await scenario('s06')), objective: undefined };
  const env = setup(sc);
  const { replayDeterministic } = await import('../src/conversation/sources.ts');
  await replayDeterministic(sc, env.clock, env.engine);
  assert.equal(env.gaps().filter((g) => g.type === 'DRIFT').length, 0);
});
