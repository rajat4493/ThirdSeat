// Small, dependency-free text utilities shared by the heuristic analyzer and retrieval.

const STOPWORDS = new Set(
  (
    'a an the and or but if then so to of in on at by for with from as is are was were be been being ' +
    'do does did done doing have has had having it its this that these those there here what which who whom ' +
    'whose when where why how can could would should will shall may might must i me my we us our you your ' +
    'he she they them their his her not no yes just really actually also very about into over than too ' +
    'any some all each more most other such only own same s t don dont im ive id youre were thats lets ' +
    'get got go going gonna wanna like kind sort thing things stuff yeah ok okay um uh hmm well right ' +
    'think know mean say said maybe probably sure need want something anything everything nothing ' +
    'one two lot bit way much many even still again now already'
  ).split(/\s+/),
);

export function isStopword(t: string): boolean {
  return STOPWORDS.has(t);
}

/** Most frequent non-stopword tokens across texts (unstemmed, for display). */
export function topTerms(texts: string[], n: number, exclude: Set<string> = new Set()): string[] {
  const freq = new Map<string, number>();
  for (const t of texts.flatMap((x) => tokens(x))) {
    if (t.length < 3 || STOPWORDS.has(t) || exclude.has(stem(t)) || /^\d+$/.test(t)) continue;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([t]) => t);
}

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9.+#\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(text: string): string[] {
  return normalise(text)
    .split(' ')
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter(Boolean);
}

/** Light stemming so "transcripts"/"transcript" and "supports"/"support" match. */
export function stem(t: string): string {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && t.endsWith('es') && !t.endsWith('ses')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  return t;
}

/** Content-bearing terms (stopwords removed, stemmed). */
export function contentTerms(text: string): string[] {
  return tokens(text)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export function termSet(text: string): Set<string> {
  return new Set(contentTerms(text));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Fraction of `query` terms present in `doc`. */
export function coverage(query: Set<string>, doc: Set<string>): number {
  if (query.size === 0) return 0;
  let hit = 0;
  for (const q of query) if (doc.has(q)) hit++;
  return hit / query.size;
}

/** Returns the first phrase found in `text` on word boundaries (case/punctuation-insensitive). */
export function hasAny(text: string, phrases: readonly string[]): string | undefined {
  const n = ' ' + normalise(text).replace(/[.,!?]/g, ' ') + ' ';
  for (const p of phrases) if (n.includes(' ' + p + ' ')) return p;
  return undefined;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Minimal BM25 over pre-tokenised documents. Good enough for a handful of supplied docs.
 */
export class Bm25 {
  private docs: string[][];
  private df = new Map<string, number>();
  private avgLen: number;
  private k1 = 1.4;
  private b = 0.75;

  constructor(docs: string[][]) {
    this.docs = docs;
    for (const d of docs) for (const t of new Set(d)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  }

  score(query: string[], i: number): number {
    const d = this.docs[i];
    const n = this.docs.length;
    let s = 0;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const q of new Set(query)) {
      const f = tf.get(q);
      if (!f) continue;
      const df = this.df.get(q) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      s += (idf * (f * (this.k1 + 1))) / (f + this.k1 * (1 - this.b + (this.b * d.length) / this.avgLen));
    }
    return s;
  }
}
