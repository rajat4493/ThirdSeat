// Rigorous scored run of a scenario (default scenarios/x01-three-modes-rigorous.json) against its pre-written answer key.
// Research results are simulated (marked FIXTURE) so the test isolates *timing and judgement*; two
// lookups are deliberately slow (held until a given line) to test late answers and cancellation.
// Usage: node scripts/rigorous-three-modes.ts [scenarios/<file>.json] [--ai] [--json out.json]

import { readFile, writeFile } from 'node:fs/promises';
import { ManualClock } from '../src/clock.ts';
import { buildEngine } from '../src/app.ts';
import { newId } from '../src/domain/ids.ts';
import { coverage, termSet } from '../src/domain/text.ts';
import type { Confidence, Gap, Intervention } from '../src/domain/types.ts';
import type { ResearchRequest, ResearchTool, ToolResult } from '../src/research/types.ts';
import { aiFromArgs, aiRunValidity } from './ai-mode.ts';

const llm = aiFromArgs(process.argv);

interface Entry { key: string; match: string[]; answer: string; confidence: Confidence; hold?: boolean }

class SimulatedSearch implements ResearchTool {
  readonly id = 'simulated_search';
  readonly description = 'Simulated search results (test only)';
  calls: { key: string | null; query: string }[] = [];
  cancelled: string[] = [];
  private held = new Map<string, (() => void)[]>();
  private entries: Entry[];
  constructor(entries: Entry[]) {
    this.entries = entries;
  }
  canHandle(g: Gap) {
    return g.type === 'KNOWLEDGE' && g.researchable;
  }
  release(key: string) {
    for (const f of this.held.get(key) ?? []) f();
    this.held.delete(key);
  }
  releaseAll() {
    for (const k of [...this.held.keys()]) this.release(k);
  }
  async research(req: ResearchRequest): Promise<ToolResult> {
    const q = termSet(req.query);
    const hit = this.entries.find((e) => coverage(termSet(e.match.join(' ')), q) === 1);
    this.calls.push({ key: hit?.key ?? null, query: req.query });
    if (!hit) return { evidence: [] };
    if (hit.hold) {
      await new Promise<void>((resolve, reject) => {
        this.held.set(hit.key, [...(this.held.get(hit.key) ?? []), resolve]);
        req.signal.addEventListener('abort', () => {
          this.cancelled.push(hit.key);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    const id = newId('ev');
    return {
      evidence: [{ id, toolId: this.id, sourceTier: 'official_docs', title: `Docs: ${hit.key}`, url: `https://docs.example/${hit.key}`, excerpt: hit.answer, score: 0.9, retrievedAt: 0 }],
      draft: { answer: hit.answer, confidence: hit.confidence, citedEvidenceIds: [id] },
    };
  }
}

const file = process.argv.find((a) => a.endsWith('.json') && !a.startsWith('--') && process.argv[process.argv.indexOf(a) - 1] !== '--json') ?? 'scenarios/x01-three-modes-rigorous.json';
const sc = JSON.parse(await readFile(file, 'utf8'));
const SIM = sc.simulatedSearch as { entries: Entry[]; releaseBeforeLine?: Record<string, string>; releaseAfterLine?: Record<string, string>; cancelledKey?: string };
const RELEASE_BEFORE_LINE: Record<number, string> = SIM.releaseBeforeLine ?? {};
const RELEASE_AFTER_LINE: Record<number, string> = SIM.releaseAfterLine ?? {};
const clock = new ManualClock(Date.UTC(2026, 9, 4, 10, 0, 0));
const t0 = clock.now();
const search = new SimulatedSearch(SIM.entries);
// --ai: Claude understands the conversation and writes answers; web search stays off so evidence is identical to the no-AI run.
const { engine, analyzerId } = buildEngine({ session: { id: sc.id, createdAt: t0, title: sc.title, config: { objective: sc.objective, sourceUrls: [] } }, clock, extraTools: [search], llm, webSearch: false });

const cards: { line: number; intervention: Intervention; gap: Gap }[] = [];
let currentLine = -1;
engine.on((e) => {
  if (e.type === 'intervention') cards.push({ line: currentLine, intervention: e.intervention, gap: e.gap });
});
const settle = async () => {
  await engine.analysed();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  engine.tick();
};

for (let i = 0; i < sc.lines.length; i++) {
  const line = sc.lines[i];
  if (RELEASE_BEFORE_LINE[i]) {
    search.release(RELEASE_BEFORE_LINE[i]);
    await settle();
  }
  const target = t0 + line.t * 1000;
  while (clock.now() + 1000 <= target) {
    clock.advance(1000);
    engine.tick();
  }
  clock.set(Math.max(clock.now(), target));
  currentLine = i;
  engine.ingest({ speaker: line.s, text: line.text, at: clock.now() });
  await settle();
  if (RELEASE_AFTER_LINE[i]) {
    search.release(RELEASE_AFTER_LINE[i]);
    await settle();
  }
}
for (let s = 0; s < 30; s++) {
  clock.advance(1000);
  engine.tick();
}
search.releaseAll();
await engine.drain();

// ── scoring ──
const uttId = (i: number) => engine.state.transcript.filter((u) => !u.speaker.includes('→'))[i]?.id;
const gapsFor = (i: number) => [...engine.state.gaps.values()].filter((g) => g.triggerUtteranceId === uttId(i) && !g.speculative);
const rows: { id: string; expected: string; actual: string; pass: boolean; why: string }[] = [];
const matched = new Set<string>();

for (const k of sc.answerKey.mustSurface) {
  const c = cards.find((x) => !matched.has(x.gap.id) && x.gap.type === k.type && (k.type === 'DECISION' || x.gap.triggerUtteranceId === uttId(k.trigger)));
  if (c) matched.add(c.gap.id);
  const okType = !!c;
  const okMode = c?.gap.timingMode === k.mode;
  const okWhen = !!c && c.line >= k.window[0] && c.line <= k.window[1];
  rows.push({
    id: k.id,
    expected: `${k.type} card, ${k.mode}, at line ${k.window[0]}–${k.window[1]}`,
    actual: c ? `${c.gap.type} card, ${c.gap.timingMode}, at line ${c.line} (+${((c.intervention.surfacedAt - (engine.state.utterance(uttId(k.trigger)!)?.at ?? 0)) / 1000).toFixed(0)} s)` : `no card${gapsFor(k.trigger).length ? ` (gap: ${gapsFor(k.trigger).map((g) => `${g.type}/${g.status}/${g.reason}`).join(', ')})` : ' (no gap)'}`,
    pass: okType && okMode && okWhen,
    why: k.why,
  });
}
for (const k of sc.answerKey.mustNotSurface) {
  const gs = gapsFor(k.trigger);
  const surfaced = gs.filter((g) => g.timing.surfacedAt);
  let pass = surfaced.length === 0;
  const notes: string[] = [];
  if (k.expectNoGap && gs.length) {
    pass = false;
    notes.push('unexpected gap');
  }
  if (k.expectStatus && !gs.some((g) => g.status === k.expectStatus)) {
    pass = false;
    notes.push(`expected status ${k.expectStatus}`);
  }
  if (k.expectResearchable === false && gs.some((g) => g.researchable)) {
    pass = false;
    notes.push('was treated as publicly researchable');
  }
  if (k.expectResearchCancelled && !search.cancelled.includes(SIM.cancelledKey ?? '')) {
    pass = false;
    notes.push('research not cancelled');
  }
  rows.push({
    id: k.id,
    expected: k.expectNoGap ? 'no gap, no card' : `no card; status ${k.expectStatus}${k.expectResearchCancelled ? '; research cancelled' : ''}`,
    actual: `${surfaced.length ? 'CARD SHOWN; ' : 'no card; '}${gs.length ? gs.map((g) => `${g.type}/${g.status}`).join(', ') : 'no gap'}${notes.length ? ` — ${notes.join('; ')}` : ''}`,
    pass,
    why: k.why,
  });
}
const extra = cards.filter((c) => !matched.has(c.gap.id));
if (sc.answerKey.noOtherCards) {
  rows.push({
    id: 'X',
    expected: 'no other cards',
    actual: extra.length ? extra.map((c) => `${c.gap.type}/${c.gap.timingMode} at line ${c.line}: “${c.gap.interpretedQuestion}”`).join(' | ') : 'none',
    pass: extra.length === 0,
    why: 'Precision: anything not in the key is a false positive.',
  });
}

const passCount = rows.filter((r) => r.pass).length;
console.log(`\n${sc.title}\nobjective: ${sc.objective}\nanalyzer: ${analyzerId}\n`);
console.log('Timeline of cards:');
for (const c of cards) console.log(`  line ${String(c.line).padStart(2)} [${c.gap.timingMode}] ${c.gap.type}: ${c.intervention.text.replace(/\n/g, ' / ').slice(0, 150)}`);
console.log('\nScore:');
for (const r of rows) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(3)} expected: ${r.expected}\n             actual:   ${r.actual}`);
console.log(`\n${passCount}/${rows.length} checks passed. Cards shown: ${cards.length}. Research calls: ${search.calls.length} (${search.calls.filter((c) => !c.key).length} with no result).`);
const validity = llm ? aiRunValidity(engine.log, llm) : { valid: true };
if (llm) {
  console.log(`AI: ${JSON.stringify(llm.summary())}`);
  if (!validity.valid) console.log(`INVALID AI RUN — score not attributable to AI: ${validity.reason}`);
}

const out = process.argv.indexOf('--json');
if (out > 0) await writeFile(process.argv[out + 1], JSON.stringify({ ranAt: new Date().toISOString(), analyzer: analyzerId, ai: llm ? { ...llm.summary(), ...validity } : null, passCount, total: rows.length, rows, cards: cards.map((c) => ({ line: c.line, type: c.gap.type, mode: c.gap.timingMode, text: c.intervention.text })), researchCalls: search.calls }, null, 2));
process.exit(passCount === rows.length && validity.valid ? 0 : 1);
