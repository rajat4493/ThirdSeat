// GapEngine: the core loop. Owns every product decision — what counts as a gap, when to research,
// when humans resolved something themselves, and what (if anything) is worth surfacing.

import type { Clock } from '../clock.ts';
import type {
  Confidence,
  DetectionReason,
  FeedbackFlag,
  Gap,
  GapType,
  Intervention,
  Millis,
  Session,
  TimingMode,
  UserActionType,
  Utterance,
} from '../domain/types.ts';
import { newId } from '../domain/ids.ts';
import { contentTerms, coverage, termSet, topTerms, truncate } from '../domain/text.ts';
import type { AnalysisOutput, ConversationAnalyzer, OpenQuestionView, QuestionKind, ResponseKind } from '../analysis/types.ts';
import { ConversationState } from '../state/conversation-state.ts';
import type { ResearchService } from '../research/research-service.ts';
import { InterventionPolicy, type PolicyConfig } from '../intervention/policy.ts';

export interface EngineConfig {
  /** A watched question is judged after this many following utterances… */
  watchUtterances: number;
  /** …or after this long, whichever comes first. */
  watchMs: Millis;
  threadRecallMinMs: Millis;
  threadRecallMinUtterances: number;
  driftWindowUtterances: number;
  driftMinMs: Millis;
  driftMaxRelatedness: number;
  driftCooldownMs: Millis;
  conclusionCooldownMs: Millis;
  reasoningCooldownMs: Millis;
  maxConcurrentResearch: number;
  /** Start researching factual questions the moment they are asked (before they qualify as gaps). */
  proactiveResearch: boolean;
  /** An unanswered question whose answer is ready is offered proactively after this long… */
  proactiveGraceMs: Millis;
  /** …or after this many further utterances without a human answer. */
  proactiveGraceUtterances: number;
  /** A knowledge answer surfaced this long after the question (or after the topic moved on) is retroactive. */
  retroactiveAfterMs: Millis;
  /** Cards count as "active" (occupying attention) for this long unless actioned. */
  activeTtlMs: Millis;
  policy: Partial<PolicyConfig>;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  watchUtterances: 3,
  watchMs: 25_000,
  threadRecallMinMs: 120_000,
  threadRecallMinUtterances: 6,
  driftWindowUtterances: 10,
  driftMinMs: 180_000,
  driftMaxRelatedness: 0.2,
  driftCooldownMs: 600_000,
  conclusionCooldownMs: 300_000,
  reasoningCooldownMs: 600_000,
  maxConcurrentResearch: 2,
  proactiveResearch: true,
  proactiveGraceMs: 8_000,
  proactiveGraceUtterances: 2,
  retroactiveAfterMs: 90_000,
  activeTtlMs: 150_000,
  policy: {},
};

interface Watch {
  id: string; // = question utterance id
  utterance: Utterance;
  kind: QuestionKind;
  interpreted: string;
  researchable: boolean;
  relevance: number;
  responses: { kind: ResponseKind; utteranceId: string; note: string }[];
  discussed: number;
  addressed: boolean;
  note: string;
  openToRoom: boolean;
  origin: 'question' | 'tentative_claim';
  /** Gap holding research started at question time (proactive research). */
  gapId?: string;
}

export type EngineEvent =
  | { type: 'utterance'; utterance: Utterance }
  | { type: 'gap'; gap: Gap }
  | { type: 'intervention'; intervention: Intervention; gap: Gap }
  | { type: 'log'; at: Millis; message: string };

type Listener = (e: EngineEvent) => void;

const OPEN_KNOWLEDGE = new Set(['DETECTED', 'RESEARCHING', 'OPEN', 'UNRESOLVED', 'PARTIALLY_RESOLVED']);

export class GapEngine {
  readonly session: Session;
  readonly state: ConversationState;
  readonly policy: InterventionPolicy;
  readonly cfg: EngineConfig;
  private analyzer: ConversationAnalyzer;
  private fallbackAnalyzer?: ConversationAnalyzer;
  private research?: ResearchService;
  private clock: Clock;
  private listeners: Listener[] = [];
  private watches = new Map<string, Watch>();
  private gapByTrigger = new Map<string, string>();
  private pending: Utterance[] = [];
  private processing: Promise<void> = Promise.resolve();
  private inflight = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private researchQueue: { gapId: string; depth: 'normal' | 'deep' }[] = [];
  private seq = 0;
  private lastCommitmentAt = -Infinity;
  private lastDriftAt = -Infinity;
  private lastConclusionAt = -Infinity;
  private lastReasoningAt = -Infinity;
  private llmRelatedness: { at: Millis; value: number }[] = [];
  readonly log: { at: Millis; message: string }[] = [];

  constructor(opts: {
    session: Session;
    analyzer: ConversationAnalyzer;
    fallbackAnalyzer?: ConversationAnalyzer;
    research?: ResearchService;
    clock: Clock;
    config?: Partial<EngineConfig>;
  }) {
    this.session = opts.session;
    this.analyzer = opts.analyzer;
    this.fallbackAnalyzer = opts.fallbackAnalyzer;
    this.research = opts.research;
    this.clock = opts.clock;
    this.cfg = { ...DEFAULT_ENGINE_CONFIG, ...opts.config };
    this.policy = new InterventionPolicy(this.cfg.policy);
    this.state = new ConversationState(opts.session.config.objective);
  }

