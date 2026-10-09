// Voice participation over a full scored conversation, checked against invariants rather than hand-picked lines:
//   1. never starts speaking while a person is talking (speaking windows simulated from word counts)
//   2. everything it says is a gap point (a surfaced contribution) or a reply when addressed
//   3. silent on the conversation's negative controls (answer key "mustNotSurface")
//   4. unsolicited spoken contributions are paced (cooldown)
//   5. addressed lines get the right kind of reply, and are not analysed as conversation
// Usage: node scripts/voice-simulation.ts [scenarios/<file>.json] [--ai] [--json out.json]

import { readFile, writeFile } from 'node:fs/promises';
import { ManualClock } from '../src/clock.ts';
import { buildEngine } from '../src/app.ts';
import { VoiceAgent, type SpeakRequest } from '../src/voice/voice-agent.ts';
import { SimulatedSearch, type Entry } from './simulated-search.ts';
import { aiFromArgs, aiRunValidity } from './ai-mode.ts';

const llm = aiFromArgs(process.argv);
const file = process.argv.slice(2).find((a, i, all) => a.endsWith('.json') && all[i - 1] !== '--json') ?? 'scenarios/x01-three-modes-rigorous.json';
const sc = JSON.parse(await readFile(file, 'utf8'));
const SIM = sc.simulatedSearch as { entries: Entry[]; releaseBeforeLine?: Record<string, string>; releaseAfterLine?: Record<string, string> };

