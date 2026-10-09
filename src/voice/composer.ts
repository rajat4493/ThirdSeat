// Turns a surfaced contribution into one short spoken turn, phrased like a teammate.
// Only gap contributions are ever composed. Facts come from the gap; phrasing may be rephrased by the
// LLM, but a guard rejects any rephrasing that introduces numbers or names absent from the source.

import type { Gap } from '../domain/types.ts';
import type { LlmClient } from '../llm/client.ts';
import { truncate } from '../domain/text.ts';
import { SENTENCE_STARTERS, namedEntities } from '../analysis/heuristic-analyzer.ts';

// Common ways a spoken turn opens; a capitalised first word outside this list is treated as a name.
const OPENERS = new Set(['quick', 'small', 'short', 'heads', 'going', 'before', 'sounds', 'looks', 'seems', 'from', 'on', 'about', 'according', 'yes', 'no', 'nope', 'yep', 'good', 'great', 'fyi', 'actually', 'apparently', 'turns', 'worth', 'note', 'careful', 'one', 'checked', 'found', 'still', 'we', 'you', 'that', 'this', 'it', 'they', 'there', 'both', 'neither', 'either', 'only', 'not', 'unfortunately', 'officially', 'per', 'in', 'for', 'with', 'by', 'as', 'at', 'to', 'and', 'but', 'or', 'nothing', 'everything', 'some', 'most', 'all']);

export const MAX_SPOKEN_WORDS = 40;

/** What may be spoken at all. Anything else stays on screen only. */
export function speakable(gap: Gap): { ok: boolean; why: string } {
  if (gap.type === 'KNOWLEDGE') {
    if (!gap.answer) return { ok: false, why: 'no answer' };
    if (gap.confidence !== 'HIGH' && gap.confidence !== 'LIKELY') return { ok: false, why: `confidence ${gap.confidence ?? 'unknown'} is not good enough to say out loud` };
    return { ok: true, why: 'answer with adequate sourcing' };
  }
  if (gap.type === 'OPEN_THREAD' || gap.type === 'DECISION' || gap.type === 'DRIFT' || gap.type === 'REASONING') return { ok: true, why: `${gap.type.toLowerCase()} contribution` };
  return { ok: false, why: `${gap.type.toLowerCase()} is screen-only` };
}

