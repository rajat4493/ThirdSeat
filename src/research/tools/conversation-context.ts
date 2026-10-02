// Step 1 of research: can this be answered from what was already established in this conversation?

import type { Gap } from '../../domain/types.ts';
import { coverage, termSet } from '../../domain/text.ts';
import { newId } from '../../domain/ids.ts';
import type { ResearchRequest, ResearchTool, ToolResult } from '../types.ts';

export class ConversationContextTool implements ResearchTool {
  readonly id = 'conversation_context';
  readonly description = 'Facts and answers already established earlier in this session.';

  canHandle(gap: Gap): boolean {
    return gap.type === 'KNOWLEDGE' || gap.type === 'CONTEXT';
  }

  async research(req: ResearchRequest): Promise<ToolResult> {
    const q = termSet(req.query);
    const items = [
      ...req.state.facts.map((f) => ({ text: f.text, at: f.at })),
      ...[...req.state.gaps.values()]
        .filter((g) => g.id !== req.gap.id && g.status === 'RESOLVED' && g.answer)
        .map((g) => ({ text: `${g.interpretedQuestion} → ${g.answer}`, at: g.timing.resolvedAt ?? g.timing.detectedAt })),
    ];
    const now = Date.now();
    const evidence = items
      .map((it) => ({ it, cov: coverage(q, termSet(it.text)) }))
      .filter((x) => x.cov >= 0.6)
      .sort((a, b) => b.cov - a.cov)
      .slice(0, 2)
      .map((x) => ({
        id: newId('ev'),
        toolId: this.id,
        sourceTier: 'conversation' as const,
        title: 'Earlier in this conversation',
        excerpt: x.it.text,
        score: x.cov,
        retrievedAt: now,
      }));
    return { evidence };
  }
}
