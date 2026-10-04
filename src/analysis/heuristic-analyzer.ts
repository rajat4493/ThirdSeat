// Deterministic, explainable analyzer. Combines several signals (question form, factuality,
// subject, response classification, speaker change, term overlap) rather than single keywords.
// It is the test oracle and the no-LLM fallback; the LLM analyzer is the richer mode.

import type { Utterance } from '../domain/types.ts';
import { contentTerms, coverage, hasAny, normalise, termSet, tokens } from '../domain/text.ts';
import {
  emptyAnalysis,
  type AnalysisInput,
  type AnalysisOutput,
  type ConversationAnalyzer,
  type OpenQuestionView,
  type QuestionKind,
  type ResponseKind,
} from './types.ts';

// Phrases are in normalised form (lowercase, apostrophes removed).
export const DEFERRAL = [
  'check later', 'check after', 'after the meeting', 'after this meeting', 'after the call', 'look it up later',
  'look into it later', 'ill check', 'ill find out', 'ill look', 'find out later', 'follow up', 'take it offline',
  'come back to', 'get back to', 'well check', 'we can check', 'need to check', 'have to check', 'should check',
  'lets check', 'circle back', 'park that', 'park it', 'look into that', 'someone should check', 'worth checking',
  'need to find out', 'have to find out', 'need to verify', 'we should verify', 'ask them later', 'ill ask',
  'take that offline', 'offline', 'after this call', 'after the call',
];
export const UNCERTAIN = [
  'not sure', 'no idea', 'dont know', 'do not know', 'no clue', 'not certain', 'unclear', 'who knows',
  'cant remember', 'dont remember', 'havent checked', 'never checked', 'not clear', 'beats me', 'no one knows',
  'nobody knows', 'i wonder', 'not a clue', 'havent a clue', 'unsure', 'drawing a blank', 'havent the faintest',
  'no idea', 'couldnt tell you', 'cant tell you', 'couldnt say', 'cant say',
];
export const WEAK = [
  'i think so', 'i think', 'probably', 'maybe', 'i assume', 'i guess', 'i believe', 'almost sure', 'pretty sure',
  'should be', 'possibly', 'if i remember', 'iirc', 'as far as i know', 'afaik', 'i suppose', 'likely',
  'i would think', 'id think', 'i reckon', 'presumably', 'might', 'perhaps', 'in theory',
];
const CONFIDENT_START = ['yes', 'no', 'yeah', 'yep', 'nope', 'correct', 'absolutely', 'definitely', 'it does', 'they do'];
const CONFIDENT_MARKERS = [
  'we already', 'it does', 'it doesnt', 'they do', 'they dont', 'definitely', 'i know', 'confirmed', 'the limit is',
  'it supports', 'we use', 'weve used', 'ive used', 'documented', 'according to', 'i checked', 'ive checked',
  'for sure', 'certainly', 'it isnt', 'there isnt', 'we tested', 'ive seen it',
];
export const ACKNOWLEDGE = [
  'good point', 'good question', 'fair point', 'interesting', 'great question', 'true', 'thats a point',
  'valid point', 'thats fair', 'yeah good point', 'touche',
];
const CONCLUSION = [
  'to conclude', 'the conclusion', 'where does that leave us', 'where are we', 'lets wrap up', 'to wrap up',
  'wrap this up', 'sounds like we', 'so we agree', 'are we agreed', 'so the decision', 'lets decide', 'were done',
  'so overall', 'bottom line', 'so do we go ahead', 'lets make a call', 'ready to decide', 'summing up', 'so in summary',
  'to sum up', 'so where do we land', 'what do we conclude', 'so is it worth', 'are we saying', 'so the answer is',
  'do we have enough to decide', 'make a decision', 'close to a decision', 'call it', 'land this',
];
const COMMITMENT = [
  'should we', 'what should', 'how much should', 'lets decide', 'we need to decide', 'we should build', 'lets build',
  'we will build', 'go with', 'mvp', 'first version', 'launch', 'pricing', 'price', 'charge', 'scope', 'roadmap',
  'commit to', 'next step', 'next steps', 'go ahead', 'green light', 'invest', 'budget for',
];
const SOCIAL = [
  'right', 'you know', 'isnt it', 'dont you think', 'what do you think', 'how about', 'shall we', 'ready',
  'make sense', 'does that make sense', 'agree', 'can you hear', 'can you see', 'sound good', 'you mean',
  'what do you mean', 'really', 'how are you', 'are you there', 'what else', 'anything else', 'got it',
  'see what i mean', 'is that ok', 'is that okay', 'thoughts', 'any thoughts', 'yeah',
];
const STRATEGIC_START = [
  'why', 'how would', 'what if', 'would', 'wouldnt', 'why wouldnt', 'what makes', 'whats stopping', 'who would',
  'will customers', 'will users', 'will people', 'would customers', 'would users', 'would people', 'is it worth',
  'how do we compete', 'how do we differentiate', 'how do we win', 'whats our', 'what is our', 'whats the moat',
  'is there a market', 'is there demand', 'do people', 'do customers', 'do users', 'how big', 'what stops',
];
// "What about the onboarding flow?" proposes a topic; it does not ask for knowledge.
const TOPIC_PROPOSAL = ['what about', 'how about', 'and what about', 'lets talk about', 'moving on to', 'what else'];
const DECISION_START = [
  'should we', 'shall we', 'do we want', 'which one', 'are we choosing', 'do we go with', 'what should we',
  'how much should we', 'what do we charge', 'do we build', 'are we going', 'which option',
];
const FACTUAL_START = [
  'does', 'do', 'did', 'can', 'could', 'is', 'are', 'was', 'were', 'has', 'have', 'what is', 'whats', 'what are',
  'how many', 'how much', 'how long', 'how often', 'which', 'when', 'where', 'who is', 'who makes', 'who owns',
  'what does', 'what do', 'how does', 'how do', 'is there', 'are there', 'will', 'what was', 'what version',
];
const FILLER_PREFIX = ['so', 'ok', 'okay', 'and', 'but', 'hmm', 'um', 'uh', 'well', 'actually', 'also', 'anyway', 'quick question', 'question', 'hey', 'oh', 'right', 'now', 'wait'];
const EMBEDDED_QUESTION = ['dont know if', 'dont know whether', 'not sure if', 'not sure whether', 'wonder if', 'wonder whether', 'do you know if', 'do you know whether', 'does anyone know if', 'does anyone know whether', 'anyone know if', 'unclear whether', 'unclear if'];
const INTERNAL_SUBJECT = ['we', 'our', 'us', 'you', 'your', 'i', 'my'];
const FEASIBILITY = ['technically possible', 'technically feasible', 'we can build it', 'its doable', 'it is doable', 'its feasible', 'it is feasible', 'can be built', 'possible to build', 'we could build it', 'we can technically', 'technically we can', 'technically doable'];
const LEAP = ['then we should build', 'so we should build', 'lets build', 'we should build it', 'then we should do it', 'so we should do it', 'lets do it', 'then lets go', 'so lets go', 'then lets build', 'so lets just build', 'we should just build', 'then we build it', 'so we build it'];
const OPEN_TO_ROOM = ['does anyone know', 'anyone know', 'i wonder', 'do we know', 'does anybody know', 'anybody know', 'is there anyone', 'has anyone', 'quick question for anyone'];
// Verbs that make a hedged statement about a named thing checkable ("I think Teams exposes …").
const CAPABILITY = /\b(supports?|allows?|exposes?|offers?|provides?|includes?|has|have|can(not|'t)?|doesn'?t|don'?t|works with|integrates? with|lets|limits?|caps?|charges?|costs?|requires?|needs?|[a-z]+-limited|is (available|free|limited|deprecated)|was (deprecated|announced|released))\b/i;
const ASSUMPTION = ['assume', 'assuming', 'presumably', 'lets say', 'suppose', 'take for granted', 'i bet'];

function sentences(text: string): string[] {
  return text.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
}

function stripFillers(s: string): string {
  let n = normalise(s).replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of FILLER_PREFIX) {
      if (n.startsWith(f + ' ')) {
        n = n.slice(f.length + 1);
        changed = true;
      }
    }
  }
  return n;
}

