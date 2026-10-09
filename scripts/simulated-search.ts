// Simulated search results for scored test runs (test only; answers are marked FIXTURE).
// 'hold' entries are slow lookups that finish only when released, to test late answers and cancellation.

import { newId } from '../src/domain/ids.ts';
import { coverage, termSet } from '../src/domain/text.ts';
import type { Confidence, Gap } from '../src/domain/types.ts';
import type { ResearchRequest, ResearchTool, ToolResult } from '../src/research/types.ts';

export interface Entry { key: string; match: string[]; answer: string; confidence: Confidence; hold?: boolean }

export class SimulatedSearch implements ResearchTool {
  readonly id = 'simulated_search';
  readonly description = 'Simulated search results (test only)';
  calls: { key: string | null; query: string }[] = [];
  cancelled: string[] = [];
  private held = new Map<string, (() => void)[]>();
  private entries: Entry[];
  constructor(entries: Entry[]) {
    this.entries = entries;
  }
  canHandle(g: Gap) {
    return g.type === 'KNOWLEDGE' && g.researchable;
  }
  release(key: string) {
    for (const f of this.held.get(key) ?? []) f();
    this.held.delete(key);
  }
  releaseAll() {
    for (const k of [...this.held.keys()]) this.release(k);
  }
  async research(req: ResearchRequest): Promise<ToolResult> {
    const q = termSet(req.query);
    const hit = this.entries.find((e) => coverage(termSet(e.match.join(' ')), q) === 1);
    this.calls.push({ key: hit?.key ?? null, query: req.query });
    if (!hit) return { evidence: [] };
    if (hit.hold) {
      await new Promise<void>((resolve, reject) => {
        this.held.set(hit.key, [...(this.held.get(hit.key) ?? []), resolve]);
        req.signal.addEventListener('abort', () => {
          this.cancelled.push(hit.key);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    const id = newId('ev');
    return {
      evidence: [{ id, toolId: this.id, sourceTier: 'official_docs', title: `Docs: ${hit.key}`, url: `https://docs.example/${hit.key}`, excerpt: hit.answer, score: 0.9, retrievedAt: 0 }],
      draft: { answer: hit.answer, confidence: hit.confidence, citedEvidenceIds: [id] },
    };
  }
}

