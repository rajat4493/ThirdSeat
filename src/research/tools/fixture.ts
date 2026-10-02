// TEST-ONLY research tool returning controlled evidence. Never registered by the server.
// Used to make scenario tests deterministic; it is not evidence that research works.

import type { Confidence, Gap, SourceTier } from '../../domain/types.ts';
import { newId } from '../../domain/ids.ts';
import { coverage, termSet } from '../../domain/text.ts';
import type { ResearchRequest, ResearchTool, ToolResult } from '../types.ts';

export interface FixtureEntry {
  /** All of these terms must appear in the query (stemmed content terms). */
  match: string[];
  title: string;
  url: string;
  tier: SourceTier;
  excerpt: string;
  draft?: { answer: string; confidence: Confidence };
}

export class FixtureResearchTool implements ResearchTool {
  readonly id = 'fixture';
  readonly description = 'Deterministic fixture evidence (tests only).';
  readonly calls: string[] = [];
  aborted = 0;
  private entries: FixtureEntry[];
  private gated: boolean;
  private waiters: (() => void)[] = [];

  constructor(entries: FixtureEntry[], opts: { gated?: boolean } = {}) {
    this.entries = entries;
    this.gated = !!opts.gated;
  }

  canHandle(gap: Gap): boolean {
    return gap.type === 'KNOWLEDGE' && gap.researchable;
  }

  /** Releases all gated research calls. */
  release(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  get waiting(): number {
    return this.waiters.length;
  }

  async research(req: ResearchRequest): Promise<ToolResult> {
    this.calls.push(req.query);
    if (this.gated) {
      await new Promise<void>((resolve, reject) => {
        this.waiters.push(resolve);
        req.signal.addEventListener('abort', () => {
          this.aborted++;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    const q = termSet(req.query);
    const hits = this.entries.filter((e) => coverage(termSet(e.match.join(' ')), q) === 1);
    const evidence = hits.map((h) => ({
      id: newId('ev'),
      toolId: this.id,
      sourceTier: h.tier,
      title: h.title,
      url: h.url,
      excerpt: h.excerpt,
      score: 0.9,
      retrievedAt: 0,
    }));
    const withDraft = hits.findIndex((h) => h.draft);
    return {
      evidence,
      draft: withDraft >= 0 ? { ...hits[withDraft].draft!, citedEvidenceIds: [evidence[withDraft].id] } : undefined,
    };
  }
}