function startsWithAny(n: string, list: readonly string[]): string | undefined {
  return list.find((p) => n === p || n.startsWith(p + ' '));
}

const SENTENCE_STARTERS = new Set(
  (
    'the a an this that these those it its we our us you your i my they their he she there here what which who whom whose when where why how ' +
    'can could would should will shall may might must do does did is are was were be has have had not no yes yeah yep ok okay so and but or if ' +
    'then also maybe probably perhaps presumably actually honestly basically anyway well right true sure good great fine let lets last next ' +
    'any some all each every most many much more few one two first second agreed hmm um uh oh hey look see just still even only now'
  ).split(' '),
);

/** Words that look like named things: OutSystems, AWS, SAML, Teams, S3, v2, GPT-4. */
export function namedEntities(raw: string): string[] {
  const out: string[] = [];
  for (const s of sentences(raw)) {
    const words = s.split(/\s+/);
    words.forEach((w, i) => {
      const clean = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#.-]+$/g, '').replace(/[.]+$/, '');
      if (!clean || clean === 'I') return;
      const allCaps = /^[A-Z0-9][A-Z0-9+#-]{1,}$/.test(clean) && /[A-Z]/.test(clean);
      const camel = /^[A-Z][a-z]+[A-Z]/.test(clean) || /^[a-z]+[A-Z]/.test(clean);
      const digit = /[A-Za-z]/.test(clean) && /\d/.test(clean);
      // Sentence-initial capitals count only if the word is not ordinary sentence-starting vocabulary.
      const capitalised = /^[A-Z][a-z]/.test(clean) && (i > 0 || !SENTENCE_STARTERS.has(clean.toLowerCase()));
      if (allCaps || camel || digit || capitalised) out.push(clean);
    });
  }
  return [...new Set(out)];
}

interface QuestionParse {
  kind: QuestionKind;
  sentence: string;
  normalised: string;
  embeddedUncertain: boolean;
}

export function parseQuestion(raw: string): QuestionParse | undefined {
  const ss = sentences(raw);
  // Prefer an explicit question sentence; otherwise an embedded "not sure whether …".
  const candidates = ss.filter((s) => s.endsWith('?'));
  for (const s of candidates.length ? candidates : ss) {
    const n = stripFillers(s);
    const embedded = EMBEDDED_QUESTION.find((p) => n.includes(p));
    const isQ = s.endsWith('?') || !!embedded || !!startsWithAny(n, ['i wonder', 'does anyone know', 'anyone know', 'do you know']);
    if (!isQ) continue;
    const core = embedded ? n.slice(n.indexOf(embedded) + embedded.length).trim() : n.replace(/^(i wonder|does anyone know|anyone know|do you know)\s+(if|whether)?\s*/, '');
    const terms = contentTerms(core);
    let kind: QuestionKind;
    if (startsWithAny(core, DECISION_START)) kind = 'DECISION';
    else if (terms.length < 2 || (hasAny(n, SOCIAL) && terms.length < 4) || startsWithAny(core, TOPIC_PROPOSAL)) kind = 'SOCIAL';
    else if (startsWithAny(core, STRATEGIC_START)) kind = 'STRATEGIC';
    else if (embedded || startsWithAny(core, FACTUAL_START)) kind = 'FACTUAL';
    else kind = s.endsWith('?') ? 'FACTUAL' : 'SOCIAL';
    return { kind, sentence: s, normalised: core, embeddedUncertain: !!embedded };
  }
  return undefined;
}

/** External = about a named thing rather than the group itself. */
function isExternal(q: QuestionParse, raw: string): boolean {
  const ents = namedEntities(q.sentence).filter((e) => !['We', 'Our', 'You'].includes(e));
  const subj = tokens(q.normalised).slice(0, 3);
  const internalSubject = subj.some((t) => INTERNAL_SUBJECT.includes(t));
  if (ents.length > 0) return true;
  return !internalSubject && contentTerms(raw).length >= 3;
}

// Generic patterns (not phrase lists): an action to find something out + a later time is a deferral;
// negated knowing/telling is uncertainty; a qualified "sure" is a hedge.
const DEFERRAL_PATTERN = /\b(look into|check|find out|dig into|verify|follow up|get back|confirm|ask)\b[^.?!]{0,40}\b(later|after(wards)?|tomorrow|next week|offline|after (this|the) (call|meeting))\b/;
const NEGATED_KNOWING = /\b(dont|do not|not|never|no one|nobody|couldnt|cant|cannot)\b[^.?!]{0,25}\b(know|tell|say|remember)\b/;
const QUALIFIED_SURE = /\b(pretty|fairly|quite|almost|reasonably|mostly) (sure|certain|confident)\b/;

export function classifyResponse(text: string): { kind: ResponseKind; phrase: string } | undefined {
  const n = normalise(text);
  let p: string | undefined;
  if ((p = hasAny(n, DEFERRAL))) return { kind: 'DEFERRAL', phrase: p };
  let m: RegExpMatchArray | null;
  if ((m = n.match(DEFERRAL_PATTERN))) return { kind: 'DEFERRAL', phrase: m[0] };
  if ((p = hasAny(n, UNCERTAIN))) return { kind: 'UNCERTAIN', phrase: p };
  if ((m = n.match(NEGATED_KNOWING))) return { kind: 'UNCERTAIN', phrase: m[0] };
  // Hedges outrank confident-sounding words ("I'm fairly sure it does" is not a confident answer).
  if ((m = n.match(QUALIFIED_SURE))) return { kind: 'WEAK_ANSWER', phrase: m[0] };
  if ((p = hasAny(n, WEAK))) return { kind: 'WEAK_ANSWER', phrase: p };
  const stripped = stripFillers(text);
  if ((p = startsWithAny(stripped, CONFIDENT_START))) return { kind: 'CONFIDENT_ANSWER', phrase: p };
  if ((p = hasAny(n, CONFIDENT_MARKERS))) return { kind: 'CONFIDENT_ANSWER', phrase: p };
  if ((p = hasAny(n, ACKNOWLEDGE))) return { kind: 'ACKNOWLEDGE', phrase: p };
  return undefined;
}

function relevanceFor(kind: QuestionKind, question: string, state: AnalysisInput['state']): number {
  if (kind === 'SOCIAL') return 0;
  const core = state.coreTerms();
  const overlap = coverage(termSet(question), core);
  const decisionObjective = !!state.objective && /\b(decide|decision|whether|choose|select|evaluate|validate|validation|assess)\b/i.test(state.objective);
  let base = kind === 'STRATEGIC' ? (decisionObjective ? 0.75 : 0.6) : kind === 'FACTUAL' ? 0.6 : 0.5;
  if (!state.objective) base = Math.min(base, 0.6);
  return Math.min(1, base + 0.3 * overlap);
}

export class HeuristicAnalyzer implements ConversationAnalyzer {
  readonly id = 'heuristic';

  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    const out = emptyAnalysis();
    const { state } = input;
    // Questions raised earlier in this batch become targets for later utterances in the batch.
    const open: OpenQuestionView[] = input.openQuestions.map((q) => ({ ...q }));

    for (const u of input.newUtterances) {
      for (const q of open) q.utterancesSince += 1;
      const q = parseQuestion(u.text);
      const resp = classifyResponse(u.text);

      // 1) Responses attach to the most recent compatible open question.
      let responded = false;
      if (resp || !q) {
        const target = this.pickTarget(u, open, resp?.kind);
        responded = !!target && (!!resp || (target.kind === 'FACTUAL' && this.isSubstantiveAnswer(u, target)));
        if (target && resp) {
          out.responses.push({
            utteranceId: u.id,
            targetId: target.id,
            kind: resp.kind,
            note: `"${resp.phrase}" after ${target.kind.toLowerCase()} question`,
          });
          if (resp.kind === 'CONFIDENT_ANSWER' && target.kind === 'FACTUAL') {
            out.statements.push({ utteranceId: u.id, kind: 'FACT', text: `${target.question} → ${u.text}` });
          }
        } else if (target && !resp && !q && target.kind === 'FACTUAL' && this.isSubstantiveAnswer(u, target)) {
          out.responses.push({ utteranceId: u.id, targetId: target.id, kind: 'CONFIDENT_ANSWER', note: 'specific, unhedged answer by another speaker' });
          out.statements.push({ utteranceId: u.id, kind: 'FACT', text: `${target.question} → ${u.text}` });
        }
      }

      // 2) Open threads being picked up again.
      for (const t of open) {
        if (t.kind !== 'STRATEGIC' || t.utterancesSince < 1) continue;
        const cov = coverage(termSet(t.question), termSet(u.text));
        if (cov >= 0.34 && contentTerms(u.text).length >= 4) {
          const conclusive = /\b(because|the difference|the answer|thats why|so the reason|we win|our edge|advantage is)\b/i.test(u.text);
          out.threadActivity.push({
            utteranceId: u.id,
            targetId: t.id,
            kind: conclusive && !hasAny(u.text, WEAK) && !hasAny(u.text, UNCERTAIN) ? 'ADDRESSED' : 'DISCUSSING',
            note: conclusive ? 'thread terms + explanatory answer' : 'thread terms reappear',
          });
        }
      }

      // 3) New question.
      if (q && q.kind !== 'SOCIAL') {
        const interpreted = this.interpret(q, u, state);
        const researchable = q.kind === 'FACTUAL' && isExternal(q, u.text);
        out.questions.push({
          utteranceId: u.id,
          kind: q.kind,
          interpretedQuestion: interpreted,
          researchable,
          relevance: relevanceFor(q.kind, interpreted, state),
          note: `${q.kind.toLowerCase()} question${researchable ? ' about a named/external subject' : ''}${q.embeddedUncertain ? ' (asker uncertain)' : ''}`,
          openToRoom: !!hasAny(u.text, OPEN_TO_ROOM),
          origin: 'question',
        });
        const toRoom = !!hasAny(u.text, OPEN_TO_ROOM);
        // "Does anyone know if…" is an invitation, not an admission; it is handled as open-to-room instead.
        if (q.embeddedUncertain && !toRoom) {
          out.responses.push({ utteranceId: u.id, targetId: u.id, kind: 'UNCERTAIN', note: 'asker states they do not know' });
        }
        open.unshift({ id: u.id, question: interpreted, askedBy: u.speaker, triggerUtteranceId: u.id, kind: q.kind, utterancesSince: 0 });
      }

      // 3b) A hedged factual claim about a named thing is a question nobody asked: verify it.
      if (!q && !responded) {
        const claim = this.tentativeClaim(u.text);
        if (claim) {
          out.questions.push({
            utteranceId: u.id,
            kind: 'FACTUAL',
            interpretedQuestion: claim,
            researchable: true,
            relevance: relevanceFor('FACTUAL', claim, state),
            note: 'tentative factual claim about a named subject',
            origin: 'tentative_claim',
          });
          out.responses.push({ utteranceId: u.id, targetId: u.id, kind: 'WEAK_ANSWER', note: 'stated tentatively' });
          open.unshift({ id: u.id, question: claim, askedBy: u.speaker, triggerUtteranceId: u.id, kind: 'FACTUAL', utterancesSince: 0 });
        }
      }

      // 4) Statements, conclusion and commitment signals, reasoning leaps.
      if (!q && hasAny(u.text, ASSUMPTION)) out.statements.push({ utteranceId: u.id, kind: 'ASSUMPTION', text: u.text });
      const concl = hasAny(u.text, CONCLUSION);
      if (concl) out.conclusionSignals.push({ utteranceId: u.id, note: `"${concl}"` });
      const commit = hasAny(u.text, COMMITMENT);
      if (commit) out.commitmentSignals.push({ utteranceId: u.id, note: `"${commit}"` });
      const leap = hasAny(u.text, LEAP);
      if (leap) {
        const prior = state.transcript.filter((x) => x.seq < u.seq).slice(-3);
        const premise = [...prior].reverse().find((p) => hasAny(p.text, FEASIBILITY)) ?? (hasAny(u.text, FEASIBILITY) ? u : undefined);
        if (premise) {
          out.reasoning.push({
            utteranceId: u.id,
            premiseUtteranceId: premise.id,
            text: 'Feasibility was treated as sufficient reason to proceed.',
          });
        }
      }
    }
    return out;
  }

  private pickTarget(u: Utterance, open: OpenQuestionView[], kind?: ResponseKind): OpenQuestionView | undefined {
    const terms = termSet(u.text);
    for (const q of open) {
      if (q.triggerUtteranceId === u.id) continue;
      const near = q.utterancesSince <= 3;
      const overlap = coverage(termSet(q.question), terms) >= 0.34;
      const otherSpeaker = q.askedBy !== u.speaker || u.speaker === 'Room';
      // A bare "yes"/"not sure" only binds to a question asked moments ago; later ones must overlap in content.
      if (near && (otherSpeaker || kind === 'UNCERTAIN' || kind === 'DEFERRAL')) return q;
      if (overlap && q.utterancesSince <= 40) return q;
    }
    return undefined;
  }

  /** "I think Teams exposes live transcripts to apps." → "Is it true that Teams exposes live transcripts to apps?" */
  private tentativeClaim(text: string): string | undefined {
    const hedge = hasAny(text, WEAK);
    if (!hedge || !CAPABILITY.test(text)) return undefined;
    const sentence = sentences(text).find((s) => hasAny(s, WEAK) && CAPABILITY.test(s)) ?? text;
    if (namedEntities(sentence).filter((e) => !['We', 'Our', 'You', 'They'].includes(e)).length === 0) return undefined;
    if (contentTerms(sentence).length < 3) return undefined;
    const clause = sentence
      .replace(/^(so|and|but|well|yeah|ok|okay)[,\s]+/i, '')
      .replace(/^(i think|i believe|i guess|i assume|i suppose|i reckon|i'?m pretty sure|pretty sure|probably|maybe|perhaps|presumably|as far as i know|afaik|if i remember( correctly)?|iirc)[,\s]+(that\s+)?/i, '')
      .replace(/[.!]+$/, '')
      .trim();
    if (!clause || clause === sentence.replace(/[.!]+$/, '').trim()) {
      // Hedge was not at the start ("Teams probably supports it"): drop the hedge word in place.
      const stripped = sentence.replace(new RegExp(`\\b${hedge.replace(/ /g, '\\s+')}\\b[,]?\\s*`, 'i'), '').replace(/[.!]+$/, '').trim();
      return `Is it true that ${stripped}?`;
    }
    return `Is it true that ${clause}?`;
  }

  private isSubstantiveAnswer(u: Utterance, q: OpenQuestionView): boolean {
    if (q.utterancesSince > 2 || q.askedBy === u.speaker) return false;
    const terms = contentTerms(u.text);
    return terms.length >= 5 && coverage(termSet(q.question), new Set(terms)) >= 0.25;
  }

  /** Make the question standalone: strip fillers, and add prior context for pronoun-only questions. */
  private interpret(q: QuestionParse, u: Utterance, state: AnalysisInput['state']): string {
    let text = q.sentence.replace(/^(so|ok|okay|and|but|hmm|um|uh|well|actually|anyway|quick question)[,:\s]+/i, '').trim();
    if (q.embeddedUncertain) {
      const n = normalise(text);
      const p = EMBEDDED_QUESTION.find((e) => n.includes(e));
      if (p) {
        const raw = text.replace(/^.*?\b(if|whether)\s+/i, '');
        text = raw.charAt(0).toUpperCase() + raw.slice(1).replace(/[.?]+$/, '') + '?';
      }
    }
    // A pronoun subject ("does it…", "can they…") needs the previous utterance to be standalone.
    const subject = tokens(text).slice(0, 3);
    const pronounSubject = subject.some((t) => ['it', 'that', 'this', 'they', 'them', 'those'].includes(t));
    if (pronounSubject || (namedEntities(text).length === 0 && /\b(it|that|this|they|them|those)\b/i.test(text))) {
      const prev = state.transcript.filter((x) => x.seq < u.seq).slice(-1)[0];
      if (prev) text = `${text} (context: "${prev.text}")`;
    }
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
}
