// End-to-end proof run with REAL external retrieval (no fixtures, no hard-coded answers):
//   conversation → gap detection → research (live HTTP fetch of official docs) → evidence → answer → surfaced intervention
// Writes a verifiable record to docs/evidence/e2e-real-research.json, including a check that every quoted
// excerpt really occurs in the document fetched from the network.
//
// Without an LLM: heuristic analysis + supplied official docs + extractive (UNVERIFIED) answers.
// With THIRDSEAT_LLM=anthropic (and credentials): LLM analysis, LLM synthesis, and Claude web search.

import { writeFile, mkdir } from 'node:fs/promises';
import { realClock } from '../src/clock.ts';
import { buildEngine } from '../src/app.ts';
import { loadScenarios } from '../src/conversation/sources.ts';
import { fetchDoc } from '../src/research/tools/supplied-sources.ts';
import { buildReport } from '../src/metrics/report.ts';
import { AnthropicLlmClient } from '../src/llm/anthropic-client.ts';

const sc = (await loadScenarios(new URL('../scenarios', import.meta.url).pathname)).find((s) => s.id === 'w01-whiteboard-rehearsal')!;
const llm = process.env.THIRDSEAT_LLM === 'anthropic' ? new AnthropicLlmClient() : undefined;
const session = { id: 'e2e', createdAt: Date.now(), title: sc.title, config: { objective: sc.objective, sourceUrls: sc.sourceUrls ?? [] } };
const { engine, analyzerId, tools, supplied } = buildEngine({ session, clock: realClock, llm });

// Compress the script's timing 20× so the run takes ~11 s of real time, with real async research.
const SPEED = Number(process.env.SPEED ?? 20);
const timeline: string[] = [];
const t0 = Date.now();
engine.on((e) => {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  if (e.type === 'utterance') timeline.push(`${t}s  ${e.utterance.speaker}: ${e.utterance.text}`);
  if (e.type === 'log') timeline.push(`${t}s    · ${e.message}`);
  if (e.type === 'intervention') timeline.push(`${t}s  ▶ ${e.intervention.text}`);
});
const ticker = setInterval(() => engine.tick(), 250);
await supplied?.warm();
const warmMs = Date.now() - t0;
for (const line of sc.lines) {
  const due = t0 + warmMs + (line.t * 1000) / SPEED;
  await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
  engine.ingest({ speaker: line.s, text: line.text });
}
await engine.drain();
await new Promise((r) => setTimeout(r, 1500));
engine.tick();
clearInterval(ticker);

// Verify evidence against the live documents (re-fetched independently).
const docs = new Map<string, string>();
for (const url of sc.sourceUrls ?? []) docs.set(url, (await fetchDoc(url)).text.replace(/\s+/g, ' '));
const norm = (s: string) => s.replace(/[“”…]/g, '').replace(/\s+/g, ' ').trim();
const gaps = [...engine.state.gaps.values()].filter((g) => g.type === 'KNOWLEDGE');
const verification = gaps.flatMap((g) =>
  g.evidence.map((e) => {
    const doc = e.url ? docs.get(e.url) : undefined;
    const probe = norm(e.excerpt).slice(0, 120);
    return { gap: g.interpretedQuestion, url: e.url, tier: e.sourceTier, excerptFoundInLiveDocument: doc ? norm(doc).includes(probe) : null, toolId: e.toolId };
  }),
);

const record = {
  ranAt: new Date().toISOString(),
  analyzer: analyzerId,
  tools: tools.map((t) => t.id),
  llm: llm?.id ?? null,
  sourceLoadErrors: supplied?.loadErrors ?? [],
  sourcesFetchedMs: warmMs,
  timeline,
  knowledgeGaps: gaps.map((g) => ({
    question: g.interpretedQuestion,
    reason: g.reason,
    status: g.status,
    confidence: g.confidence,
    answer: g.answer,
    caveat: g.caveat,
    evidence: g.evidence.map((e) => ({ title: e.title, url: e.url, tier: e.sourceTier, score: e.score, excerpt: e.excerpt })),
    latencyMs: {
      triggerToQualified: g.timing.qualifiedAt! - g.timing.triggerAt,
      researchDuration: g.researchDurationMs,
      researchStartToFirstEvidence: g.timing.firstEvidenceAt && g.timing.researchStartedAt ? g.timing.firstEvidenceAt - g.timing.researchStartedAt : null,
      timeToIntervention: g.timing.surfacedAt ? g.timing.surfacedAt - g.timing.triggerAt : null,
    },
    decisionLog: g.decisionLog.map((d) => d.note),
  })),
  evidenceVerification: verification,
  report: buildReport(engine, { analyzer: analyzerId, tools: tools.map((t) => t.id), now: Date.now() }).metrics,
};
await mkdir(new URL('../docs/evidence', import.meta.url), { recursive: true });
const out = new URL(`../docs/evidence/e2e-real-research${llm ? '-llm' : ''}.json`, import.meta.url);
await writeFile(out, JSON.stringify(record, null, 2));
console.log(timeline.join('\n'));
console.log(`\nknowledge gaps: ${gaps.length}, surfaced: ${gaps.filter((g) => g.timing.surfacedAt).length}`);
console.log(`evidence items: ${verification.length}, excerpt found in live document: ${verification.filter((v) => v.excerptFoundInLiveDocument).length}`);
console.log(`written: ${out.pathname}`);
const ok = gaps.some((g) => g.timing.surfacedAt && g.evidence.length > 0) && verification.length > 0 && verification.every((v) => v.excerptFoundInLiveDocument !== false);
process.exit(ok ? 0 : 1);
