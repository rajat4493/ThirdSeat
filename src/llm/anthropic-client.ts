// Anthropic Claude implementation of LlmClient (official SDK).
// Content sent here leaves the machine: see duck/HANDOVER.md → External services.

import Anthropic from '@anthropic-ai/sdk';
import type { JsonRequest, LlmClient, WebSearchRequest, WebSearchResponse, WebCitation } from './client.ts';
import { LlmRefusalError } from './client.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface AnthropicClientOptions {
  model?: string;
  /** Server-side refusal fallback routing (beta). On by default; disable with THIRDSEAT_LLM_FALLBACKS=0. */
  fallbacks?: boolean;
  timeoutMs?: number;
}

export class AnthropicLlmClient implements LlmClient {
  readonly id: string;
  private client: Anthropic;
  private model: string;
  private fallbacks: boolean;

  constructor(opts: AnthropicClientOptions = {}) {
    // Credentials resolve from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant` profile).
    this.client = new Anthropic({ timeout: opts.timeoutMs ?? 60_000, maxRetries: 1 });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.fallbacks = opts.fallbacks ?? true;
    this.id = `anthropic:${this.model}`;
  }

  private common() {
    return this.fallbacks
      ? { betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[], fallbacks: 'default' as const }
      : {};
  }

  async json<T>(req: JsonRequest): Promise<T> {
    const res = await this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 4000,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { effort: req.effort ?? 'low', format: { type: 'json_schema', schema: req.schema } },
        ...this.common(),
      },
      { signal: req.signal },
    );
    if (res.stop_reason === 'refusal') throw new LlmRefusalError('model declined the request');
    if (res.stop_reason === 'max_tokens') throw new Error('structured output truncated (max_tokens)');
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return JSON.parse(text) as T;
  }

  async webSearch(req: WebSearchRequest): Promise<WebSearchResponse> {
    const tool: Anthropic.Beta.BetaWebSearchTool20260209 = {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: req.maxUses ?? 3,
      ...(req.allowedDomains?.length ? { allowed_domains: req.allowedDomains } : {}),
    };
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: req.user }];
    let res: Anthropic.Beta.BetaMessage | undefined;
    // Server tools may pause long turns; resume a bounded number of times.
    for (let i = 0; i < 3; i++) {
      res = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 8000,
          system: req.system,
          messages,
          tools: [tool],
          output_config: { effort: req.effort ?? 'low' },
          ...this.common(),
        },
        { signal: req.signal },
      );
      if (res.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: res.content });
    }
    if (!res) throw new Error('no response');
    if (res.stop_reason === 'refusal') throw new LlmRefusalError('model declined the request');

    const citations: WebCitation[] = [];
    const results: { url: string; title: string }[] = [];
    const textParts: string[] = [];
    for (const block of res.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
        for (const c of block.citations ?? []) {
          if (c.type === 'web_search_result_location') {
            citations.push({ url: c.url, title: c.title ?? c.url, citedText: c.cited_text });
          }
        }
      } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) results.push({ url: r.url, title: r.title });
      }
    }
    return { text: textParts.join('').trim(), citations, results };
  }
}
