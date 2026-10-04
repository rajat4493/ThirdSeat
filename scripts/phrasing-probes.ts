// Measures how robustly ThirdSeat reads natural phrasings (pre-registered in scenarios/x02-phrasing-probes.json).
// Each probe runs in a fresh session; a simulated search answers any researchable question, so only judgement is measured.
// Usage: node scripts/phrasing-probes.ts [--json out.json]

import { readFile, writeFile } from 'node:fs/promises';
import { ManualClock } from '../src/clock.ts';
import { buildEngine } from '../src/app.ts';
import { newId } from '../src/domain/ids.ts';
import type { Gap, TimingMode } from '../src/domain/types.ts';
import type { ResearchTool, ToolResult } from '../src/research/types.ts';

const anyAnswer: ResearchTool = {
  id: 'simulated_any',
  description: 'answers anything (test only)',
  canHandle: (g: Gap) => g.type === 'KNOWLEDGE' && g.researchable,
  async research(): Promise<ToolResult> {
    const id = newId('ev');
    return { evidence: [{ id, toolId: 'simulated_any', sourceTier: 'official_docs', title: 'Docs', url: 'https://docs.example', excerpt: 'FIXTURE', score: 0.9, retrievedAt: 0 }], draft: { answer: 'FIXTURE answer.', confidence: 'HIGH', citedEvidenceIds: [id] } };
  },
};

function fresh() {
  const clock = new ManualClock(1_800_000_000_000);
  const { engine } = buildEngine({ session: { id: 'p', createdAt: clock.now(), title: 'probe', config: { objective: 'Decide which meeting platform to build on first.', sourceUrls: [] } }, clock, extraTools: [anyAnswer] });
  const cards: { mode?: TimingMode; at: number }[] = [];
  engine.on((e) => e.type === 'intervention' && cards.push({ mode: e.gap.timingMode, at: e.intervention.surfacedAt }));
  return { clock, engine, cards };
}

async function probeReply(question: string, reply: string): Promise<string> {
  const { clock, engine, cards } = fresh();
  engine.ingest({ speaker: 'A', text: question });
  await engine.drain();
  clock.advance(4000);
  engine.ingest({ speaker: 'B', text: reply });
  await engine.drain();
  const immediate = cards[0]?.mode;
  for (let s = 0; s < 30; s++) {
    clock.advance(1000);
    engine.tick();
  }
  await engine.drain();
  if (immediate) return immediate; // card right after the reply
  return cards[0] ? `${cards[0].mode} (later)` : 'NONE';
}

async function probeStatement(text: string): Promise<string> {
  const { clock, engine, cards } = fresh();
  engine.ingest({ speaker: 'B', text });
  await engine.drain();
  for (let s = 0; s < 30; s++) {
    clock.advance(1000);
    engine.tick();
  }
  await engine.drain();
  return cards[0]?.mode ?? 'NONE';
}

const P = JSON.parse(await readFile(new URL('../scenarios/x02-phrasing-probes.json', import.meta.url), 'utf8'));
const results: { category: string; split: string; text: string; expected: string; actual: string; pass: boolean }[] = [];
for (const [cat, spec] of Object.entries(P.replies) as [string, { expectMode: string; dev: string[]; heldout: string[] }][]) {
  for (const split of ['dev', 'heldout'] as const)
    for (const text of spec[split]) {
      const actual = await probeReply(P.question, text);
      results.push({ category: cat, split, text, expected: spec.expectMode, actual, pass: actual === spec.expectMode });
    }
}
for (const [cat, spec] of [['CLAIM', P.claims], ['NON_CLAIM', P.nonClaims]] as [string, { expectMode: string; dev: string[]; heldout: string[] }][]) {
  for (const split of ['dev', 'heldout'] as const)
    for (const text of spec[split]) {
      const actual = await probeStatement(text);
      results.push({ category: cat, split, text, expected: spec.expectMode, actual, pass: actual === spec.expectMode });
    }
}

const cats = [...new Set(results.map((r) => r.category))];
console.log('category      split     correct');
for (const c of cats)
  for (const s of ['dev', 'heldout']) {
    const rs = results.filter((r) => r.category === c && r.split === s);
    console.log(`${c.padEnd(13)} ${s.padEnd(9)} ${rs.filter((r) => r.pass).length}/${rs.length}`);
  }
for (const s of ['dev', 'heldout']) {
  const rs = results.filter((r) => r.split === s);
  console.log(`TOTAL         ${s.padEnd(9)} ${rs.filter((r) => r.pass).length}/${rs.length}`);
}
console.log('\nMisses:');
for (const r of results.filter((x) => !x.pass)) console.log(`  [${r.split}] ${r.category}: “${r.text}” → ${r.actual} (expected ${r.expected})`);
const out = process.argv.indexOf('--json');
if (out > 0) await writeFile(process.argv[out + 1], JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
