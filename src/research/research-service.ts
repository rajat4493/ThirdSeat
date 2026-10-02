// Gap → planner → registry → tools → evidence → assessment → answer.

import type { Clock } from '../clock.ts';
import type { Evidence, Gap } from '../domain/types.ts';
import { namedEntities } from '../analysis/heuristic-analyzer.ts';
import type { ConversationState } from '../state/conversation-state.ts';
import type { ToolRegistry } from './registry.ts';
import { chooseDraft } from './synthesizers.ts';
import type { AnswerSynthesizer, DraftAnswer, SynthesizedAnswer } from './types.ts';

export interface ResearchRun {
  query: string;
  toolsUsed: string[];
  toolErrors: string[];
  evidence: Evidence[];
  answer: SynthesizedAnswer;
  firstEvidenceAt?: number;
  durationMs: number;
  aborted: boolean;
}

/** Turn an interpreted question into a standalone research query. */
export function planQuery(gap: Gap, state: ConversationState): string {
  const m = gap.interpretedQuestion.match(/^(.*?)\s*\(context: "(.*)"\)$/);
  if (!m) return gap.interpretedQuestion;
  const ents = namedEntities(m[2]).slice(0, 4);
  return ents.length ? `${m[1]} [about: ${ents.join(', ')}]` : `${m[1]} (${m[2]})`;
}

export function contextFor(gap: Gap, state: ConversationState): string[] {
  return gap.contextUtteranceIds
    .map((id) => state.utterance(id))
    .filter((u) => !!u)
    .map((u) => `${u.speaker}: ${u.text}`)
    .slice(-6);
}

export class ResearchService {
  private registry: ToolRegistry;
  private primary: AnswerSynthesizer;
  private fallback: AnswerSynthesizer;
  private clock: Clock;
  timeoutMs: number;

  constructor(opts: { registry: ToolRegistry; synthesizer: AnswerSynthesizer; fallbackSynthesizer: AnswerSynthesizer; clock: Clock; timeoutMs?: number }) {
    this.registry = opts.registry;
    this.primary = opts.synthesizer;
    this.fallback = opts.fallbackSynthesizer;
    this.clock = opts.clock;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async run(gap: Gap, state: ConversationState, depth: 'normal' | 'deep', signal: AbortSignal): Promise<ResearchRun> {
    const started = this.clock.now();
    const query = planQuery(gap, state);
    const context = contextFor(gap, state);
    const tools = this.registry.forGap(gap);
    const evidence: Evidence[] = [];
    const drafts: DraftAnswer[] = [];
    const toolErrors: string[] = [];
    let firstEvidenceAt: number | undefined;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);

    await Promise.all(
      tools.map(async (t) => {
        try {
          const r = await t.research({ gap, query, context, objective: state.objective, state, depth, signal: combined });
          if (combined.aborted) return;
          if (r.evidence.length && firstEvidenceAt === undefined) firstEvidenceAt = this.clock.now();
          evidence.push(...r.evidence);
          if (r.draft) drafts.push(r.draft);
        } catch (e) {
          toolErrors.push(`${t.id}: ${(e as Error).name === 'AbortError' || combined.aborted ? (signal.aborted ? 'cancelled' : 'timed out') : (e as Error).message}`);
        }
      }),
    );

    const finish = (answer: SynthesizedAnswer): ResearchRun => ({
      query,
      toolsUsed: tools.map((t) => t.id),
      toolErrors,
      evidence,
      answer,
      firstEvidenceAt,
      durationMs: this.clock.now() - started,
      aborted: signal.aborted,
    });

    if (signal.aborted) return finish({ outcome: 'UNRESOLVED', confidence: 'UNVERIFIED', usedEvidenceIds: [], note: 'research cancelled' });
    if (tools.length === 0) return finish({ outcome: 'UNRESOLVED', confidence: 'UNVERIFIED', usedEvidenceIds: [], note: 'no research tool can handle this gap' });

    const fromDraft = chooseDraft(drafts, evidence);
    if (fromDraft && fromDraft.outcome !== 'UNRESOLVED') return finish(fromDraft);
    try {
      const a = await this.primary.synthesize({ question: query, context, evidence, drafts, signal });
      return finish(a);
    } catch (e) {
      toolErrors.push(`synthesizer ${this.primary.id}: ${(e as Error).message}`);
      const a = await this.fallback.synthesize({ question: query, context, evidence, drafts, signal });
      return finish({ ...a, note: `${a.note} (fallback synthesizer)` });
    }
  }
}
