// Shared --ai switch for the scored test harnesses. Search stays simulated so AI and no-AI runs differ
// ONLY in how the conversation is understood (and how answers are worded), making scores comparable.

import { AnthropicLlmClient, DEFAULT_MODEL } from '../src/llm/anthropic-client.ts';
import type { JsonRequest, LlmClient, WebSearchRequest, WebSearchResponse } from '../src/llm/client.ts';

/** Wraps an LLM client to record call count, latency and failures for the test record. */
export class InstrumentedLlm implements LlmClient {
  readonly id: string;
  private inner: LlmClient;
  calls = 0;
  failures: string[] = [];
  latencies: number[] = [];

  constructor(inner: LlmClient) {
    this.inner = inner;
    this.id = inner.id;
  }

  private async time<T>(f: () => Promise<T>): Promise<T> {
    const t = Date.now();
    this.calls++;
    try {
      return await f();
    } catch (e) {
      this.failures.push((e as Error).message);
      throw e;
    } finally {
      this.latencies.push(Date.now() - t);
    }
  }

  json<T>(req: JsonRequest): Promise<T> {
    return this.time(() => this.inner.json<T>(req));
  }

  webSearch(req: WebSearchRequest): Promise<WebSearchResponse> {
    return this.time(() => this.inner.webSearch(req));
  }

  summary() {
    const l = [...this.latencies].sort((a, b) => a - b);
    return { model: this.id, calls: this.calls, failures: this.failures.length, medianMs: l[Math.floor(l.length / 2)] ?? null, p90Ms: l[Math.floor(l.length * 0.9)] ?? null, firstFailure: this.failures[0] ?? null };
  }
}

export function aiFromArgs(argv: string[]): InstrumentedLlm | undefined {
  if (!argv.includes('--ai')) return undefined;
  const hasCreds = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
  if (!hasCreds) {
    console.error('--ai needs Anthropic credentials (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile). Not running: a fallback run would silently score the no-AI rules as "AI".');
    process.exit(2);
  }
  return new InstrumentedLlm(new AnthropicLlmClient({ model: process.env.THIRDSEAT_MODEL ?? DEFAULT_MODEL }));
}

/**
 * An AI-mode score is only valid if the AI actually did the understanding. Any fallback to the heuristic
 * analyzer (API error, refusal, rate limit) invalidates the run.
 */
export function aiRunValidity(engineLog: { message: string }[], llm: InstrumentedLlm): { valid: boolean; reason?: string } {
  const fallbacks = engineLog.filter((l) => /using heuristic/.test(l.message)).length;
  if (fallbacks > 0) return { valid: false, reason: `${fallbacks} analysis batch(es) fell back to the no-AI rules (first error: ${llm.failures[0] ?? 'unknown'})` };
  if (llm.calls === 0) return { valid: false, reason: 'no AI calls were made' };
  return { valid: true };
}
