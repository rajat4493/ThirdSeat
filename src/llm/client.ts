// Provider-neutral LLM boundary. The product intelligence depends on this interface only.

export type Effort = 'low' | 'medium' | 'high';

export interface JsonRequest {
  system: string;
  user: string;
  /** JSON schema for structured output. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
}

export interface WebCitation {
  url: string;
  title: string;
  citedText: string;
}

export interface WebSearchRequest {
  system: string;
  user: string;
  maxUses?: number;
  allowedDomains?: string[];
  effort?: Effort;
  signal?: AbortSignal;
}

export interface WebSearchResponse {
  text: string;
  citations: WebCitation[];
  /** Search results seen (not necessarily cited). */
  results: { url: string; title: string }[];
}

export interface LlmClient {
  readonly id: string;
  json<T>(req: JsonRequest): Promise<T>;
  webSearch(req: WebSearchRequest): Promise<WebSearchResponse>;
}

export class LlmRefusalError extends Error {}
