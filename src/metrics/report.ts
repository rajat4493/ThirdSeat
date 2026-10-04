// Session metrics for product validation. Counts what happened; never invents outcomes.
// System-inferred and human-confirmed values are kept separate.

import { TIMING_MODES, type Gap, type GapType, type TimingMode } from '../domain/types.ts';
import type { GapEngine } from '../gaps/engine.ts';

export interface LatencyStats {
  n: number;
  medianMs?: number;
  p90Ms?: number;
  maxMs?: number;
}

function stats(values: number[]): LatencyStats {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0 };
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
  return { n: v.length, medianMs: q(0.5), p90Ms: q(0.9), maxMs: v.at(-1) };
}

export interface GapSummary {
  id: string;
  type: GapType;
  reason: string;
  status: string;
  question: string;
  answer?: string;
  confidence?: string;
  sources: { title: string; url?: string; tier: string }[];
  surfaced: boolean;
  timingMode?: TimingMode;
  topicLiveAtSurface?: boolean;
  timeToInterventionMs?: number;
  researchDurationMs?: number;
  timeToFirstEvidenceMs?: number;
  userActions: string[];
  feedback: string[];
  decisionLog: string[];
}

export interface SessionReport {
  sessionId: string;
  title: string;
  objective?: string;
  generatedAt: number;
  durationMs: number;
  utterances: number;
  analyzer: string;
  researchTools: string[];
  metrics: {
    meaningfulGapsDetected: number;
    knowledgeGapsDetected: number;
    gapsResolvedDuringSession: number;
    partiallyResolved: number;
    unresolved: number;
    naturallyResolved: number;
    stillOpen: number;
    openThreadsTracked: number;
    unresolvedQuestionsRecovered: number;
    interventionsSurfaced: number;
    interventionsUsed: number;
    interventionsDismissed: number;
    falsePositivesFlagged: number;
    incorrectAnswersFlagged: number;
    tooLateFlagged: number;
    followUpsPotentiallyAvoided: number;
    followUpsConfirmedAvoided: number;
    helpedConclusionConfirmed: number;
    driftInterventions: number;
    conclusionInterventions: number;
    reasoningInterventions: number;
    userRequestedLookups: number;
    surfacedWhileTopicLive: number;
  };
  /** How contributions related in time to the humans: before a gap was signalled, in response, or returning later. */
  timing: Record<TimingMode, { surfaced: number; used: number; dismissed: number; timeToIntervention: LatencyStats }>;
  latency: {
    timeToUsefulIntervention: LatencyStats;
    research: LatencyStats;
    timeToFirstEvidence: LatencyStats;
    detectionToQualification: LatencyStats;
  };
  gaps: GapSummary[];
  humanValidation?: Record<string, string>;
}

const has = (g: Gap, a: string) => g.userActions.some((x) => x.action === a);
const flagged = (g: Gap, f: string) => g.feedback.some((x) => x.flag === f);

