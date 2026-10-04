// Core domain model. Deliberately generic: nothing here knows what kind of meeting it is.

export type Millis = number;

export interface Utterance {
  id: string;
  sessionId: string;
  speaker: string;
  text: string;
  at: Millis;
  seq: number;
}

export const GAP_TYPES = [
  'KNOWLEDGE',
  'EVIDENCE',
  'CONTEXT',
  'OPEN_THREAD',
  'REASONING',
  'DECISION',
  'DRIFT',
] as const;
export type GapType = (typeof GAP_TYPES)[number];

export const GAP_STATUSES = [
  'DETECTED',
  'RESEARCHING',
  'OPEN',
  'RESOLVED',
  'PARTIALLY_RESOLVED',
  'UNRESOLVED',
  'NATURALLY_RESOLVED',
  'DISMISSED',
  'NOT_A_GAP',
] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export const DETECTION_REASONS = [
  'QUESTION_RAISED',
  'EXPLICIT_UNANSWERED_QUESTION',
  'DEFERRED_FOR_LATER',
  'LOW_CONFIDENCE_HUMAN_RESPONSE',
  'IMPORTANT_OPEN_THREAD',
  'OBJECTIVE_BLOCKER',
  'MATERIAL_OBJECTIVE_DRIFT',
  'CONCLUSION_WITH_OPEN_BLOCKERS',
  'UNSUPPORTED_INFERENCE',
  'UNSUPPORTED_MATERIAL_CLAIM',
  'USER_REQUESTED',
] as const;
export type DetectionReason = (typeof DETECTION_REASONS)[number];

/** Confidence in a researched answer. Describes sourcing quality, not truth. */
export type Confidence = 'HIGH' | 'LIKELY' | 'UNVERIFIED';

/**
 * When ThirdSeat contributes, relative to the humans:
 * PROACTIVE   — before anyone signalled a gap (answer ready, nobody answered; tentative claim checked; drift).
 * REACTIVE    — in response to a human signal ("not sure", "let's check later", "I think so").
 * RETROACTIVE — returning to something after the conversation moved on (late answer, dropped thread, open items at a conclusion).
 */
export type TimingMode = 'PROACTIVE' | 'REACTIVE' | 'RETROACTIVE';
export const TIMING_MODES: TimingMode[] = ['PROACTIVE', 'REACTIVE', 'RETROACTIVE'];

export type ResearchOutcomeKind = 'RESOLVED' | 'PARTIALLY_RESOLVED' | 'UNRESOLVED';

/** Configurable ranking of where evidence came from (lower rank = more authoritative). */
export type SourceTier =
  | 'conversation'
  | 'official_docs'
  | 'official_support'
  | 'reliable_technical'
  | 'general_web'
  | 'user_supplied';

export interface Evidence {
  id: string;
  toolId: string;
  sourceTier: SourceTier;
  title: string;
  url?: string;
  excerpt: string;
  score: number;
  retrievedAt: Millis;
}

export type UserActionType = 'USE' | 'DISMISS' | 'OPEN_SOURCE' | 'RESEARCH_MORE' | 'MARK_RESOLVED';
export const USER_ACTIONS: UserActionType[] = ['USE', 'DISMISS', 'OPEN_SOURCE', 'RESEARCH_MORE', 'MARK_RESOLVED'];

export type FeedbackFlag = 'INCORRECT' | 'FALSE_POSITIVE' | 'SAVED_FOLLOW_UP' | 'HELPED_CONCLUSION' | 'TOO_LATE';
export const FEEDBACK_FLAGS: FeedbackFlag[] = ['INCORRECT', 'FALSE_POSITIVE', 'SAVED_FOLLOW_UP', 'HELPED_CONCLUSION', 'TOO_LATE'];

export interface GapTiming {
  /** When the triggering utterance was spoken. TIME_TO_USEFUL_INTERVENTION is measured from here. */
  triggerAt: Millis;
  detectedAt: Millis;
  qualifiedAt?: Millis;
  researchStartedAt?: Millis;
  firstEvidenceAt?: Millis;
  answeredAt?: Millis;
  surfacedAt?: Millis;
  resolvedAt?: Millis;
}

export interface DecisionNote {
  at: Millis;
  /** Concise, human-readable reason. Never raw model reasoning. */
  note: string;
}

export interface Gap {
  id: string;
  sessionId: string;
  type: GapType;
  reason: DetectionReason;
  status: GapStatus;
  triggerUtteranceId: string;
  /** Ids of the utterances that make up the relevant transcript context. */
  contextUtteranceIds: string[];
  /** Short trigger text for display (the question or claim as spoken). */
  trigger: string;
  interpretedQuestion: string;
  relevanceToObjective: number;
  researchable: boolean;
  priority: number;
  confidence?: Confidence;
  evidence: Evidence[];
  answer?: string;
  caveat?: string;
  interventionText?: string;
  /** Whether the topic that raised the gap was still being discussed when surfaced. */
  topicLiveAtSurface?: boolean;
  timing: GapTiming;
  researchDurationMs?: number;
  decisionLog: DecisionNote[];
  userActions: { action: UserActionType; at: Millis }[];
  feedback: { flag: FeedbackFlag; at: Millis }[];
  /** How this contribution relates in time to the humans (set when surfaced; see TimingMode). */
  timingMode?: TimingMode;
  /**
   * Research started the moment the question was asked, before it qualified as a gap. Hidden from the
   * UI and not counted as a gap until it qualifies; discarded if the humans answer it themselves.
   */
  speculative?: boolean;
  /** Asked openly to everyone ("does anyone know…"): an answer is welcome as soon as it is ready. */
  askedToRoom?: boolean;
  /** Outcome of research finished while still speculative (applied if/when the gap qualifies). */
  prefetchOutcome?: ResearchOutcomeKind;
  /** Last time the humans were seen discussing this item (suppresses recall). */
  lastDiscussedAt?: Millis;
  /** Items listed by drift / conclusion interventions. */
  relatedGapIds?: string[];
}

export interface Intervention {
  gapId: string;
  kind: GapType;
  priority: number;
  text: string;
  surfacedAt: Millis;
}

export interface SessionConfig {
  objective?: string;
  /** URLs and documents the session may research in (user-supplied sources). */
  sourceUrls: string[];
}

export interface Session {
  id: string;
  createdAt: Millis;
  title: string;
  config: SessionConfig;
  endedAt?: Millis;
}
