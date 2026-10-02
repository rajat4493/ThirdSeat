import { ManualClock } from '../src/clock.ts';
import { buildEngine } from '../src/app.ts';
import { loadScenarios, replayDeterministic, type Scenario } from '../src/conversation/sources.ts';
import { FixtureResearchTool } from '../src/research/tools/fixture.ts';
import type { Gap, Intervention } from '../src/domain/types.ts';
import { FIXTURES } from './fixtures.ts';

export const T0 = Date.UTC(2026, 9, 2, 10, 0, 0);
let cache: Scenario[] | undefined;

export async function scenario(id: string): Promise<Scenario> {
  cache ??= await loadScenarios(new URL('../scenarios', import.meta.url).pathname);
  const s = cache.find((x) => x.id.startsWith(id));
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

export function setup(sc: Pick<Scenario, 'id' | 'title' | 'objective'>, opts: { gated?: boolean; fixtures?: boolean } = {}) {
  const clock = new ManualClock(T0);
  const fixture = new FixtureResearchTool(opts.fixtures === false ? [] : FIXTURES, { gated: opts.gated });
  const built = buildEngine({
    session: { id: sc.id, createdAt: T0, title: sc.title, config: { objective: sc.objective, sourceUrls: [] } },
    clock,
    extraTools: [fixture],
  });
  const interventions: { intervention: Intervention; gap: Gap }[] = [];
  built.engine.on((e) => {
    if (e.type === 'intervention') interventions.push({ intervention: e.intervention, gap: e.gap });
  });
  const gaps = () => [...built.engine.state.gaps.values()];
  return { clock, fixture, ...built, interventions, gaps };
}

export async function run(id: string, opts: { fixtures?: boolean } = {}) {
  const sc = await scenario(id);
  const env = setup(sc, opts);
  await replayDeterministic(sc, env.clock, env.engine);
  return { sc, ...env };
}
