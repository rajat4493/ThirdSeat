// Turning evidence into an answer — or honestly declining to.

import type { Confidence, Evidence } from '../domain/types.ts';
import { truncate } from '../domain/text.ts';
import { capConfidence, isAuthoritative, TIER_WEIGHT } from '../evidence/source-ranking.ts';
import type { LlmClient } from '../llm/client.ts';
import type { AnswerSynthesizer, DraftAnswer, ResearchOutcome, SynthesizedAnswer } from './types.ts';

export function outcomeFor(c: Confidence): ResearchOutcome {
  return c === 'HIGH' ? 'RESOLVED' : c === 'LIKELY' ? 'PARTIALLY_RESOLVED' : 'UNRESOLVED';
}

/**
 * No-LLM synthesizer. Quotes the best-ranked passage. It cannot verify that the passage actually
 * answers the question, so it never claims HIGH confidence.
 */
export class ExtractiveSynthesizer implements AnswerSynthesizer {
  readonly id = 'extractive';
  minScore: number;
  constructor(minScore = 0.6) {
    this.minScore = minScore;
  }

  async synthesize(input: { question: string; evidence: Evidence[] }): Promise<SynthesizedAnswer> {
    const ranked = [...input.evidence].sort((a, b) => b.score * TIER_WEIGHT[b.sourceTier] - a.score * TIER_WEIGHT[a.sourceTier]);
    const best = ranked[0];
    if (!best || best.score < this.minScore) {
      return {
        outcome: 'UNRESOLVED',
        confidence: 'UNVERIFIED',
        usedEvidenceIds: [],
        note: best ? `best passage too weak (score ${best.score})` : 'no evidence retrieved',
      };
    }
    if (best.sourceTier === 'conversation') {
      return {
        outcome: 'PARTIALLY_RESOLVED',
        confidence: 'LIKELY',
        answer: `Already said earlier in this conversation: ${best.excerpt}`,
        usedEvidenceIds: [best.id],
        note: 'matched an earlier established answer',
      };
    }
    const authoritative = isAuthoritative(best.sourceTier) || best.sourceTier === 'user_supplied';
    const also = ranked.slice(1).find((e) => e.score >= this.minScore && e.url !== best.url);
    // Lexical matching can find the right page but cannot confirm the passage answers the question,
    // so the confidence is always UNVERIFIED. Only authoritative sources are offered at all.
    return {
      outcome: authoritative ? 'PARTIALLY_RESOLVED' : 'UNRESOLVED',
      confidence: 'UNVERIFIED',
      answer: authoritative ? `Possibly relevant — ${best.title}: “${truncate(best.excerpt, 280)}”` : undefined,
      caveat: 'Passage matched by keywords only (no AI verification that it answers the question). Open the source to confirm.',
      usedEvidenceIds: also ? [best.id, also.id] : [best.id],
      note: authoritative ? `keyword match in ${best.sourceTier} source (unverified)` : `match only in ${best.sourceTier} source`,
    };
  }
}

const SYNTH_SYSTEM = `You turn retrieved evidence into a short answer for people in a live discussion.
Rules: use ONLY the numbered evidence. If it does not answer the question, set answerable=false. Do not use outside knowledge.
Answer in at most 2 sentences, stating conditions and limitations. confidence: HIGH only if an official/primary source directly answers; LIKELY if supported but partial or indirect; UNVERIFIED otherwise.
evidence_ids must list the ids you relied on.`;

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answerable', 'answer', 'confidence', 'evidence_ids', 'caveat'],
  properties: {
    answerable: { type: 'boolean' },
    answer: { type: 'string' },
    confidence: { type: 'string', enum: ['HIGH', 'LIKELY', 'UNVERIFIED'] },
    evidence_ids: { type: 'array', items: { type: 'string' } },
    caveat: { type: 'string' },
  },
};

export class LlmSynthesizer implements AnswerSynthesizer {
  readonly id = 'llm';
  private llm: LlmClient;
  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async synthesize(input: { question: string; context: string[]; evidence: Evidence[]; signal: AbortSignal }): Promise<SynthesizedAnswer> {
    if (input.evidence.length === 0) return { outcome: 'UNRESOLVED', confidence: 'UNVERIFIED', usedEvidenceIds: [], note: 'no evidence retrieved' };
    const evidenceText = input.evidence
      .slice(0, 10)
      .map((e) => `[${e.id}] (${e.sourceTier}) ${e.title}${e.url ? ` <${e.url}>` : ''}\n${e.excerpt}`)
      .join('\n\n');
    const r = await this.llm.json<{ answerable: boolean; answer: string; confidence: Confidence; evidence_ids: string[]; caveat: string }>({
      system: SYNTH_SYSTEM,
      user: `Question: ${input.question}\n\nConversation context:\n${input.context.join('\n')}\n\nEvidence:\n${evidenceText}`,
      schema: SYNTH_SCHEMA,
      maxTokens: 1500,
      effort: 'low',
      signal: input.signal,
    });
    const used = r.evidence_ids.filter((id) => input.evidence.some((e) => e.id === id));
    if (!r.answerable || used.length === 0 || !r.answer.trim()) {
      return { outcome: 'UNRESOLVED', confidence: 'UNVERIFIED', usedEvidenceIds: [], note: 'evidence did not answer the question' };
    }
    const confidence = capConfidence(r.confidence, input.evidence.filter((e) => used.includes(e.id)));
    return {
      outcome: outcomeFor(confidence),
      confidence,
      answer: r.answer.trim(),
      caveat: r.caveat?.trim() || undefined,
      usedEvidenceIds: used,
      note: `answer grounded in ${used.length} evidence item(s)`,
    };
  }
}

/** Prefer a tool's cited draft; otherwise synthesize with the LLM if available; otherwise extract. */
export function chooseDraft(drafts: DraftAnswer[], evidence: Evidence[]): SynthesizedAnswer | undefined {
  const rank: Record<Confidence, number> = { HIGH: 2, LIKELY: 1, UNVERIFIED: 0 };
  const usable = drafts
    .map((d) => ({ d, ev: evidence.filter((e) => d.citedEvidenceIds.includes(e.id)) }))
    .filter((x) => x.ev.length > 0)
    .sort((a, b) => rank[b.d.confidence] - rank[a.d.confidence]);
  const best = usable[0];
  if (!best) return undefined;
  const confidence = capConfidence(best.d.confidence, best.ev);
  return {
    outcome: outcomeFor(confidence),
    confidence,
    answer: confidence === 'UNVERIFIED' ? undefined : best.d.answer,
    caveat: confidence === 'UNVERIFIED' ? best.d.answer : best.d.caveat,
    usedEvidenceIds: best.ev.map((e) => e.id),
    note: `cited draft from research tool (${best.ev.length} citation(s))`,
  };
}
