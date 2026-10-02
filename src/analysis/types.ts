// The analyzer turns new utterances into explainable signals. The GapEngine owns all decisions
// (qualification, research, intervention); analyzers only observe. This keeps heuristic and LLM
// analyzers interchangeable.

import type { ConversationState } from '../state/conversation-state.ts';
import type { Utterance } from '../domain/types.ts';

/**
 * FACTUAL   — has a knowable answer (researchable if about something outside the group).
 * STRATEGIC — important judgement question ("why would customers…"); not directly researchable.
 * DECISION  — the group deciding/committing ("should we…", "what do we charge…").
 * SOCIAL    — rhetorical / conversational; never a gap.
 */
export type QuestionKind = 'FACTUAL' | 'STRATEGIC' | 'DECISION' | 'SOCIAL';

export type ResponseKind =
  | 'CONFIDENT_ANSWER'
  | 'WEAK_ANSWER'
  | 'UNCERTAIN'
  | 'DEFERRAL'
  | 'ACKNOWLEDGE';

/** An open question the analyzer may attach responses to (a watch, a gap, or an open thread). */
export interface OpenQuestionView {
  id: string;
  question: string;
  askedBy: string;
  triggerUtteranceId: string;
  kind: QuestionKind;
  /** Number of utterances since it was asked. */
  utterancesSince: number;
}

export interface QuestionSignal {
  utteranceId: string;
  kind: QuestionKind;
  interpretedQuestion: string;
  /** External, publicly researchable. */
  researchable: boolean;
  /** 0..1 */
  relevance: number;
  note: string;
}

export interface ResponseSignal {
  utteranceId: string;
  /** Id of the OpenQuestionView this responds to, or the questionUtteranceId for a question raised in the same batch. */
  targetId: string;
  kind: ResponseKind;
  note: string;
}

export interface ThreadActivitySignal {
  utteranceId: string;
  targetId: string;
  kind: 'DISCUSSING' | 'ADDRESSED';
  note: string;
}

export interface StatementSignal {
  utteranceId: string;
  kind: 'FACT' | 'ASSUMPTION';
  text: string;
}

export interface ReasoningSignal {
  utteranceId: string;
  premiseUtteranceId: string;
  text: string;
}

export interface ClaimSignal {
  utteranceId: string;
  claim: string;
  note: string;
}

export interface AnalysisOutput {
  questions: QuestionSignal[];
  responses: ResponseSignal[];
  threadActivity: ThreadActivitySignal[];
  statements: StatementSignal[];
  conclusionSignals: { utteranceId: string; note: string }[];
  commitmentSignals: { utteranceId: string; note: string }[];
  reasoning: ReasoningSignal[];
  claims: ClaimSignal[];
  /** Optional: analyzer's own judgement of how related the recent discussion is to the objective (0..1). */
  topicRelatedness?: number;
  topicLabel?: string;
}

export interface AnalysisInput {
  state: ConversationState;
  newUtterances: Utterance[];
  openQuestions: OpenQuestionView[];
  signal?: AbortSignal;
}

export interface ConversationAnalyzer {
  readonly id: string;
  analyze(input: AnalysisInput): Promise<AnalysisOutput>;
}

export function emptyAnalysis(): AnalysisOutput {
  return {
    questions: [],
    responses: [],
    threadActivity: [],
    statements: [],
    conclusionSignals: [],
    commitmentSignals: [],
    reasoning: [],
    claims: [],
  };
}
