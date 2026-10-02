// Public web research via Claude's server-side web search tool. Returns cited evidence plus a draft answer.

import type { Confidence, Evidence, Gap } from '../../domain/types.ts';
import { newId } from '../../domain/ids.ts';
import { truncate } from '../../domain/text.ts';
import { tierForUrl } from '../../evidence/source-ranking.ts';
import type { LlmClient } from '../../llm/client.ts';
import type { ResearchRequest, ResearchTool, ToolResult } from '../types.ts';

const SYSTEM = `You are the research component of a live-conversation assistant. People in a live discussion hit a factual gap; you have seconds, not minutes.
Answer the question in at most 3 short sentences, using web search. Prefer official vendor documentation and primary sources over blogs.
State limitations and conditions precisely (tiers, preview status, permissions). If the sources do not clearly answer the question, say exactly what you could and could not verify — never guess.
Finish with a final line exactly of the form: CONFIDENCE: HIGH | LIKELY | UNVERIFIED
HIGH = an official/primary source directly answers it. LIKELY = good but indirect or partial support. UNVERIFIED = no reliable source found.`;

export function parseConfidence(text: string): { body: string; confidence: Confidence } {
  const m = text.match(/CONFIDENCE:\s*(HIGH|LIKELY|UNVERIFIED)\s*$/i);
  const confidence = (m?.[1]?.toUpperCase() as Confidence | undefined) ?? 'UNVERIFIED';
  return { body: (m ? text.slice(0, m.index) : text).trim(), confidence };
}

export class ClaudeWebSearchTool implements ResearchTool {
  readonly id = 'claude_web_search';
  readonly description = 'Public web search (Anthropic server-side web search tool).';
  private llm: LlmClient;
  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  canHandle(gap: Gap): boolean {
    return gap.type === 'KNOWLEDGE' && gap.researchable;
  }

  async research(req: ResearchRequest): Promise<ToolResult> {
    const user = [
      `Question raised in the conversation: ${req.query}`,
      req.context.length ? `Recent conversation context (for disambiguation only):\n${req.context.map((c) => `- ${c}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const res = await this.llm.webSearch({
      system: SYSTEM,
      user,
      maxUses: req.depth === 'deep' ? 6 : 3,
      effort: req.depth === 'deep' ? 'medium' : 'low',
      signal: req.signal,
    });
    const now = Date.now();
    const seen = new Set<string>();
    const evidence: Evidence[] = [];
    for (const c of res.citations) {
      const key = c.url + '|' + c.citedText.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({
        id: newId('ev'),
        toolId: this.id,
        sourceTier: tierForUrl(c.url),
        title: c.title,
        url: c.url,
        excerpt: truncate(c.citedText, 600),
        score: 1,
        retrievedAt: now,
      });
    }
    const { body, confidence } = parseConfidence(res.text);
    if (!body) return { evidence };
    return {
      evidence,
      draft: {
        answer: body,
        confidence: evidence.length ? confidence : 'UNVERIFIED',
        citedEvidenceIds: evidence.map((e) => e.id),
      },
    };
  }
}
