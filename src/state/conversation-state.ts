// Compact live state of a conversation. Supports interventions; it is not a record of the meeting.

import type { Gap, Intervention, Millis, Utterance } from '../domain/types.ts';
import { contentTerms, termSet } from '../domain/text.ts';

export interface TopicSnapshot {
  /** Most frequent content terms in the recent window. */
  terms: string[];
  /** 0..1 lexical relatedness of the recent window to the objective + open items. */
  objectiveRelatedness: number;
  since: Millis;
}

export interface EstablishedFact {
  text: string;
  utteranceId: string;
  at: Millis;
}

const MAX_TRANSCRIPT = 400; // in-memory ring buffer; older utterances are dropped
const MAX_FACTS = 40;

export class ConversationState {
  objective?: string;
  objectiveTerms: Set<string>;
  transcript: Utterance[] = [];
  gaps = new Map<string, Gap>();
  facts: EstablishedFact[] = [];
  assumptions: EstablishedFact[] = [];
  interventions: Intervention[] = [];
  topic: TopicSnapshot = { terms: [], objectiveRelatedness: 1, since: 0 };
  /** Time of the most recent explicit conclusion signal. */
  conclusionSignalAt?: Millis;
  /** Time drift last became material (sustained). */
  driftSince?: Millis;

  constructor(objective?: string) {
    this.objective = objective?.trim() || undefined;
    this.objectiveTerms = termSet(this.objective ?? '');
  }

  addUtterance(u: Utterance): void {
    this.transcript.push(u);
    if (this.transcript.length > MAX_TRANSCRIPT) this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
  }

  utterance(id: string): Utterance | undefined {
    return this.transcript.find((u) => u.id === id);
  }

  recent(n: number): Utterance[] {
    return this.transcript.slice(-n);
  }

  utterancesAfter(id: string): Utterance[] {
    const i = this.transcript.findIndex((u) => u.id === id);
    return i < 0 ? [] : this.transcript.slice(i + 1);
  }

  addFact(f: EstablishedFact): void {
    this.facts.push(f);
    if (this.facts.length > MAX_FACTS) this.facts.splice(0, this.facts.length - MAX_FACTS);
  }

  addAssumption(f: EstablishedFact): void {
    this.assumptions.push(f);
    if (this.assumptions.length > MAX_FACTS) this.assumptions.splice(0, this.assumptions.length - MAX_FACTS);
  }

  openGaps(): Gap[] {
    return [...this.gaps.values()].filter((g) =>
      ['DETECTED', 'RESEARCHING', 'OPEN', 'UNRESOLVED', 'PARTIALLY_RESOLVED'].includes(g.status),
    );
  }

  /** Unresolved items that matter to the objective: open threads and unanswered knowledge gaps. */
  unresolvedImportant(minRelevance = 0.4): Gap[] {
    return [...this.gaps.values()].filter(
      (g) =>
        (g.type === 'OPEN_THREAD' || g.type === 'KNOWLEDGE' || g.type === 'EVIDENCE') &&
        ['OPEN', 'UNRESOLVED', 'RESEARCHING', 'DETECTED'].includes(g.status) &&
        g.relevanceToObjective >= minRelevance,
    );
  }

  /**
   * Terms that define "what matters" for this session: objective + open/unresolved items + resolved
   * knowledge. Deliberately excludes arbitrary discussion so tangents don't redefine relevance.
   */
  coreTerms(): Set<string> {
    const s = new Set(this.objectiveTerms);
    for (const g of this.gaps.values()) {
      if (g.type === 'DRIFT' || g.type === 'DECISION') continue;
      for (const t of contentTerms(g.interpretedQuestion)) s.add(t);
    }
    for (const f of this.facts) for (const t of contentTerms(f.text)) s.add(t);
    return s;
  }

  /** Compact text view for LLM prompts — never the full transcript. */
  compactView(): object {
    return {
      objective: this.objective ?? null,
      current_topic_terms: this.topic.terms,
      established_facts: this.facts.slice(-12).map((f) => f.text),
      assumptions: this.assumptions.slice(-8).map((f) => f.text),
      open_items: this.openGaps().map((g) => ({
        id: g.id,
        type: g.type,
        status: g.status,
        question: g.interpretedQuestion,
      })),
      recently_resolved: [...this.gaps.values()]
        .filter((g) => g.status === 'RESOLVED' || g.status === 'NATURALLY_RESOLVED')
        .slice(-6)
        .map((g) => ({ id: g.id, question: g.interpretedQuestion, answer: g.answer ?? '(answered in conversation)' })),
    };
  }
}