/** Make text sound spoken: no URLs, quotes, markdown, test markers or lists. */
export function forSpeech(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\bFIXTURE:\s*/g, '')
    .replace(/[“”"]/g, '')
    .replace(/\s*\n\s*\d+\.\s*/g, '; ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[*_`#]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

export function capWords(text: string, max = MAX_SPOKEN_WORDS): string {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  const cut = words.slice(0, max).join(' ');
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (lastStop > cut.length * 0.5 ? cut.slice(0, lastStop + 1) : cut.replace(/[,;:]?$/, '') + '…').trim();
}

/** The question as people would say it again: internal notes removed, never cut mid-word. */
export function spokenQuestion(question: string): string {
  const q = question.replace(/\s*\(context: .*\)\s*$/, '').replace(/^Is it true that /i, '').trim();
  const words = q.split(/\s+/);
  const short = words.length > 16 ? words.slice(0, 16).join(' ') + '…' : q;
  return /[?…]$/.test(short) ? short : short.replace(/[.]$/, '') + '?';
}

/** "the question about Zoom" — a short spoken reference using the named things in the question. */
export function aboutPhrase(question: string): string {
  const q = spokenQuestion(question);
  const names = namedEntities(q).filter((e) => !SENTENCE_STARTERS.has(e.toLowerCase())).map((e) => e.replace(/'s$/, ''));
  const unique = [...new Set(names)].slice(0, 2);
  return unique.length ? `the question about ${unique.join(' and ')}` : 'the earlier question';
}

/** Kept for addressed replies: a compact lower-case reference to a question. */
export function topicOf(question: string): string {
  const q = spokenQuestion(question).replace(/[?]$/, '');
  return q.charAt(0).toLowerCase() + q.slice(1);
}

function ensureStop(s: string): string {
  return /[.!?…]$/.test(s) ? s : s + '.';
}

/** Deterministic phrasing. Used directly without an LLM, and as the fallback when the LLM's phrasing is rejected. */
export function templateFor(gap: Gap): string {
  const answer = gap.answer ? ensureStop(forSpeech(gap.answer)) : '';
  const hedge = gap.confidence === 'LIKELY' ? 'From what I can find, ' : '';
  const lowerFirst = (s: string) => (hedge ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  switch (gap.type) {
    case 'KNOWLEDGE': {
      const a = `${hedge}${lowerFirst(answer)}`;
      if (gap.timingMode === 'RETROACTIVE') return `Going back to ${aboutPhrase(gap.interpretedQuestion)} — ${a}`;
      if (gap.reason === 'USER_REQUESTED') return a;
      if (/^Is it true that /.test(gap.interpretedQuestion)) return `Quick check on that — ${a}`;
      if (gap.askedToRoom) return `I can take that one. ${a}`;
      if (gap.reason === 'DEFERRED_FOR_LATER') return `We don't need to park that — ${a}`;
      if (gap.timingMode === 'REACTIVE') return `I looked that up — ${a}`;
      return `I checked that one — ${a}`;
    }
    case 'OPEN_THREAD':
      return `Before we decide — we never settled this: ${spokenQuestion(gap.interpretedQuestion)} Does that change anything?`;
    case 'DRIFT':
      return ensureStop(forSpeech(gap.interventionText ?? '').replace(/^The discussion has moved to/, "Quick nudge: we've drifted to").replace(/Still unresolved for today's objective:/, 'and still open for today is'));
    case 'DECISION': {
      const items = (gap.interventionText ?? '').split('\n').filter((l) => /^\d+\./.test(l)).map((l) => spokenQuestion(forSpeech(l.replace(/^\d+\.\s*/, '').replace(/\(only partly verified\)/, ''))).replace(/[?]$/, ''));
      return items.length ? `Sounds like we're close. Still open: ${items.slice(0, 3).join('; ')}.` : "Sounds like we're close.";
    }
    case 'REASONING':
      return "We've shown it's doable — have we shown it's worth doing, that the need is strong enough?";
    default:
      return ensureStop(forSpeech(gap.interventionText ?? ''));
  }
}

const SYSTEM = `You voice ThirdSeat, a teammate in a live meeting whose only job is closing gaps: answering open factual questions, checking assumptions, recalling dropped questions, flagging material drift, and listing open items when the group concludes.
Rewrite the given contribution as ONE short spoken turn (max 35 words), natural and direct, like a colleague speaking up. No greetings, no "As an AI", no lists, no URLs, no opinions, no new facts.
Use ONLY facts present in the input. Keep every number, product name and caveat exactly. If confidence is LIKELY, sound appropriately tentative.`;

const SCHEMA = { type: 'object', additionalProperties: false, required: ['speech'], properties: { speech: { type: 'string' } } };

/** Rejects a rephrasing that introduces numbers or names not in the source material. */
export function faithful(spoken: string, source: string): boolean {
  const nums = (s: string) => new Set(s.match(/\d+(?:[.,]\d+)?/g) ?? []);
  const src = nums(source);
  for (const n of nums(spoken)) if (!src.has(n)) return false;
  // Names: acronyms/CamelCase anywhere, capitalised words not at the start of a sentence.
  const srcLower = source.toLowerCase();
  const names = spoken
    .split(/(?<=[.!?:—-])\s+/)
    .flatMap((sentence) => {
      const words = sentence.split(/\s+/).filter(Boolean);
      const first = (words[0] ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
      const firstIsName = first && !OPENERS.has(first) && !SENTENCE_STARTERS.has(first);
      return firstIsName ? words : words.slice(1);
    })
    .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''))
    .filter((w) => /^[A-Z]/.test(w) && w !== 'I');
  for (const e of names) if (!srcLower.includes(e.toLowerCase())) return false;
  return true;
}

export class SpeechComposer {
  private llm?: LlmClient;
  readonly rejected: string[] = [];

  constructor(llm?: LlmClient) {
    this.llm = llm;
  }

  async compose(gap: Gap): Promise<string> {
    const template = capWords(templateFor(gap));
    if (!this.llm) return template;
    const source = [gap.interpretedQuestion, gap.answer, gap.caveat, gap.interventionText].filter(Boolean).join('\n');
    try {
      const r = await this.llm.json<{ speech: string }>({
        system: SYSTEM,
        user: `Contribution type: ${gap.type}; timing: ${gap.timingMode ?? 'n/a'}; confidence: ${gap.confidence ?? 'n/a'}\nQuestion: ${gap.interpretedQuestion}\nAnswer: ${gap.answer ?? '(none)'}\nCaveat: ${gap.caveat ?? '(none)'}\nCard text: ${gap.interventionText ?? ''}\nPlain version you may improve: ${template}`,
        schema: SCHEMA,
        maxTokens: 400,
        effort: 'low',
      });
      const speech = capWords(forSpeech(r.speech));
      if (!speech || !faithful(speech, source + '\n' + template)) {
        this.rejected.push(speech);
        return template;
      }
      return speech;
    } catch {
      return template;
    }
  }
}
