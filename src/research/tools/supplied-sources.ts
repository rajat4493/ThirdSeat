// Researches user-supplied sources (URLs and local documents). No LLM required.
// Real retrieval: documents are fetched over the network and ranked with BM25.

import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { Evidence, Gap } from '../../domain/types.ts';
import { Bm25, contentTerms, coverage, termSet, truncate } from '../../domain/text.ts';
import { newId } from '../../domain/ids.ts';
import { tierForUrl } from '../../evidence/source-ranking.ts';
import type { ResearchRequest, ResearchTool, ToolResult } from '../types.ts';

export interface SourceDoc {
  url: string;
  title: string;
  text: string;
}

interface Chunk {
  doc: SourceDoc;
  heading: string;
  text: string;
  terms: string[];
}

const MAX_BYTES = 2_000_000;

export function cleanText(raw: string, contentType = ''): { title?: string; text: string } {
  let text = raw;
  let title: string | undefined;
  if (contentType.includes('html') || /^\s*<!doctype html|<html/i.test(raw)) {
    title = raw.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(h[1-6])[^>]*>/gi, '\n\n# ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"');
  } else {
    // Markdown: drop front matter, keep the first title, simplify links/markup.
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (fm) {
      title = fm[1].match(/^title:\s*(.+)$/m)?.[1]?.trim();
      text = text.slice(fm[0].length);
    }
    title = title ?? text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    text = text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^>\s*\[!\w+\]\s*$/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[*_`]{1,3}/g, '')
      .replace(/\|/g, ' | ');
  }
  return { title, text: text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() };
}

function chunk(doc: SourceDoc): Chunk[] {
  const out: Chunk[] = [];
  let heading = doc.title;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text.length > 40) {
      // Split oversized sections into ~900-char windows on paragraph boundaries.
      const paras = text.split(/\n\s*\n/);
      let cur = '';
      for (const p of paras) {
        if ((cur + '\n\n' + p).length > 900 && cur) {
          out.push({ doc, heading, text: cur, terms: contentTerms(heading + ' ' + cur) });
          cur = p;
        } else cur = cur ? cur + '\n\n' + p : p;
      }
      if (cur) out.push({ doc, heading, text: cur, terms: contentTerms(heading + ' ' + cur) });
    }
    buf = [];
  };
  for (const line of doc.text.split('\n')) {
    const h = line.match(/^#{1,4}\s+(.+)$/);
    if (h) {
      flush();
      heading = h[1].trim();
    } else buf.push(line);
  }
  flush();
  return out;
}

/** Best 1–3 consecutive sentences in a chunk for the query terms. */
function bestExcerpt(text: string, q: Set<string>): string {
  const sents = text.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  let best = { score: -1, i: 0 };
  sents.forEach((s, i) => {
    const window = sents.slice(i, i + 2).join(' ');
    const sc = coverage(q, termSet(window)) + coverage(q, termSet(s)) * 0.5;
    if (sc > best.score) best = { score: sc, i };
  });
  return truncate(sents.slice(best.i, best.i + 3).join(' ').trim(), 600);
}

export async function fetchDoc(url: string, signal?: AbortSignal): Promise<SourceDoc> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`unsupported protocol ${u.protocol}`);
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(15_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error(`document too large (${len} bytes)`);
  const raw = (await res.text()).slice(0, MAX_BYTES);
  const { title, text } = cleanText(raw, res.headers.get('content-type') ?? '');
  return { url, title: title ?? url, text };
}

export async function loadLocalDocs(dir: string): Promise<SourceDoc[]> {
  const root = resolve(dir);
  const out: SourceDoc[] = [];
  for (const name of await readdir(root)) {
    if (!['.md', '.txt', '.html', '.htm'].includes(extname(name).toLowerCase())) continue;
    const raw = await readFile(join(root, name), 'utf8');
    const { title, text } = cleanText(raw, extname(name).startsWith('.htm') ? 'html' : '');
    out.push({ url: `file://${join(root, name)}`, title: title ?? name, text });
  }
  return out;
}

export class SuppliedSourcesTool implements ResearchTool {
  readonly id = 'supplied_sources';
  readonly description = 'Documents and URLs supplied for this session (fetched and ranked locally).';
  private chunks: Chunk[] = [];
  private bm25 = new Bm25([]);
  private loading?: Promise<void>;
  readonly loadErrors: string[] = [];
  private urls: string[];
  private extraDocs: SourceDoc[];

  constructor(opts: { urls?: string[]; docs?: SourceDoc[] }) {
    this.urls = opts.urls ?? [];
    this.extraDocs = opts.docs ?? [];
  }

  canHandle(gap: Gap): boolean {
    return gap.type === 'KNOWLEDGE' && (this.urls.length > 0 || this.extraDocs.length > 0);
  }

  get docCount(): number {
    return new Set(this.chunks.map((c) => c.doc.url)).size;
  }

  /** Fetch and index all sources. Safe to call repeatedly; runs once. */
  warm(): Promise<void> {
    this.loading ??= (async () => {
      const docs = [...this.extraDocs];
      const fetched = await Promise.allSettled(this.urls.map((u) => fetchDoc(u)));
      fetched.forEach((r, i) => {
        if (r.status === 'fulfilled') docs.push(r.value);
        else this.loadErrors.push(`${this.urls[i]}: ${(r.reason as Error).message}`);
      });
      this.chunks = docs.flatMap(chunk);
      this.bm25 = new Bm25(this.chunks.map((c) => c.terms));
    })();
    return this.loading;
  }

  async research(req: ResearchRequest): Promise<ToolResult> {
    await this.warm();
    if (req.signal.aborted) return { evidence: [] };
    const qTerms = contentTerms(req.query);
    const q = new Set(qTerms);
    const scored = this.chunks
      .map((c, i) => ({ c, s: this.bm25.score(qTerms, i), cov: coverage(q, new Set(c.terms)) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, req.depth === 'deep' ? 6 : 3);
    const top = scored[0]?.s ?? 1;
    const now = Date.now();
    const evidence: Evidence[] = scored.map((x) => ({
      id: newId('ev'),
      toolId: this.id,
      sourceTier: tierForUrl(x.c.doc.url, 'user_supplied'),
      title: x.c.heading && x.c.heading !== x.c.doc.title ? `${x.c.doc.title} — ${x.c.heading}` : x.c.doc.title,
      url: x.c.doc.url,
      excerpt: bestExcerpt(x.c.text, q),
      // Combined relevance: relative BM25 rank and absolute coverage of the question's terms.
      score: Number((0.5 * (x.s / top) + 0.5 * x.cov).toFixed(3)),
      retrievedAt: now,
    }));
    return { evidence };
  }
}
