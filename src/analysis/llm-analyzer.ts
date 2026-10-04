// LLM-based conversation analyzer. Same signal contract as the heuristic analyzer, but with real
// language understanding: paraphrased uncertainty, standalone question rewriting, objective relevance.
// Receives compact state + recent window only — never the full transcript.

import type { LlmClient } from '../llm/client.ts';
import type { AnalysisInput, AnalysisOutput, ConversationAnalyzer, QuestionKind, ResponseKind } from './types.ts';

const SYSTEM = `You are the listening component of ThirdSeat, an assistant present in a live conversation.
ThirdSeat does not take notes or summarise. Its job is to notice gaps that stop the people from progressing toward their objective, so another component can help close them while the conversation is still happening.

You receive: the session objective (may be null), compact state, OPEN QUESTIONS already being tracked (with ids), a little earlier context, and NEW utterances (with ids). Emit signals ONLY for the NEW utterances. Precision matters far more than recall: most utterances produce no signals at all.

Signals:
- questions: a NEW utterance raises a question that matters to the discussion.
  kind FACTUAL = has a knowable answer; STRATEGIC = important judgement question bearing on the objective (e.g. "why would customers choose this?"); DECISION = the group deciding what to do; SOCIAL = rhetorical/conversational (omit these).
  interpreted_question: rewrite as a standalone question (resolve pronouns from context). researchable: true only if it can be answered from public sources (vendor docs, standards, public facts), false if it is about the group's own situation.
  relevance: 0..1 relevance to the objective. addressed_to_room: true if asked openly to everyone ("does anyone know…").
  origin "tentative_claim": a NEW utterance states a checkable fact about something external tentatively ("I think Teams exposes live transcripts to apps") — emit it as a FACTUAL question ("Does Teams expose live transcripts to apps?") so it can be verified without anyone asking. Otherwise origin "question".
- responses: a NEW utterance responds to an open question or to a question raised earlier in this batch (target_id = open question id, or the utterance id of the question).
  CONFIDENT_ANSWER = specific, credible answer; WEAK_ANSWER = tentative ("I think so", "probably"); UNCERTAIN = they don't know; DEFERRAL = pushed to later ("let's check after the meeting"); ACKNOWLEDGE = acknowledged without answering ("good point"). The asker saying they don't know also counts as UNCERTAIN.
- thread_activity: a NEW utterance picks up a tracked STRATEGIC question again. DISCUSSING = engaging with it; ADDRESSED = the group reached a credible answer.
- statements: FACT = something established that later questions may rely on; ASSUMPTION = explicitly assumed. Keep them short. Only notable ones.
- conclusion_signals: the group is trying to conclude/decide overall ("so where does that leave us?").
- commitment_signals: the group is making decisions or commitments (scope, pricing, choosing an option, committing to build).
- reasoning: ONLY a clear, consequential leap where a conclusion is drawn from a premise that does not support it (e.g. "technically possible" → "so we should build it"). Be very conservative. text = one neutral sentence naming the missing step.
- claims: ONLY an unsupported claim that is material to the objective and stated as certain (e.g. "customers will definitely pay"). Be very conservative; never flag opinions in general.
- topic_relatedness: 0..1 how related the NEW utterances are to the objective and its open items (1 if no objective). topic_label: 2-5 words.

Never include reasoning prose. Notes are at most 12 words.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions', 'responses', 'thread_activity', 'statements', 'conclusion_signals', 'commitment_signals', 'reasoning', 'claims', 'topic_relatedness', 'topic_label'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['utterance_id', 'kind', 'interpreted_question', 'researchable', 'relevance', 'note', 'addressed_to_room', 'origin'],
        properties: {
          utterance_id: { type: 'string' },
          kind: { type: 'string', enum: ['FACTUAL', 'STRATEGIC', 'DECISION', 'SOCIAL'] },
          interpreted_question: { type: 'string' },
          researchable: { type: 'boolean' },
          relevance: { type: 'number' },
          note: { type: 'string' },
          addressed_to_room: { type: 'boolean' },
          origin: { type: 'string', enum: ['question', 'tentative_claim'] },
        },
      },
    },
    responses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['utterance_id', 'target_id', 'kind', 'note'],
        properties: {
          utterance_id: { type: 'string' },
          target_id: { type: 'string' },
          kind: { type: 'string', enum: ['CONFIDENT_ANSWER', 'WEAK_ANSWER', 'UNCERTAIN', 'DEFERRAL', 'ACKNOWLEDGE'] },
          note: { type: 'string' },
        },
      },
    },
    thread_activity: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['utterance_id', 'target_id', 'kind', 'note'],
        properties: {
          utterance_id: { type: 'string' },
          target_id: { type: 'string' },
          kind: { type: 'string', enum: ['DISCUSSING', 'ADDRESSED'] },
          note: { type: 'string' },
        },
      },
    },
    statements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['utterance_id', 'kind', 'text'],
        properties: { utterance_id: { type: 'string' }, kind: { type: 'string', enum: ['FACT', 'ASSUMPTION'] }, text: { type: 'string' } },
      },
    },
    conclusion_signals: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['utterance_id', 'note'], properties: { utterance_id: { type: 'string' }, note: { type: 'string' } } },
    },
    commitment_signals: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['utterance_id', 'note'], properties: { utterance_id: { type: 'string' }, note: { type: 'string' } } },
    },
    reasoning: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['utterance_id', 'premise_utterance_id', 'text'],
        properties: { utterance_id: { type: 'string' }, premise_utterance_id: { type: 'string' }, text: { type: 'string' } },
      },
    },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['utterance_id', 'claim', 'note'],
        properties: { utterance_id: { type: 'string' }, claim: { type: 'string' }, note: { type: 'string' } },
      },
    },
    topic_relatedness: { type: 'number' },
    topic_label: { type: 'string' },
  },
};

interface RawOutput {
  questions: { utterance_id: string; kind: QuestionKind; interpreted_question: string; researchable: boolean; relevance: number; note: string; addressed_to_room: boolean; origin: 'question' | 'tentative_claim' }[];
  responses: { utterance_id: string; target_id: string; kind: ResponseKind; note: string }[];
  thread_activity: { utterance_id: string; target_id: string; kind: 'DISCUSSING' | 'ADDRESSED'; note: string }[];
  statements: { utterance_id: string; kind: 'FACT' | 'ASSUMPTION'; text: string }[];
  conclusion_signals: { utterance_id: string; note: string }[];
  commitment_signals: { utterance_id: string; note: string }[];
  reasoning: { utterance_id: string; premise_utterance_id: string; text: string }[];
  claims: { utterance_id: string; claim: string; note: string }[];
  topic_relatedness: number;
  topic_label: string;
}

const clamp = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0.5));

export class LlmAnalyzer implements ConversationAnalyzer {
  readonly id: string;
  private llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
    this.id = `llm(${llm.id})`;
  }

  buildPrompt(input: AnalysisInput): string {
    const first = input.newUtterances[0]?.seq ?? 0;
    const earlier = input.state.transcript.filter((u) => u.seq < first).slice(-8);
    const fmt = (u: { id: string; speaker: string; text: string }) => `[${u.id}] ${u.speaker}: ${u.text}`;
    return [
      `STATE:\n${JSON.stringify(input.state.compactView())}`,
      `OPEN QUESTIONS:\n${input.openQuestions.length ? input.openQuestions.map((q) => `[${q.id}] (${q.kind}, asked by ${q.askedBy}, ${q.utterancesSince} utterances ago) ${q.question}`).join('\n') : '(none)'}`,
      `EARLIER CONTEXT (do not emit signals for these):\n${earlier.map(fmt).join('\n') || '(none)'}`,
      `NEW UTTERANCES:\n${input.newUtterances.map(fmt).join('\n')}`,
    ].join('\n\n');
  }

  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    const raw = await this.llm.json<RawOutput>({
      system: SYSTEM,
      user: this.buildPrompt(input),
      schema: SCHEMA,
      maxTokens: 3000,
      effort: 'low',
      signal: input.signal,
    });
    // Validate references: drop anything that points at ids we never gave the model.
    const newIds = new Set(input.newUtterances.map((u) => u.id));
    const targets = new Set([...input.openQuestions.map((q) => q.id), ...newIds]);
    return {
      questions: raw.questions
        .filter((q) => newIds.has(q.utterance_id) && q.kind !== 'SOCIAL' && q.interpreted_question.trim())
        .map((q) => ({
          utteranceId: q.utterance_id,
          kind: q.kind,
          interpretedQuestion: q.interpreted_question.trim(),
          researchable: q.kind === 'FACTUAL' && q.researchable,
          relevance: clamp(q.relevance),
          note: q.note,
          openToRoom: q.addressed_to_room,
          origin: q.origin === 'tentative_claim' ? ('tentative_claim' as const) : ('question' as const),
        })),
      responses: raw.responses
        .filter((r) => newIds.has(r.utterance_id) && targets.has(r.target_id))
        .map((r) => ({ utteranceId: r.utterance_id, targetId: r.target_id, kind: r.kind, note: r.note })),
      threadActivity: raw.thread_activity
        .filter((t) => newIds.has(t.utterance_id) && targets.has(t.target_id))
        .map((t) => ({ utteranceId: t.utterance_id, targetId: t.target_id, kind: t.kind, note: t.note })),
      statements: raw.statements.filter((s) => newIds.has(s.utterance_id)).map((s) => ({ utteranceId: s.utterance_id, kind: s.kind, text: s.text })),
      conclusionSignals: raw.conclusion_signals.filter((c) => newIds.has(c.utterance_id)).map((c) => ({ utteranceId: c.utterance_id, note: c.note })),
      commitmentSignals: raw.commitment_signals.filter((c) => newIds.has(c.utterance_id)).map((c) => ({ utteranceId: c.utterance_id, note: c.note })),
      reasoning: raw.reasoning
        .filter((r) => newIds.has(r.utterance_id) && input.state.utterance(r.premise_utterance_id))
        .map((r) => ({ utteranceId: r.utterance_id, premiseUtteranceId: r.premise_utterance_id, text: r.text })),
      claims: raw.claims.filter((c) => newIds.has(c.utterance_id)).map((c) => ({ utteranceId: c.utterance_id, claim: c.claim, note: c.note })),
      topicRelatedness: input.state.objective ? clamp(raw.topic_relatedness) : undefined,
      topicLabel: raw.topic_label,
    };
  }
}