// Addressed follow-ups appended after the conversation, with the reply kind each must get.
const ADDRESSED: { s: string; text: string; expect: RegExp; label: string }[] = [
  { s: 'B', text: "ThirdSeat, where's that from?", expect: /^That's from |^I haven't cited/, label: 'source' },
  { s: 'A', text: 'How sure are you on that, ThirdSeat?', expect: /^(Pretty sure|Fairly|Not sure)/, label: 'confidence' },
  { s: 'B', text: 'ThirdSeat, what should we call the product?', expect: /^That one's yours/, label: 'out of scope (opinion)' },
  { s: 'A', text: "ThirdSeat, what's still open?", expect: /^(Still open:|Nothing I'm tracking)/, label: 'open items' },
  { s: 'B', text: 'Thanks, ThirdSeat.', expect: /^$/, label: 'thanks → silence' },
];

const clock = new ManualClock(Date.UTC(2026, 9, 9, 10, 0, 0));
const t0 = clock.now();
const search = new SimulatedSearch(SIM.entries);
const { engine, analyzerId } = buildEngine({ session: { id: sc.id, createdAt: t0, title: sc.title, config: { objective: sc.objective, sourceUrls: [] } }, clock, extraTools: [search], llm, webSearch: false });
const voice = new VoiceAgent({ engine, clock, llm, config: { enabled: true } });

const spoken: (SpeakRequest & { line: number })[] = [];
let currentLine = -1;
voice.on((e) => e.type === 'speak' && spoken.push({ ...e.request, line: currentLine }));
const surfaced = new Set<string>();
engine.on((e) => e.type === 'intervention' && surfaced.add(e.gap.id));

// Human speaking windows: each line ends at its timestamp; duration from word count (2.6 words/s).
const lines = [...sc.lines, ...ADDRESSED.map((a, i) => ({ t: sc.lines.at(-1).t + 40 + i * 15, s: a.s, text: a.text }))];
const windows = lines.map((l: { t: number; text: string }) => {
  const dur = (l.text.split(/\s+/).length / 2.6) * 1000;
  return { from: t0 + l.t * 1000 - dur, to: t0 + l.t * 1000 };
});
const humanTalking = (at: number) => windows.some((w) => at >= w.from && at < w.to);

const settle = async () => {
  await engine.analysed();
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  engine.tick();
  voice.tick();
  await new Promise((r) => setImmediate(r));
};
const advanceTo = async (target: number) => {
  while (clock.now() + 250 <= target) {
    clock.advance(250);
    if (humanTalking(clock.now())) voice.humanActivity(clock.now());
    engine.tick();
    voice.tick();
    await new Promise((r) => setImmediate(r));
  }
  clock.set(Math.max(clock.now(), target));
};

const addressedReplies: { label: string; got: string; pass: boolean }[] = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (SIM.releaseBeforeLine?.[i]) {
    search.release(SIM.releaseBeforeLine[i]);
    await settle();
  }
  await advanceTo(t0 + line.t * 1000);
  currentLine = i;
  const before = spoken.length;
  const r = voice.receive({ speaker: line.s, text: line.text, at: clock.now() });
  if (r === 'pass') engine.ingest({ speaker: line.s, text: line.text, at: clock.now() });
  await settle();
  if (SIM.releaseAfterLine?.[i]) {
    search.release(SIM.releaseAfterLine[i]);
    await settle();
  }
  if (i >= sc.lines.length) {
    const a = ADDRESSED[i - sc.lines.length];
    await advanceTo(clock.now() + 6000);
    const reply = spoken.slice(before).find((s) => s.kind === 'reply');
    const got = reply?.text ?? '';
    addressedReplies.push({ label: a.label, got: got || '(silence)', pass: a.expect.test(got) && r === 'handled' });
  }
}
await advanceTo(clock.now() + 30_000);
search.releaseAll();
await engine.drain();

// ── invariants ──
const checks: { name: string; pass: boolean; detail: string }[] = [];
const overlaps = spoken.filter((s) => humanTalking(s.spokenAt!));
checks.push({ name: 'never starts speaking while a person is talking', pass: overlaps.length === 0, detail: overlaps.length ? overlaps.map((s) => `"${s.text}"`).join(' | ') : `${spoken.length} spoken turns, none over a human` });
const offScope = spoken.filter((s) => s.kind === 'contribution' && (!s.gapId || !surfaced.has(s.gapId)));
checks.push({ name: 'every unsolicited spoken turn is a surfaced gap point', pass: offScope.length === 0, detail: offScope.length ? offScope.map((s) => s.text).join(' | ') : 'all contributions map to surfaced gaps' });
const uttId = (i: number) => engine.state.transcript.filter((u) => !u.speaker.includes('→') && u.speaker !== 'ThirdSeat')[i]?.id;
const controlGapIds = new Set(sc.answerKey.mustNotSurface.flatMap((k: { trigger: number }) => [...engine.state.gaps.values()].filter((g) => g.triggerUtteranceId === uttId(k.trigger)).map((g) => g.id)));
const controlSpoken = spoken.filter((s) => s.gapId && controlGapIds.has(s.gapId));
checks.push({ name: 'silent on negative controls', pass: controlSpoken.length === 0, detail: controlSpoken.length ? controlSpoken.map((s) => s.text).join(' | ') : `${controlGapIds.size} control gap(s), none spoken` });
const contribTimes = spoken.filter((s) => s.kind === 'contribution').map((s) => s.spokenAt!);
const tooClose = contribTimes.filter((t, i) => i > 0 && t - contribTimes[i - 1] < voice.cfg.cooldownMs);
checks.push({ name: 'unsolicited turns paced (≥ cooldown apart)', pass: tooClose.length === 0, detail: `${contribTimes.length} contributions` });
for (const a of addressedReplies) checks.push({ name: `addressed: ${a.label}`, pass: a.pass, detail: a.got });
const analysedAddressed = [...engine.state.gaps.values()].filter((g) => /call the product|still open|where's that from/i.test(g.trigger));
checks.push({ name: 'addressed lines not analysed as conversation', pass: analysedAddressed.length === 0, detail: analysedAddressed.map((g) => g.trigger).join(' | ') || 'none became gaps' });

console.log(`\nVoice simulation: ${sc.title}\nanalyzer: ${analyzerId}\n\nWhat ThirdSeat said (line = after which line):`);
for (const s of spoken) console.log(`  line ${String(s.line).padStart(2)} [${s.kind}${s.intent ? `/${s.intent.toLowerCase()}` : ''}] ${s.text}`);
const m = voice.metrics;
console.log(`\nScreen-only (not spoken): ${m.screenOnly} · moment passed: ${m.droppedMomentPassed} · interrupted: ${m.interrupted}`);
console.log('\nChecks:');
for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
const passCount = checks.filter((c) => c.pass).length;
const validity = llm ? aiRunValidity(engine.log, llm) : { valid: true };
console.log(`\n${passCount}/${checks.length} checks passed.${llm ? ` AI: ${JSON.stringify(llm.summary())}${validity.valid ? '' : ` INVALID AI RUN: ${validity.reason}`}` : ''}`);
const out = process.argv.indexOf('--json');
if (out > 0) await writeFile(process.argv[out + 1], JSON.stringify({ ranAt: new Date().toISOString(), analyzer: analyzerId, spoken: spoken.map((s) => ({ line: s.line, kind: s.kind, intent: s.intent, text: s.text })), metrics: m, checks }, null, 2));
process.exit(passCount === checks.length && validity.valid ? 0 : 1);