  on(l: Listener): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* listeners must not break the engine */
      }
    }
  }

  private note(message: string): void {
    const entry = { at: this.clock.now(), message };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    this.emit({ type: 'log', ...entry });
  }

  // ───────────────────────────── ingestion ─────────────────────────────

  ingest(input: { speaker: string; text: string; at?: Millis }): Utterance {
    const u: Utterance = {
      id: newId('u'),
      sessionId: this.session.id,
      speaker: input.speaker.trim() || 'Room',
      text: input.text.trim(),
      at: input.at ?? this.clock.now(),
      seq: ++this.seq,
    };
    this.state.addUtterance(u);
    this.emit({ type: 'utterance', utterance: u });
    this.pending.push(u);
    this.processing = this.processing.then(() => this.processPending()).catch((e) => this.note(`processing error: ${(e as Error).message}`));
    return u;
  }

  /** Resolves when queued utterances are analysed (research may still be running). */
  analysed(): Promise<void> {
    return this.processing;
  }

  /** Number of research runs in flight. */
  get researching(): number {
    return this.inflight.size;
  }

  /** Resolves when all queued utterances are analysed and all research has finished. For tests and scripts. */
  async drain(): Promise<void> {
    for (;;) {
      await this.processing;
      const running = [...this.inflight.values()].map((x) => x.promise);
      if (running.length === 0 && this.pending.length === 0) break;
      await Promise.all(running);
    }
    this.tick();
  }

  private async processPending(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0);
    const input = { state: this.state, newUtterances: batch, openQuestions: this.openQuestionViews(batch[0].seq) };
    let analysis: AnalysisOutput;
    try {
      analysis = await this.analyzer.analyze(input);
    } catch (e) {
      if (!this.fallbackAnalyzer) throw e;
      this.note(`analyzer ${this.analyzer.id} failed (${(e as Error).message}); using ${this.fallbackAnalyzer.id}`);
      analysis = await this.fallbackAnalyzer.analyze(input);
    }
    this.apply(analysis, batch);
    this.tick();
  }

  private openQuestionViews(firstSeq: number): OpenQuestionView[] {
    const seqOf = (id: string) => this.state.utterance(id)?.seq ?? firstSeq;
    const since = (id: string) => Math.max(0, firstSeq - 1 - seqOf(id));
    const views: OpenQuestionView[] = [];
    for (const w of this.watches.values()) {
      views.push({ id: w.id, question: w.interpreted, askedBy: w.utterance.speaker, triggerUtteranceId: w.id, kind: w.kind, utterancesSince: since(w.id) });
    }
    for (const g of this.state.gaps.values()) {
      const live = (g.type === 'KNOWLEDGE' && OPEN_KNOWLEDGE.has(g.status)) || (g.type === 'OPEN_THREAD' && g.status === 'OPEN');
      if (!live || g.speculative) continue;
      const u = this.state.utterance(g.triggerUtteranceId);
      views.push({
        id: g.id,
        question: g.interpretedQuestion,
        askedBy: u?.speaker ?? '?',
        triggerUtteranceId: g.triggerUtteranceId,
        kind: g.type === 'OPEN_THREAD' ? 'STRATEGIC' : 'FACTUAL',
        utterancesSince: since(g.triggerUtteranceId),
      });
    }
    return views.sort((a, b) => a.utterancesSince - b.utterancesSince);
  }

  // ───────────────────────────── applying analysis ─────────────────────────────

  private apply(a: AnalysisOutput, batch: Utterance[]): void {
    const now = this.clock.now();

    for (const q of a.questions) {
      const u = this.state.utterance(q.utteranceId);
      if (!u || q.kind === 'SOCIAL') continue;
      if (q.kind === 'DECISION') {
        this.lastCommitmentAt = now;
        continue;
      }
      if (this.isDuplicateQuestion(q.interpretedQuestion)) {
        this.note(`duplicate question merged: "${truncate(q.interpretedQuestion, 60)}"`);
        continue;
      }
      this.watches.set(u.id, {
        id: u.id,
        utterance: u,
        kind: q.kind,
        interpreted: q.interpretedQuestion,
        researchable: q.researchable,
        relevance: q.relevance,
        responses: [],
        discussed: 0,
        addressed: false,
        note: q.note,
        openToRoom: !!q.openToRoom,
        origin: q.origin ?? 'question',
      });
      const w = this.watches.get(u.id)!;
      if (q.kind === 'FACTUAL' && q.researchable && this.research && this.cfg.proactiveResearch) this.startProactiveResearch(w);
    }

    for (const r of a.responses) {
      const watch = this.watches.get(r.targetId);
      if (watch) {
        watch.responses.push({ kind: r.kind, utteranceId: r.utteranceId, note: r.note });
        this.evaluateWatch(watch, false);
        continue;
      }
      const gapId = this.state.gaps.has(r.targetId) ? r.targetId : this.gapByTrigger.get(r.targetId);
      const gap = gapId ? this.state.gaps.get(gapId) : undefined;
      if (gap) this.onGapResponse(gap, r.kind, r.utteranceId, r.note);
    }

    for (const t of a.threadActivity) {
      const watch = this.watches.get(t.targetId);
      if (watch) {
        watch.discussed++;
        if (t.kind === 'ADDRESSED') watch.addressed = true;
        continue;
      }
      const gapId = this.state.gaps.has(t.targetId) ? t.targetId : this.gapByTrigger.get(t.targetId);
      const gap = gapId ? this.state.gaps.get(gapId) : undefined;
      if (!gap) continue;
      gap.lastDiscussedAt = now;
      if (t.kind === 'ADDRESSED' && gap.status === 'OPEN') {
        this.setStatus(gap, 'NATURALLY_RESOLVED', `addressed in conversation (${t.note})`);
        this.policy.withdraw(gap.id);
      }
      this.emitGap(gap);
    }

    for (const s of a.statements) {
      const u = this.state.utterance(s.utteranceId);
      if (!u) continue;
      if (s.kind === 'FACT') this.state.addFact({ text: s.text, utteranceId: u.id, at: u.at });
      else this.state.addAssumption({ text: s.text, utteranceId: u.id, at: u.at });
    }

    if (a.commitmentSignals.length) this.lastCommitmentAt = now;
    if (a.topicRelatedness !== undefined) {
      this.llmRelatedness.push({ at: now, value: a.topicRelatedness });
      if (this.llmRelatedness.length > 20) this.llmRelatedness.shift();
    }

    for (const r of a.reasoning) this.onReasoningLeap(r.utteranceId, r.premiseUtteranceId, r.text);
    for (const c of a.claims) this.onMaterialClaim(c.utteranceId, c.claim, c.note);

    // Watches age by utterances.
    for (const w of this.watches.values()) this.evaluateWatch(w, false);

    this.updateTopic(batch);
    if (a.conclusionSignals.length) this.onConclusionSignal(a.conclusionSignals[0].utteranceId, a.conclusionSignals[0].note);
  }

  private isDuplicateQuestion(q: string): boolean {
    const t = termSet(q);
    const all = [...this.watches.values()].map((w) => w.interpreted).concat(
      [...this.state.gaps.values()].filter((g) => !g.speculative && (OPEN_KNOWLEDGE.has(g.status) || g.status === 'RESOLVED')).map((g) => g.interpretedQuestion),
    );
    return all.some((x) => {
      const o = termSet(x);
      return coverage(t, o) >= 0.8 && coverage(o, t) >= 0.6;
    });
  }

  private utterancesAfter(id: string): number {
    const u = this.state.utterance(id);
    return u ? this.seq - u.seq : 0;
  }

  /** Decide what a watched question has become. `expired` = window closed with nothing decisive. */
  private evaluateWatch(w: Watch, expired: boolean): void {
    const kinds = new Set(w.responses.map((r) => r.kind));
    const seen = this.utterancesAfter(w.id);
    const timeUp = this.clock.now() - w.utterance.at >= this.cfg.watchMs;
    const windowClosed = expired || seen >= this.cfg.watchUtterances || timeUp;
    const lastResponse = w.responses.at(-1);

    if (w.kind === 'FACTUAL') {
      // The latest decisive response wins: "I think so" followed by "Yes, we use it" is resolved.
      if (lastResponse?.kind === 'CONFIDENT_ANSWER' && !kinds.has('DEFERRAL')) {
        return this.closeWatch(w, 'NATURALLY_RESOLVED', 'QUESTION_RAISED', `answered credibly in conversation (${lastResponse.note})`);
      }
      if (w.origin === 'tentative_claim') {
        return this.closeWatch(w, 'QUALIFY', 'LOW_CONFIDENCE_HUMAN_RESPONSE', 'tentative claim — checked without being asked', 'PROACTIVE');
      }
      if (kinds.has('DEFERRAL')) return this.closeWatch(w, 'QUALIFY', 'DEFERRED_FOR_LATER', 'humans deferred the answer', 'REACTIVE');
      if (kinds.has('UNCERTAIN')) return this.closeWatch(w, 'QUALIFY', 'EXPLICIT_UNANSWERED_QUESTION', 'humans said they do not know', 'REACTIVE');
      if (kinds.has('WEAK_ANSWER')) return this.closeWatch(w, 'QUALIFY', 'LOW_CONFIDENCE_HUMAN_RESPONSE', 'only a low-confidence answer was given', 'REACTIVE');
      // Proactive: the answer is already prepared and nobody has answered — don't wait for "not sure".
      const g = w.gapId ? this.state.gaps.get(w.gapId) : undefined;
      const ready = !!g?.prefetchOutcome && g.prefetchOutcome !== 'UNRESOLVED';
      const graceOver = w.openToRoom || seen >= this.cfg.proactiveGraceUtterances || this.clock.now() - w.utterance.at >= this.cfg.proactiveGraceMs;
      if (ready && graceOver) {
        return this.closeWatch(w, 'QUALIFY', 'EXPLICIT_UNANSWERED_QUESTION', w.openToRoom ? 'asked to the room; answer ready' : 'answer ready and nobody has answered', 'PROACTIVE');
      }
      if (windowClosed) return this.closeWatch(w, 'QUALIFY', 'EXPLICIT_UNANSWERED_QUESTION', 'question left unanswered as conversation moved on', 'PROACTIVE');
      return;
    }
    // STRATEGIC: important judgement questions become open threads unless the group actually addressed them.
    if (w.addressed || (lastResponse?.kind === 'CONFIDENT_ANSWER' && w.discussed > 0)) {
      return this.closeWatch(w, 'NATURALLY_RESOLVED', 'QUESTION_RAISED', 'addressed in conversation');
    }
    if (windowClosed) {
      // Even if still being discussed, it is not resolved: track it as an open thread.
      return this.closeWatch(w, 'THREAD', 'IMPORTANT_OPEN_THREAD', kinds.size ? `acknowledged but unresolved (${[...kinds].join(', ').toLowerCase()})` : 'raised and left unresolved');
    }
  }

  private newGapFromWatch(w: Watch, type: GapType, reason: DetectionReason, note: string): Gap {
    const now = this.clock.now();
    const gap: Gap = {
      id: newId('gap'),
      sessionId: this.session.id,
      type,
      reason,
      status: 'DETECTED',
      triggerUtteranceId: w.id,
      contextUtteranceIds: this.contextIds(w.utterance),
      trigger: w.utterance.text,
      interpretedQuestion: w.interpreted,
      relevanceToObjective: w.relevance,
      researchable: w.researchable && type === 'KNOWLEDGE',
      priority: 0,
      evidence: [],
      timing: { triggerAt: w.utterance.at, detectedAt: now },
      decisionLog: [{ at: now, note }],
      userActions: [],
      feedback: [],
    };
    this.state.gaps.set(gap.id, gap);
    this.gapByTrigger.set(w.id, gap.id);
    return gap;
  }

  /** Start research the moment a factual question is asked; nothing is shown unless it qualifies. */
  private startProactiveResearch(w: Watch): void {
    const gap = this.newGapFromWatch(w, 'KNOWLEDGE', 'QUESTION_RAISED', `${w.note}; researching ahead of time`);
    gap.speculative = true;
    gap.askedToRoom = w.openToRoom || undefined;
    gap.priority = 0.5;
    w.gapId = gap.id;
    this.enqueueResearch(gap.id, 'normal');
  }

  private closeWatch(w: Watch, outcome: 'NATURALLY_RESOLVED' | 'QUALIFY' | 'THREAD', reason: DetectionReason, why: string, mode?: TimingMode): void {
    this.watches.delete(w.id);
    const now = this.clock.now();
    const pre = w.gapId ? this.state.gaps.get(w.gapId) : undefined;
    if (pre && outcome !== 'THREAD') return this.settleSpeculative(w, pre, outcome, reason, why, mode);
    const ctx = this.contextIds(w.utterance);
    const type: GapType = outcome === 'THREAD' ? 'OPEN_THREAD' : 'KNOWLEDGE';
    const gap: Gap = {
      id: newId('gap'),
      sessionId: this.session.id,
      type,
      reason,
      status: 'DETECTED',
      triggerUtteranceId: w.id,
      contextUtteranceIds: ctx,
      trigger: w.utterance.text,
      interpretedQuestion: w.interpreted,
      relevanceToObjective: w.relevance,
      researchable: w.researchable && type === 'KNOWLEDGE',
      askedToRoom: w.openToRoom || undefined,
      priority: 0,
      evidence: [],
      timing: { triggerAt: w.utterance.at, detectedAt: now },
      decisionLog: [{ at: now, note: `${w.note}; ${why}` }],
      userActions: [],
      feedback: [],
    };
    this.state.gaps.set(gap.id, gap);
    this.gapByTrigger.set(w.id, gap.id);

    if (outcome === 'NATURALLY_RESOLVED') {
      gap.status = 'NATURALLY_RESOLVED';
      gap.timing.resolvedAt = now;
      this.note(`stood down: "${truncate(w.interpreted, 60)}" — ${why}`);
      this.emitGap(gap);
      return;
    }
    gap.timing.qualifiedAt = now;
    if (outcome === 'THREAD') {
      gap.status = 'OPEN';
      this.note(`tracking open thread: "${truncate(w.interpreted, 60)}"`);
      this.emitGap(gap);
      return;
    }
    gap.priority = this.basePriority(gap);
    gap.timingMode = mode;
    if (gap.researchable && this.research) {
      this.emitGap(gap);
      this.enqueueResearch(gap.id, 'normal');
    } else {
      gap.status = 'OPEN';
      gap.decisionLog.push({ at: now, note: gap.researchable ? 'no research service configured' : 'not publicly researchable (about the group itself); tracked as open item' });
      this.emitGap(gap);
    }
  }

  /** A question researched ahead of time is now decided: stand down, or qualify and use what was found. */
  private settleSpeculative(w: Watch, gap: Gap, outcome: 'NATURALLY_RESOLVED' | 'QUALIFY', reason: DetectionReason, why: string, mode?: TimingMode): void {
    const now = this.clock.now();
    if (outcome === 'NATURALLY_RESOLVED') {
      const running = this.inflight.get(gap.id);
      if (running) running.controller.abort();
      this.researchQueue = this.researchQueue.filter((q) => q.gapId !== gap.id);
      gap.speculative = false;
      gap.status = 'NATURALLY_RESOLVED';
      gap.timing.resolvedAt = now;
      gap.decisionLog.push({ at: now, note: `${why}${running ? '; advance research cancelled' : gap.prefetchOutcome ? '; advance research discarded' : ''}` });
      this.note(`stood down: "${truncate(w.interpreted, 60)}" — ${why}`);
      this.emitGap(gap);
      return;
    }
    gap.speculative = false;
    gap.reason = reason;
    gap.timing.qualifiedAt = now;
    gap.timingMode = mode;
    gap.contextUtteranceIds = this.contextIds(w.utterance);
    gap.decisionLog.push({ at: now, note: why });
    gap.priority = this.basePriority(gap, gap.prefetchOutcome ? gap.confidence : undefined);
    if (gap.prefetchOutcome) {
      gap.decisionLog.push({ at: now, note: 'answer was prepared before the gap qualified' });
      return this.applyOutcome(gap, gap.prefetchOutcome);
    }
    if (this.inflight.has(gap.id) || this.researchQueue.some((q) => q.gapId === gap.id)) {
      // Still researching; the normal path takes over when it finishes.
      gap.status = 'RESEARCHING';
      this.emitGap(gap);
      return;
    }
    this.emitGap(gap);
    this.enqueueResearch(gap.id, 'normal');
  }

  private contextIds(u: Utterance): string[] {
    const i = this.state.transcript.findIndex((x) => x.id === u.id);
    return this.state.transcript.slice(Math.max(0, i - 2), i + 4).map((x) => x.id);
  }

  private onGapResponse(gap: Gap, kind: ResponseKind, utteranceId: string, note: string): void {
    const now = this.clock.now();
    gap.lastDiscussedAt = now;
    if (kind === 'CONFIDENT_ANSWER') {
      if (gap.type === 'OPEN_THREAD' && gap.status === 'OPEN') {
        this.setStatus(gap, 'NATURALLY_RESOLVED', `answered in conversation (${note})`);
        this.policy.withdraw(gap.id);
        return;
      }
      if (gap.type !== 'KNOWLEDGE') return;
      if (gap.timing.surfacedAt) {
        gap.decisionLog.push({ at: now, note: 'humans also answered it after the intervention' });
        this.emitGap(gap);
        return;
      }
      const running = this.inflight.get(gap.id);
      if (running) running.controller.abort();
      this.researchQueue = this.researchQueue.filter((q) => q.gapId !== gap.id);
      const withdrawn = this.policy.withdraw(gap.id);
      this.setStatus(
        gap,
        'NATURALLY_RESOLVED',
        `humans resolved it themselves (${note})${running ? '; research cancelled' : ''}${withdrawn ? '; pending intervention suppressed' : ''}`,
      );
      const u = this.state.utterance(utteranceId);
      if (u) this.state.addFact({ text: `${gap.interpretedQuestion} → ${u.text}`, utteranceId, at: u.at });
      return;
    }
    if (kind === 'DEFERRAL' && gap.type === 'KNOWLEDGE' && gap.reason !== 'DEFERRED_FOR_LATER') {
      gap.reason = 'DEFERRED_FOR_LATER';
      gap.priority = this.basePriority(gap);
      gap.decisionLog.push({ at: now, note: 'humans deferred it — would become follow-up work' });
      this.emitGap(gap);
    }
  }

  private setStatus(gap: Gap, status: Gap['status'], why: string): void {
    gap.status = status;
    if (['RESOLVED', 'NATURALLY_RESOLVED', 'DISMISSED', 'NOT_A_GAP'].includes(status)) gap.timing.resolvedAt ??= this.clock.now();
    gap.decisionLog.push({ at: this.clock.now(), note: why });
    this.note(`${gap.type.toLowerCase()} "${truncate(gap.interpretedQuestion, 50)}" → ${status}: ${why}`);
    this.emitGap(gap);
  }

  private emitGap(gap: Gap): void {
    this.emit({ type: 'gap', gap });
  }

  // ───────────────────────────── research ─────────────────────────────

  private basePriority(gap: Gap, confidence?: Confidence): number {
    const base: Partial<Record<DetectionReason, number>> = {
      USER_REQUESTED: 1,
      DEFERRED_FOR_LATER: 0.9,
      EXPLICIT_UNANSWERED_QUESTION: 0.75,
      LOW_CONFIDENCE_HUMAN_RESPONSE: 0.65,
    };
    // UNVERIFIED-but-offered answers (relevant official passage, unconfirmed) only surface for stronger needs.
    const conf = confidence === 'HIGH' ? 1 : confidence === 'LIKELY' ? 0.8 : confidence === 'UNVERIFIED' ? 0.6 : 1;
    return Number(((base[gap.reason] ?? 0.6) * conf * (0.7 + 0.3 * gap.relevanceToObjective)).toFixed(3));
  }

  private enqueueResearch(gapId: string, depth: 'normal' | 'deep'): void {
    if (this.inflight.has(gapId) || this.researchQueue.some((q) => q.gapId === gapId)) return;
    this.researchQueue.push({ gapId, depth });
    this.pumpResearch();
  }

  private pumpResearch(): void {
    // Most important first when several gaps compete for research capacity.
    this.researchQueue.sort((a, b) => (this.state.gaps.get(b.gapId)?.priority ?? 0) - (this.state.gaps.get(a.gapId)?.priority ?? 0));
    while (this.inflight.size < this.cfg.maxConcurrentResearch && this.researchQueue.length) {
      const { gapId, depth } = this.researchQueue.shift()!;
      const gap = this.state.gaps.get(gapId);
      if (!gap || !['DETECTED', 'RESEARCHING', 'UNRESOLVED', 'PARTIALLY_RESOLVED', 'RESOLVED', 'OPEN'].includes(gap.status)) continue;
      const controller = new AbortController();
      const promise = this.runResearch(gap, depth, controller).finally(() => {
        this.inflight.delete(gapId);
        this.pumpResearch();
      });
      this.inflight.set(gapId, { controller, promise });
    }
  }

  private async runResearch(gap: Gap, depth: 'normal' | 'deep', controller: AbortController): Promise<void> {
    if (!this.research) return;
    gap.status = 'RESEARCHING';
    gap.timing.researchStartedAt = this.clock.now();
    gap.decisionLog.push({ at: this.clock.now(), note: depth === 'deep' ? 'researching more deeply (user asked)' : 'research started' });
    this.emitGap(gap);
    let run;
    try {
      run = await this.research.run(gap, this.state, depth, controller.signal);
    } catch (e) {
      gap.status = 'UNRESOLVED';
      gap.decisionLog.push({ at: this.clock.now(), note: `research failed: ${(e as Error).message}` });
      this.emitGap(gap);
      return;
    }
    if (controller.signal.aborted || (gap.status !== 'RESEARCHING' && !gap.speculative)) {
      gap.decisionLog.push({ at: this.clock.now(), note: 'research result discarded — gap no longer open' });
      this.emitGap(gap);
      return;
    }
    const now = this.clock.now();
    gap.evidence = run.evidence
      .filter((e) => run.answer.usedEvidenceIds.includes(e.id))
      .concat(run.evidence.filter((e) => !run.answer.usedEvidenceIds.includes(e.id)).slice(0, 3));
    gap.timing.firstEvidenceAt = run.firstEvidenceAt;
    gap.timing.answeredAt = now;
    gap.researchDurationMs = run.durationMs;
    gap.confidence = run.answer.confidence;
    gap.answer = run.answer.answer;
    gap.caveat = run.answer.caveat;
    gap.decisionLog.push({ at: now, note: `${run.answer.note}; tools: ${run.toolsUsed.join(', ') || 'none'}${run.toolErrors.length ? `; issues: ${run.toolErrors.join('; ')}` : ''}` });

    if (gap.speculative) {
      // Prepared ahead of time: hold it until the question qualifies (or the humans answer it).
      gap.prefetchOutcome = run.answer.outcome;
      gap.status = 'DETECTED';
      this.emitGap(gap);
      const w = this.watches.get(gap.triggerUtteranceId);
      if (w) this.evaluateWatch(w, false);
      return;
    }
    this.applyOutcome(gap, run.answer.outcome);
  }

  private applyOutcome(gap: Gap, outcome: 'RESOLVED' | 'PARTIALLY_RESOLVED' | 'UNRESOLVED'): void {
    const now = this.clock.now();
    if (outcome === 'UNRESOLVED') {
      gap.status = 'UNRESOLVED';
      gap.caveat = gap.caveat ?? "I couldn't verify this reliably.";
      gap.decisionLog.push({ at: now, note: 'no reliable answer — listed as open, not interrupting' });
      this.emitGap(gap);
      return;
    }
    gap.status = outcome;
    gap.priority = this.basePriority(gap, gap.confidence);
    gap.interventionText = this.knowledgeText(gap);
    this.emitGap(gap);
    this.policy.offer({
      gapId: gap.id,
      kind: 'KNOWLEDGE',
      priority: gap.priority,
      text: gap.interventionText,
      offeredAt: now,
      expiresAt: now + (gap.reason === 'DEFERRED_FOR_LATER' || gap.reason === 'USER_REQUESTED' ? 1_800_000 : 600_000),
    });
    this.flushPolicy();
  }

  private knowledgeText(gap: Gap, mode: TimingMode | undefined = gap.timingMode): string {
    if (mode === 'RETROACTIVE') {
      const mins = Math.max(1, Math.round((this.clock.now() - gap.timing.triggerAt) / 60_000));
      return `Back to “${truncate(gap.interpretedQuestion, 120)}” (raised ${mins} min ago): ${gap.answer ?? ''}`.trim();
    }
    if (mode === 'PROACTIVE') {
      const lead = /^Is it true that /.test(gap.interpretedQuestion)
        ? 'Checked the assumption you just made: '
        : gap.askedToRoom
          ? "You asked the room — here's what I found: "
          : 'Looked this up while you were talking: ';
      return `${lead}${gap.answer ?? ''}`.trim();
    }
    const why: Partial<Record<DetectionReason, string>> = {
      DEFERRED_FOR_LATER: 'You deferred this — it looks resolvable now instead of becoming follow-up work.',
      EXPLICIT_UNANSWERED_QUESTION: 'Nobody in the conversation knew this.',
      LOW_CONFIDENCE_HUMAN_RESPONSE: 'The answer given was tentative; this checks it.',
      USER_REQUESTED: 'You asked for this.',
    };
    return [gap.answer, why[gap.reason]].filter(Boolean).join(' ');
  }

  /** Decide the timing mode at the moment of surfacing. */
  private surfaceMode(gap: Gap): TimingMode {
    if (gap.type === 'OPEN_THREAD' || gap.type === 'DECISION') return 'RETROACTIVE';
    if (gap.type === 'DRIFT' || gap.type === 'REASONING' || gap.type === 'EVIDENCE') return 'PROACTIVE';
    if (gap.type === 'KNOWLEDGE') {
      const late = this.clock.now() - gap.timing.triggerAt >= this.cfg.retroactiveAfterMs || !this.topicLive(gap);
      if (late && gap.reason !== 'USER_REQUESTED') return 'RETROACTIVE';
      if (gap.reason === 'USER_REQUESTED') return 'REACTIVE';
    }
    return gap.timingMode ?? 'REACTIVE';
  }

  // ───────────────────────────── periodic checks ─────────────────────────────

  /** Time-based checks. Called after each batch and on a timer. */
  tick(): void {
    for (const w of [...this.watches.values()]) {
      if (this.clock.now() - w.utterance.at >= this.cfg.watchMs) this.evaluateWatch(w, true);
    }
    this.checkThreadRecall();
    this.checkDrift();
    this.flushPolicy();
  }

  private checkThreadRecall(): void {
    const now = this.clock.now();
    const commitmentRecent = now - this.lastCommitmentAt < 45_000;
    if (!commitmentRecent) return;
    for (const g of this.state.gaps.values()) {
      if (g.type !== 'OPEN_THREAD' || g.status !== 'OPEN' || g.timing.surfacedAt) continue;
      if (g.relevanceToObjective < 0.5) continue;
      if (now - g.timing.triggerAt < this.cfg.threadRecallMinMs) continue;
      if (this.utterancesAfter(g.triggerUtteranceId) < this.cfg.threadRecallMinUtterances) continue;
      if (g.lastDiscussedAt && now - g.lastDiscussedAt < 60_000) continue;
      if (this.recentlyListedIn(g.id, 'DECISION')) continue;
      const mins = Math.max(1, Math.round((now - g.timing.triggerAt) / 60_000));
      g.priority = Number((0.55 + 0.25 * g.relevanceToObjective).toFixed(3));
      g.interventionText = `Earlier (${mins} min ago) you raised: “${truncate(g.interpretedQuestion, 140)}” It is still unresolved${
        this.state.objective ? ' and looks relevant to the objective' : ''
      }, and you're now making decisions that may depend on it.`;
      g.decisionLog.push({ at: now, note: 'thread still unresolved; conversation reached a decision point' });
      this.policy.offer({ gapId: g.id, kind: 'OPEN_THREAD', priority: g.priority, text: g.interventionText, offeredAt: now, expiresAt: now + 120_000 });
    }
  }

  private recentlyListedIn(gapId: string, kind: GapType): boolean {
    const now = this.clock.now();
    return [...this.state.gaps.values()].some(
      (g) => g.type === kind && g.timing.surfacedAt && now - g.timing.surfacedAt < 300_000 && g.relatedGapIds?.includes(gapId),
    );
  }

  private relatedness(u: Utterance, reference: Set<string>): number {
    const t = contentTerms(u.text);
    if (t.length === 0) return 1;
    const hit = t.filter((x) => reference.has(x)).length;
    return Math.min(1, hit / Math.min(t.length, 4));
  }

  private updateTopic(batch: Utterance[]): void {
    const recent = this.state.recent(6);
    const core = this.state.coreTerms();
    const rel = recent.length ? recent.reduce((s, u) => s + this.relatedness(u, core), 0) / recent.length : 1;
    const terms = topTerms(recent.map((u) => u.text), 5);
    if (terms.join() !== this.state.topic.terms.join()) this.state.topic.since = batch[0]?.at ?? this.clock.now();
    this.state.topic.terms = terms;
    this.state.topic.objectiveRelatedness = Number(rel.toFixed(2));
  }

  private checkDrift(): void {
    const now = this.clock.now();
    if (!this.state.objective) return;
    if (now - this.lastDriftAt < this.cfg.driftCooldownMs) return;
    const substantive = this.state.transcript.filter((u) => contentTerms(u.text).length >= 3);
    const window = substantive.slice(-this.cfg.driftWindowUtterances);
    if (window.length < this.cfg.driftWindowUtterances) return;
    const span = window.at(-1)!.at - window[0].at;
    if (span < this.cfg.driftMinMs) return;

    // Reference = what matters (objective + open/resolved items) + what the session discussed before the window.
    const reference = this.state.coreTerms();
    for (const u of this.state.transcript.filter((x) => x.seq < window[0].seq)) for (const t of contentTerms(u.text)) reference.add(t);
    const lexical = window.reduce((s, u) => s + this.relatedness(u, reference), 0) / window.length;
    const llm = this.llmRelatedness.filter((r) => r.at >= window[0].at);
    const related = llm.length >= 2 ? Math.max(...llm.map((r) => r.value)) : lexical;

    const existing = [...this.state.gaps.values()].find((g) => g.type === 'DRIFT' && g.status === 'OPEN' && !g.timing.surfacedAt);
    if (related > this.cfg.driftMaxRelatedness) {
      if (existing) {
        this.policy.withdraw(existing.id);
        this.setStatus(existing, 'NOT_A_GAP', 'discussion returned to the objective before surfacing');
      }
      return;
    }
    // Materiality: drift only matters if something important is still unresolved.
    const blockers = this.state.unresolvedImportant(0.5);
    if (blockers.length === 0 || existing) return;
    const exclude = this.state.coreTerms();
    const topic = topTerms(window.map((u) => u.text), 3, exclude);
    const mins = Math.max(1, Math.round(span / 60_000));
    const gap: Gap = {
      id: newId('gap'),
      sessionId: this.session.id,
      type: 'DRIFT',
      reason: 'MATERIAL_OBJECTIVE_DRIFT',
      status: 'OPEN',
      triggerUtteranceId: window[0].id,
      contextUtteranceIds: window.slice(-4).map((u) => u.id),
      trigger: `~${mins} min on ${topic.join(', ')}`,
      interpretedQuestion: 'Discussion has moved away from the session objective',
      relevanceToObjective: 1,
      researchable: false,
      priority: 0.55,
      evidence: [],
      timing: { triggerAt: window[0].at, detectedAt: now, qualifiedAt: now },
      decisionLog: [{ at: now, note: `relatedness ${related.toFixed(2)} over ${window.length} utterances / ${mins} min; ${blockers.length} unresolved objective item(s)` }],
      userActions: [],
      feedback: [],
      relatedGapIds: blockers.slice(0, 3).map((b) => b.id),
    };
    gap.interventionText = `The discussion has moved to ${topic.join(', ') || 'other topics'} (~${mins} min). Still unresolved for today's objective: ${blockers
      .slice(0, 3)
      .map((b) => `“${truncate(b.interpretedQuestion, 80)}”`)
      .join('; ')}.`;
    this.state.gaps.set(gap.id, gap);
    this.lastDriftAt = now;
    this.emitGap(gap);
    this.policy.offer({ gapId: gap.id, kind: 'DRIFT', priority: gap.priority, text: gap.interventionText, offeredAt: now, expiresAt: now + 90_000 });
  }

  private onConclusionSignal(utteranceId: string, note: string): void {
    const now = this.clock.now();
    if (now - this.lastConclusionAt < this.cfg.conclusionCooldownMs) return;
    const blockers = [
      ...this.state.unresolvedImportant(0.4),
      ...[...this.state.gaps.values()].filter((g) => g.type === 'KNOWLEDGE' && g.status === 'PARTIALLY_RESOLVED'),
    ];
    if (blockers.length === 0) return; // nothing useful to add — stay silent
    const resolved = [...this.state.gaps.values()].filter((g) => ['RESOLVED', 'NATURALLY_RESOLVED'].includes(g.status) && g.type !== 'DRIFT').length;
    const u = this.state.utterance(utteranceId)!;
    const list = blockers.slice(0, 4).map((b, i) => `${i + 1}. ${truncate(b.interpretedQuestion, 100)}${b.status === 'PARTIALLY_RESOLVED' ? ' (only partly verified)' : ''}`);
    const gap: Gap = {
      id: newId('gap'),
      sessionId: this.session.id,
      type: 'DECISION',
      reason: 'CONCLUSION_WITH_OPEN_BLOCKERS',
      status: 'OPEN',
      triggerUtteranceId: utteranceId,
      contextUtteranceIds: this.contextIds(u),
      trigger: u.text,
      interpretedQuestion: 'Group is concluding with unresolved items',
      relevanceToObjective: 1,
      researchable: false,
      priority: 0.85,
      evidence: [],
      timing: { triggerAt: u.at, detectedAt: now, qualifiedAt: now },
      decisionLog: [{ at: now, note: `conclusion signal ${note}; ${blockers.length} unresolved item(s)` }],
      userActions: [],
      feedback: [],
      relatedGapIds: blockers.map((b) => b.id),
    };
    gap.interventionText = `You appear close to a conclusion. ${this.state.objective ? 'Based on the objective, these' : 'These'} are still unresolved:\n${list.join('\n')}${
      resolved ? `\n${resolved} other question(s) raised were answered during the session.` : ''
    }`;
    this.state.gaps.set(gap.id, gap);
    this.lastConclusionAt = now;
    for (const b of blockers) this.policy.withdraw(b.id);
    this.emitGap(gap);
    this.policy.offer({ gapId: gap.id, kind: 'DECISION', priority: gap.priority, text: gap.interventionText, offeredAt: now, expiresAt: now + 120_000 });
  }

  private onReasoningLeap(utteranceId: string, premiseId: string, text: string): void {
    const now = this.clock.now();
    if (!this.state.objective || now - this.lastReasoningAt < this.cfg.reasoningCooldownMs) return;
    const u = this.state.utterance(utteranceId);
    if (!u) return;
    const open = this.state.unresolvedImportant(0.5);
    const gap: Gap = {
      id: newId('gap'),
      sessionId: this.session.id,
      type: 'REASONING',
      reason: 'UNSUPPORTED_INFERENCE',
      status: 'OPEN',
      triggerUtteranceId: utteranceId,
      contextUtteranceIds: [premiseId, utteranceId],
      trigger: u.text,
      interpretedQuestion: text,
      relevanceToObjective: 0.6,
      researchable: false,
      priority: open.length ? 0.5 : 0.42,
      evidence: [],
      timing: { triggerAt: u.at, detectedAt: now, qualifiedAt: now },
      decisionLog: [{ at: now, note: 'feasibility → commitment without the intermediate step' }],
      userActions: [],
      feedback: [],
      relatedGapIds: open.slice(0, 2).map((g) => g.id),
    };
    gap.interventionText = `Technical feasibility appears established, but that alone doesn't show it's worth doing — e.g. whether the need is strong enough.${
      open.length ? ` Still open: ${open.slice(0, 2).map((g) => `“${truncate(g.interpretedQuestion, 80)}”`).join('; ')}.` : ''
    }`;
    this.state.gaps.set(gap.id, gap);
    this.lastReasoningAt = now;
    this.emitGap(gap);
    // A reasoning observation is only useful in the moment; it never waits in the queue.
    this.policy.offer({ gapId: gap.id, kind: 'REASONING', priority: gap.priority, text: gap.interventionText, offeredAt: now, expiresAt: now + 15_000 });
  }

  private onMaterialClaim(utteranceId: string, claim: string, why: string): void {
    const u = this.state.utterance(utteranceId);
    if (!u) return;
    const now = this.clock.now();
    const gap: Gap = {
      id: newId('gap'),
      sessionId: this.session.id,
      type: 'EVIDENCE',
      reason: 'UNSUPPORTED_MATERIAL_CLAIM',
      status: 'OPEN',
      triggerUtteranceId: utteranceId,
      contextUtteranceIds: this.contextIds(u),
      trigger: u.text,
      interpretedQuestion: claim,
      relevanceToObjective: 0.7,
      researchable: false,
      priority: 0.42,
      evidence: [],
      timing: { triggerAt: u.at, detectedAt: now, qualifiedAt: now },
      decisionLog: [{ at: now, note: why }],
      userActions: [],
      feedback: [],
    };
    gap.interventionText = `“${truncate(claim, 120)}” matters to the objective, but no evidence has been offered for it yet.`;
    this.state.gaps.set(gap.id, gap);
    this.emitGap(gap);
    this.policy.offer({ gapId: gap.id, kind: 'EVIDENCE', priority: gap.priority, text: gap.interventionText, offeredAt: now, expiresAt: now + 60_000 });
  }

  // ───────────────────────────── surfacing ─────────────────────────────

  activeCount(): number {
    const now = this.clock.now();
    return [...this.state.gaps.values()].filter(
      (g) =>
        g.timing.surfacedAt &&
        now - g.timing.surfacedAt < this.cfg.activeTtlMs &&
        !g.userActions.some((a) => a.action === 'USE' || a.action === 'DISMISS' || a.action === 'MARK_RESOLVED'),
    ).length;
  }

  private flushPolicy(): void {
    const now = this.clock.now();
    for (const d of this.policy.flush(now, this.activeCount())) {
      const gap = this.state.gaps.get(d.candidate.gapId);
      if (!gap) continue;
      if (d.decision === 'DROP') {
        gap.decisionLog.push({ at: now, note: `not surfaced: ${d.reason}` });
        this.emitGap(gap);
      }
      if (d.decision !== 'SURFACE') continue;
      gap.timing.surfacedAt = now;
      gap.topicLiveAtSurface = this.topicLive(gap);
      gap.timingMode = this.surfaceMode(gap);
      gap.interventionText = gap.type === 'KNOWLEDGE' ? this.knowledgeText(gap) : d.candidate.text;
      d.candidate.text = gap.interventionText;
      gap.decisionLog.push({ at: now, note: `surfaced (${d.reason})` });
      const intervention: Intervention = { gapId: gap.id, kind: gap.type, priority: d.candidate.priority, text: d.candidate.text, surfacedAt: now };
      this.state.interventions.push(intervention);
      this.note(`surfaced ${gap.type.toLowerCase()}: ${truncate(d.candidate.text, 80)}`);
      this.emit({ type: 'intervention', intervention, gap });
      this.emitGap(gap);
    }
  }

  private topicLive(gap: Gap): boolean {
    if (gap.type !== 'KNOWLEDGE') return true;
    const q = termSet(gap.interpretedQuestion);
    return this.state.recent(4).some((u) => coverage(q, termSet(u.text)) >= 0.25);
  }

  // ───────────────────────────── user actions ─────────────────────────────

  act(gapId: string, action: UserActionType): Gap {
    const gap = this.requireGap(gapId);
    const now = this.clock.now();
    gap.userActions.push({ action, at: now });
    switch (action) {
      case 'DISMISS':
        this.policy.withdraw(gap.id);
        if (gap.type !== 'KNOWLEDGE' || !gap.answer) gap.status = 'DISMISSED';
        gap.decisionLog.push({ at: now, note: 'dismissed by user' });
        break;
      case 'MARK_RESOLVED':
        this.policy.withdraw(gap.id);
        this.inflight.get(gap.id)?.controller.abort();
        gap.status = 'RESOLVED';
        gap.timing.resolvedAt = now;
        gap.decisionLog.push({ at: now, note: 'marked resolved by user' });
        break;
      case 'USE':
        if (gap.type === 'KNOWLEDGE' && gap.answer) gap.timing.resolvedAt ??= now;
        gap.decisionLog.push({ at: now, note: 'used by participants' });
        break;
      case 'RESEARCH_MORE':
        if (gap.type === 'KNOWLEDGE' || gap.type === 'EVIDENCE') {
          if (gap.type === 'EVIDENCE') gap.researchable = true;
          gap.type = gap.type === 'EVIDENCE' ? 'KNOWLEDGE' : gap.type;
          this.policy.withdraw(gap.id);
          gap.timing.surfacedAt = undefined;
          this.enqueueResearch(gap.id, 'deep');
        }
        break;
      case 'OPEN_SOURCE':
        break;
    }
    this.emitGap(gap);
    return gap;
  }

  flag(gapId: string, flag: FeedbackFlag): Gap {
    const gap = this.requireGap(gapId);
    if (!gap.feedback.some((f) => f.flag === flag)) gap.feedback.push({ flag, at: this.clock.now() });
    this.emitGap(gap);
    return gap;
  }

  /** A participant explicitly asks ThirdSeat to look something up (also measures detection misses). */
  ask(question: string, speaker = 'User'): Gap {
    const now = this.clock.now();
    const u = this.ingestSilently(speaker, question);
    const gap: Gap = {
      id: newId('gap'),
      sessionId: this.session.id,
      type: 'KNOWLEDGE',
      reason: 'USER_REQUESTED',
      status: 'DETECTED',
      triggerUtteranceId: u.id,
      contextUtteranceIds: this.contextIds(u),
      trigger: question,
      interpretedQuestion: question.trim(),
      relevanceToObjective: 0.8,
      researchable: true,
      priority: 1,
      evidence: [],
      timing: { triggerAt: now, detectedAt: now, qualifiedAt: now },
      decisionLog: [{ at: now, note: 'requested directly by a participant' }],
      userActions: [],
      feedback: [],
    };
    this.state.gaps.set(gap.id, gap);
    this.emitGap(gap);
    this.enqueueResearch(gap.id, 'normal');
    return gap;
  }

  private ingestSilently(speaker: string, text: string): Utterance {
    // Stored for context but not analysed (it is a request to the assistant, not conversation).
    const u: Utterance = { id: newId('u'), sessionId: this.session.id, speaker: `${speaker} → ThirdSeat`, text, at: this.clock.now(), seq: this.seq };
    this.state.addUtterance(u);
    return u;
  }

  private requireGap(id: string): Gap {
    const g = this.state.gaps.get(id);
    if (!g) throw new Error(`unknown gap ${id}`);
    return g;
  }

  /** Stop research and timers. Transcript stays in memory until the session is deleted. */
  stop(): void {
    for (const { controller } of this.inflight.values()) controller.abort();
    this.researchQueue = [];
  }
}
