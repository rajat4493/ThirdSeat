// Replays a scenario deterministically and prints what ThirdSeat noticed, did and surfaced.
// Usage: node scripts/run-scenario.ts <scenario-id|all> [--fixtures] [--real-sources]
//   --fixtures      use deterministic test fixtures for research (clearly fake)
//   --real-sources  research only in the scenario's sourceUrls (real network fetch)

import { ManualClock } from '../src/clock.ts';
import { buildEngine } from '../src/app.ts';
import { loadScenarios, replayDeterministic } from '../src/conversation/sources.ts';
import { FixtureResearchTool } from '../src/research/tools/fixture.ts';
import { buildReport } from '../src/metrics/report.ts';
import { FIXTURES } from '../tests/fixtures.ts';

const [, , which = 'all', ...flags] = process.argv;
const scenarios = (await loadScenarios(new URL('../scenarios', import.meta.url).pathname)).filter((s) => which === 'all' || s.id.startsWith(which));
if (scenarios.length === 0) {
  console.error(`no scenario matches "${which}"`);
  process.exit(1);
}

for (const sc of scenarios) {
  const clock = new ManualClock(Date.UTC(2026, 9, 2, 10, 0, 0));
  const t0 = clock.now();
  const useFixtures = flags.includes('--fixtures');
  const { engine, analyzerId, tools } = buildEngine({
    session: { id: sc.id, createdAt: t0, title: sc.title, config: { objective: sc.objective, sourceUrls: flags.includes('--real-sources') ? sc.sourceUrls ?? [] : [] } },
    clock,
    extraTools: useFixtures ? [new FixtureResearchTool(FIXTURES)] : [],
  });
  const ts = (t: number) => `${String(Math.floor((t - t0) / 60000)).padStart(2, '0')}:${String(Math.floor(((t - t0) % 60000) / 1000)).padStart(2, '0')}`;
  console.log(`\n━━━ ${sc.id}: ${sc.title}`);
  console.log(`objective: ${sc.objective ?? '(none)'} | analyzer: ${analyzerId} | tools: ${tools.map((t) => t.id).join(', ')}`);
  engine.on((e) => {
    if (e.type === 'utterance') console.log(`  ${ts(e.utterance.at)}  ${e.utterance.speaker}: ${e.utterance.text}`);
    if (e.type === 'log') console.log(`  ${ts(e.at)}      · ${e.message}`);
    if (e.type === 'intervention') console.log(`  ${ts(e.intervention.surfacedAt)}  ▶ [${e.gap.type}${e.gap.confidence ? ' / ' + e.gap.confidence : ''}] ${e.intervention.text.replace(/\n/g, '\n               ')}`);
  });
  await replayDeterministic(sc, clock, engine);
  const r = buildReport(engine, { analyzer: analyzerId, tools: tools.map((t) => t.id), now: clock.now() });
  const m = r.metrics;
  console.log(`  ── gaps: ${r.gaps.filter((g) => g.reason !== 'QUESTION_RAISED').map((g) => `${g.type}:${g.status}`).join(', ') || 'none'}`);
  console.log(`  ── surfaced ${m.interventionsSurfaced}, naturally resolved ${m.naturallyResolved}, TTI median ${r.latency.timeToUsefulIntervention.medianMs ?? '-'} ms`);
}
