// Composition root: builds a GapEngine for a session from configuration.

import type { Clock } from './clock.ts';
import type { Session } from './domain/types.ts';
import { GapEngine, type EngineConfig } from './gaps/engine.ts';
import { HeuristicAnalyzer } from './analysis/heuristic-analyzer.ts';
import { LlmAnalyzer } from './analysis/llm-analyzer.ts';
import type { ConversationAnalyzer } from './analysis/types.ts';
import { ToolRegistry } from './research/registry.ts';
import { ResearchService } from './research/research-service.ts';
import { ExtractiveSynthesizer, LlmSynthesizer } from './research/synthesizers.ts';
import type { ResearchTool } from './research/types.ts';
import { ConversationContextTool } from './research/tools/conversation-context.ts';
import { SuppliedSourcesTool, type SourceDoc } from './research/tools/supplied-sources.ts';
import { ClaudeWebSearchTool } from './research/tools/claude-web-search.ts';
import type { LlmClient } from './llm/client.ts';

export interface BuildOptions {
  session: Session;
  clock: Clock;
  /** When present, enables LLM analysis, synthesis and web search. */
  llm?: LlmClient;
  /** Use the LLM for conversation analysis (default true when llm is present). */
  llmAnalysis?: boolean;
  webSearch?: boolean;
  localDocs?: SourceDoc[];
  extraTools?: ResearchTool[];
  config?: Partial<EngineConfig>;
  researchTimeoutMs?: number;
}

export interface BuiltEngine {
  engine: GapEngine;
  analyzerId: string;
  tools: ResearchTool[];
  supplied?: SuppliedSourcesTool;
}

export function buildEngine(o: BuildOptions): BuiltEngine {
  const heuristic = new HeuristicAnalyzer();
  const analyzer: ConversationAnalyzer = o.llm && o.llmAnalysis !== false ? new LlmAnalyzer(o.llm) : heuristic;

  const registry = new ToolRegistry().register(new ConversationContextTool());
  let supplied: SuppliedSourcesTool | undefined;
  if (o.session.config.sourceUrls.length || o.localDocs?.length) {
    supplied = new SuppliedSourcesTool({ urls: o.session.config.sourceUrls, docs: o.localDocs });
    registry.register(supplied);
    void supplied.warm(); // fetch early so the first gap doesn't pay for it
  }
  if (o.llm && o.webSearch !== false) registry.register(new ClaudeWebSearchTool(o.llm));
  for (const t of o.extraTools ?? []) registry.register(t);

  const extractive = new ExtractiveSynthesizer();
  const research = new ResearchService({
    registry,
    synthesizer: o.llm ? new LlmSynthesizer(o.llm) : extractive,
    fallbackSynthesizer: extractive,
    clock: o.clock,
    timeoutMs: o.researchTimeoutMs,
  });
  const engine = new GapEngine({
    session: o.session,
    analyzer,
    fallbackAnalyzer: analyzer === heuristic ? undefined : heuristic,
    research,
    clock: o.clock,
    config: o.config,
  });
  return { engine, analyzerId: analyzer.id, tools: registry.list(), supplied };
}
