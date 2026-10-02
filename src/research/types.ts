import type { Confidence, Evidence, Gap } from '../domain/types.ts';
import type { ConversationState } from '../state/conversation-state.ts';

export interface ResearchRequest {
  gap: Gap;
  query: string;
  /** Short transcript snippets around the gap (not the whole transcript). */
  context: string[];
  objective?: string;
  state: ConversationState;
  /** "Research more" widens the search. */
  depth: 'normal' | 'deep';
  signal: AbortSignal;
}

export interface DraftAnswer {
  answer: string;
  confidence: Confidence;
  caveat?: string;
  citedEvidenceIds: string[];
}

export interface ToolResult {
  evidence: Evidence[];
  /** Tools that both retrieve and reason (e.g. LLM web search) may propose an answer. */
  draft?: DraftAnswer;
}

export interface ResearchTool {
  readonly id: string;
  readonly description: string;
  canHandle(gap: Gap): boolean;
  research(req: ResearchRequest): Promise<ToolResult>;
}

export type ResearchOutcome = 'RESOLVED' | 'PARTIALLY_RESOLVED' | 'UNRESOLVED';

export interface SynthesizedAnswer {
  outcome: ResearchOutcome;
  confidence: Confidence;
  answer?: string;
  caveat?: string;
  usedEvidenceIds: string[];
  note: string;
}

export interface AnswerSynthesizer {
  readonly id: string;
  synthesize(input: {
    question: string;
    context: string[];
    evidence: Evidence[];
    drafts: DraftAnswer[];
    signal: AbortSignal;
  }): Promise<SynthesizedAnswer>;
}