export function buildReport(engine: GapEngine, opts: { analyzer: string; tools: string[]; now: number; humanValidation?: Record<string, string> }): SessionReport {
  // Questions researched ahead of time that never qualified are not gaps.
  const gaps = [...engine.state.gaps.values()].filter((g) => !g.speculative);
  const surfaced = gaps.filter((g) => g.timing.surfacedAt);
  const knowledge = gaps.filter((g) => g.type === 'KNOWLEDGE');
  const tti = surfaced.filter((g) => g.type === 'KNOWLEDGE').map((g) => g.timing.surfacedAt! - g.timing.triggerAt);
  const first = engine.state.transcript[0]?.at ?? engine.session.createdAt;
  const last = engine.state.transcript.at(-1)?.at ?? opts.now;

  return {
    sessionId: engine.session.id,
    title: engine.session.title,
    objective: engine.state.objective,
    generatedAt: opts.now,
    durationMs: last - first,
    utterances: engine.state.transcript.length,
    analyzer: opts.analyzer,
    researchTools: opts.tools,
    metrics: {
      meaningfulGapsDetected: gaps.filter((g) => g.reason !== 'QUESTION_RAISED' && g.status !== 'NOT_A_GAP').length,
      knowledgeGapsDetected: knowledge.filter((g) => g.reason !== 'QUESTION_RAISED').length,
      gapsResolvedDuringSession: knowledge.filter((g) => g.status === 'RESOLVED').length,
      partiallyResolved: knowledge.filter((g) => g.status === 'PARTIALLY_RESOLVED').length,
      unresolved: knowledge.filter((g) => g.status === 'UNRESOLVED').length,
      naturallyResolved: gaps.filter((g) => g.status === 'NATURALLY_RESOLVED').length,
      stillOpen: gaps.filter((g) => ['OPEN', 'DETECTED', 'RESEARCHING', 'UNRESOLVED'].includes(g.status) && ['KNOWLEDGE', 'OPEN_THREAD', 'EVIDENCE'].includes(g.type)).length,
      openThreadsTracked: gaps.filter((g) => g.type === 'OPEN_THREAD').length,
      unresolvedQuestionsRecovered:
        gaps.filter((g) => g.type === 'OPEN_THREAD' && g.timing.surfacedAt).length +
        gaps.filter((g) => (g.type === 'DECISION' || g.type === 'DRIFT') && g.timing.surfacedAt).reduce((s, g) => s + (g.relatedGapIds?.length ?? 0), 0),
      interventionsSurfaced: surfaced.length,
      interventionsUsed: surfaced.filter((g) => has(g, 'USE')).length,
      interventionsDismissed: surfaced.filter((g) => has(g, 'DISMISS')).length,
      falsePositivesFlagged: gaps.filter((g) => flagged(g, 'FALSE_POSITIVE')).length,
      incorrectAnswersFlagged: gaps.filter((g) => flagged(g, 'INCORRECT')).length,
      tooLateFlagged: gaps.filter((g) => flagged(g, 'TOO_LATE')).length,
      // Inferred: a deferred question that was answered during the session would otherwise have been follow-up work.
      followUpsPotentiallyAvoided: knowledge.filter((g) => g.reason === 'DEFERRED_FOR_LATER' && ['RESOLVED', 'PARTIALLY_RESOLVED'].includes(g.status) && g.timing.surfacedAt).length,
      followUpsConfirmedAvoided: gaps.filter((g) => flagged(g, 'SAVED_FOLLOW_UP')).length,
      helpedConclusionConfirmed: gaps.filter((g) => flagged(g, 'HELPED_CONCLUSION')).length,
      driftInterventions: surfaced.filter((g) => g.type === 'DRIFT').length,
      conclusionInterventions: surfaced.filter((g) => g.type === 'DECISION').length,
      reasoningInterventions: surfaced.filter((g) => g.type === 'REASONING').length,
      userRequestedLookups: gaps.filter((g) => g.reason === 'USER_REQUESTED').length,
      surfacedWhileTopicLive: surfaced.filter((g) => g.topicLiveAtSurface).length,
    },
    timing: Object.fromEntries(
      TIMING_MODES.map((m) => {
        const s = surfaced.filter((g) => g.timingMode === m);
        return [m, { surfaced: s.length, used: s.filter((g) => has(g, 'USE')).length, dismissed: s.filter((g) => has(g, 'DISMISS')).length, timeToIntervention: stats(s.map((g) => g.timing.surfacedAt! - g.timing.triggerAt)) }];
      }),
    ) as SessionReport['timing'],
    latency: {
      timeToUsefulIntervention: stats(tti),
      research: stats(knowledge.map((g) => g.researchDurationMs ?? NaN)),
      timeToFirstEvidence: stats(knowledge.filter((g) => g.timing.firstEvidenceAt && g.timing.researchStartedAt).map((g) => g.timing.firstEvidenceAt! - g.timing.researchStartedAt!)),
      detectionToQualification: stats(knowledge.filter((g) => g.timing.qualifiedAt).map((g) => g.timing.qualifiedAt! - g.timing.triggerAt)),
    },
    gaps: gaps.map(summarise),
    humanValidation: opts.humanValidation,
  };
}

export function summarise(g: Gap): GapSummary {
  return {
    id: g.id,
    type: g.type,
    reason: g.reason,
    status: g.status,
    question: g.interpretedQuestion,
    answer: g.answer,
    confidence: g.confidence,
    sources: g.evidence.slice(0, 4).map((e) => ({ title: e.title, url: e.url, tier: e.sourceTier })),
    surfaced: !!g.timing.surfacedAt,
    timingMode: g.timingMode,
    topicLiveAtSurface: g.topicLiveAtSurface,
    timeToInterventionMs: g.timing.surfacedAt ? g.timing.surfacedAt - g.timing.triggerAt : undefined,
    researchDurationMs: g.researchDurationMs,
    timeToFirstEvidenceMs: g.timing.firstEvidenceAt && g.timing.researchStartedAt ? g.timing.firstEvidenceAt - g.timing.researchStartedAt : undefined,
    userActions: g.userActions.map((a) => a.action),
    feedback: g.feedback.map((f) => f.flag),
    decisionLog: g.decisionLog.map((d) => d.note),
  };
}
