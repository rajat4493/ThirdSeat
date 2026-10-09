// When people speak to ThirdSeat directly. It answers only within its job (sources, confidence, looking
// something up, what is still open, being quiet); everything else gets a one-line, polite deflection.

import { normalise } from '../domain/text.ts';
import { parseQuestion } from '../analysis/heuristic-analyzer.ts';
import type { LlmClient } from '../llm/client.ts';

export type AddressedIntent =
  | 'MUTE'
  | 'UNMUTE'
  | 'THANKS'
  | 'SOURCE'
  | 'CONFIDENCE'
  | 'WRONG'
  | 'OPEN_ITEMS'
  | 'REPEAT'
  | 'RESEARCH'
  | 'OUT_OF_SCOPE'
  | 'NONE';

export interface Addressed {
  /** The utterance with the name removed. */
  rest: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Addressed only when the name is used as a vocative: at the start ("ThirdSeat, …", "Hey ThirdSeat …")
 * or tagged on at the end ("…, ThirdSeat?"). "Your third seat at the table" in passing is not addressing it.
 */
export function detectAddressed(text: string, names: string[]): Addressed | undefined {
  const alt = names.map((n) => escapeRe(n).replace(/\s+/g, '\\s*')).join('|');
  const start = new RegExp(`^\\s*(?:(?:hey|hi|ok|okay|so|and|right|yo)[,\\s]+)?(?:${alt})\\b[,:!?.\\s]*`, 'i');
  const end = new RegExp(`,\\s*(?:${alt})\\s*[?.!]*\\s*$`, 'i');
  if (start.test(text)) return { rest: text.replace(start, '').trim() };
  if (end.test(text)) return { rest: text.replace(end, '').trim() + (/\?\s*$/.test(text) ? '?' : '') };
  return undefined;
}

export function classifyAddressed(rest: string): { intent: AddressedIntent; question?: string } {
  const n = normalise(rest);
  const words = n.split(' ').filter(Boolean).length;
  if (!n) return { intent: 'NONE' };
  if (/\b(you can (talk|speak) again|unmute|speak up again|youre back|come back in)\b/.test(n)) return { intent: 'UNMUTE' };
  if (/\b(be quiet|quiet|stop talking|mute|hush|shush|not now|stay quiet|pipe down|enough)\b/.test(n)) return { intent: 'MUTE' };
  if (words <= 5 && /\b(thanks|thank you|cheers|got it|great|perfect|nice|good catch|helpful)\b/.test(n)) return { intent: 'THANKS' };
  if (/\b(thats (wrong|not right|incorrect)|youre wrong|not true|i dont think thats right|thats outdated)\b/.test(n)) return { intent: 'WRONG' };
  if (/\b(wheres (that|this|it)|where (is|did|does|was) (that|this|it)|source|which (doc|page|article)|how do you know|says who|link)\b/.test(n)) return { intent: 'SOURCE' };
  if (/\b(how sure|how confident|are you sure|how certain|confident are you)\b/.test(n)) return { intent: 'CONFIDENCE' };
  if (/\b(whats (still )?open|what are we missing|whats left|open (items|questions)|whats unresolved|what havent we|anything (still )?open)\b/.test(n)) return { intent: 'OPEN_ITEMS' };
  if (/\b(say (that|it) again|repeat|come again|what did you say)\b/.test(n)) return { intent: 'REPEAT' };
  const lookup = rest.match(/^(?:can you |could you |please )?(?:check|look up|find out|verify|confirm)\s+(?:whether |if )?(.+)$/i);
  if (lookup) return { intent: 'RESEARCH', question: lookup[1].replace(/[.?!]*$/, '?') };
  const q = parseQuestion(rest);
  if (q && q.kind === 'FACTUAL') return { intent: 'RESEARCH', question: q.sentence };
  return { intent: 'OUT_OF_SCOPE' };
}

const SYSTEM = `People in a meeting just spoke directly to ThirdSeat, a teammate whose ONLY job is closing gaps: looking up facts, citing where answers came from, stating confidence, listing what is still open, and staying quiet when asked.
Classify what they want. RESEARCH = they want a fact checked or looked up (give it as a standalone question). OUT_OF_SCOPE = opinions, decisions, writing, summaries, small talk, anything else.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'question'],
  properties: {
    intent: { type: 'string', enum: ['MUTE', 'UNMUTE', 'THANKS', 'SOURCE', 'CONFIDENCE', 'WRONG', 'OPEN_ITEMS', 'REPEAT', 'RESEARCH', 'OUT_OF_SCOPE', 'NONE'] },
    question: { type: 'string' },
  },
};

export async function classifyAddressedWithLlm(llm: LlmClient, rest: string, context: string[]): Promise<{ intent: AddressedIntent; question?: string }> {
  try {
    const r = await llm.json<{ intent: AddressedIntent; question: string }>({
      system: SYSTEM,
      user: `Recent conversation:\n${context.join('\n')}\n\nSaid to ThirdSeat: ${rest}`,
      schema: SCHEMA,
      maxTokens: 300,
      effort: 'low',
    });
    return { intent: r.intent, question: r.intent === 'RESEARCH' && r.question.trim() ? r.question.trim() : undefined };
  } catch {
    return classifyAddressed(rest);
  }
}
