// ThirdSeat as a speaking participant. It speaks only on gap points (the same contributions it would show on
// screen), takes turns like a person (waits for a pause, never talks over anyone, yields when interrupted),
// answers when addressed within its job, and ignores its own voice coming back through the microphone.

import type { Clock } from '../clock.ts';
import type { FeedbackFlag, Gap, Millis } from '../domain/types.ts';
import { newId } from '../domain/ids.ts';
import { coverage, termSet, truncate } from '../domain/text.ts';
import type { GapEngine } from '../gaps/engine.ts';
import type { IncomingUtterance } from '../conversation/sources.ts';
import type { LlmClient } from '../llm/client.ts';
import { SpeechComposer, speakable, spokenQuestion, topicOf } from './composer.ts';
import { classifyAddressed, classifyAddressedWithLlm, detectAddressed, type AddressedIntent } from './addressed.ts';

export interface VoiceConfig {
  enabled: boolean;
  /** Names people use to address it. */
  names: string[];
  /** Speak only after this much silence from the humans. */
  silenceMs: Millis;
  /** A contribution not spoken within this time stays on screen only (the moment has passed). */
  maxWaitMs: Millis;
  /** Minimum gap between unsolicited spoken contributions. Replies when addressed are exempt. */
  cooldownMs: Millis;
  /** Unsolicited contributions below this priority are screen-only. */
  minPriority: number;
  /** Drop heard utterances that repeat ThirdSeat's own recent speech (its voice picked up by the microphone). */
  echoWindowMs: Millis;
  /** Approximate speaking rate used when the client does not report playback. */
  wordsPerSecond: number;
}

export const DEFAULT_VOICE: VoiceConfig = {
  enabled: false,
  names: ['ThirdSeat', 'Third Seat'],
  silenceMs: 1500,
  maxWaitMs: 20_000,
  cooldownMs: 30_000,
  minPriority: 0.5,
  echoWindowMs: 20_000,
  wordsPerSecond: 2.6,
};

export type SpeakKind = 'contribution' | 'reply';

export interface SpeakRequest {
  id: string;
  text: string;
  kind: SpeakKind;
  gapId?: string;
  intent?: AddressedIntent;
  queuedAt: Millis;
  spokenAt?: Millis;
}

export type VoiceEvent =
  | { type: 'speak'; request: SpeakRequest }
  | { type: 'speak-stop'; id: string; reason: string }
  | { type: 'voice-state'; enabled: boolean; muted: boolean }
  | { type: 'voice-log'; at: Millis; message: string };

interface Pending {
  id: string;
  kind: SpeakKind;
  priority: number;
  queuedAt: Millis;
  gap?: Gap;
  text?: string;
  intent?: AddressedIntent;
}

export interface VoiceMetrics {
  spokenContributions: number;
  spokenReplies: number;
  interrupted: number;
  droppedMomentPassed: number;
  screenOnly: number;
  echoDropped: number;
  addressed: Record<string, number>;
  /** Trigger (question spoken) → ThirdSeat starts speaking, for spoken knowledge contributions. */
  triggerToSpeechMs: number[];
}

export class VoiceAgent {
  readonly cfg: VoiceConfig;
  private engine: GapEngine;
  private clock: Clock;
  private composer: SpeechComposer;
  private llm?: LlmClient;
  private listeners: ((e: VoiceEvent) => void)[] = [];
  private queue: Pending[] = [];
  private composing = false;
  muted = false;
  private lastHumanActivityAt = -Infinity;
  private speaking?: { req: SpeakRequest; until: Millis };
  private lastContributionAt = -Infinity;
  private recentSpeech: { text: string; at: Millis }[] = [];
  private lastSpoken?: SpeakRequest;
  private lastKnowledgeGapId?: string;
  private pendingAsks = new Set<string>();
  readonly metrics: VoiceMetrics = { spokenContributions: 0, spokenReplies: 0, interrupted: 0, droppedMomentPassed: 0, screenOnly: 0, echoDropped: 0, addressed: {}, triggerToSpeechMs: [] };
  readonly spoken: SpeakRequest[] = [];

  constructor(o: { engine: GapEngine; clock: Clock; llm?: LlmClient; config?: Partial<VoiceConfig> }) {
    this.engine = o.engine;
    this.clock = o.clock;
    this.llm = o.llm;
    this.composer = new SpeechComposer(o.llm);
    this.cfg = { ...DEFAULT_VOICE, ...o.config };
    this.engine.on((e) => {
      if (e.type === 'intervention') this.onIntervention(e.gap);
      if (e.type === 'gap') this.onGap(e.gap);
    });
  }

  on(l: (e: VoiceEvent) => void): () => void {
    this.listeners.push(l);
    return () => (this.listeners = this.listeners.filter((x) => x !== l));
  }

  private emit(e: VoiceEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* ignore */
      }
    }
  }

  private log(message: string): void {
    this.emit({ type: 'voice-log', at: this.clock.now(), message });
  }

  get active(): boolean {
    return this.cfg.enabled && !this.muted;
  }

  setEnabled(on: boolean): void {
    this.cfg.enabled = on;
    if (!on) this.queue = [];
    this.emit({ type: 'voice-state', enabled: this.cfg.enabled, muted: this.muted });
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (m) {
      this.queue = this.queue.filter((p) => p.kind === 'reply' && p.intent === 'MUTE');
      if (this.speaking) this.stop('muted');
    }
    this.emit({ type: 'voice-state', enabled: this.cfg.enabled, muted: this.muted });
  }

  // ───────────── input routing ─────────────

  /**
   * Every heard utterance passes through here before the engine:
   *  'drop'    — ThirdSeat hearing itself
   *  'handled' — spoken to ThirdSeat; answered here (not analysed as conversation)
   *  'pass'    — ordinary conversation, for the engine
   */
  receive(u: IncomingUtterance): 'drop' | 'handled' | 'pass' {
    const now = u.at ?? this.clock.now();
    if (this.isOwnEcho(u.text, now)) {
      this.metrics.echoDropped++;
      this.log(`ignored my own voice picked up by the microphone: "${truncate(u.text, 50)}"`);
      return 'drop';
    }
    this.humanActivity(now);
    if (!this.cfg.enabled) return 'pass';
    const addressed = detectAddressed(u.text, this.cfg.names);
    if (!addressed) return 'pass';
    void this.handleAddressed(addressed.rest, u);
    return 'handled';
  }

  /** A person is speaking now (utterance, live caption, or voice activity). Yields the floor if ThirdSeat is talking. */
  humanActivity(at: Millis = this.clock.now(), heardText?: string): void {
    if (heardText !== undefined) {
      // A live caption: ignore ThirdSeat's own voice coming back, and (while it speaks) fragments too short to judge.
      if (this.isOwnEcho(heardText, at)) return;
      if (this.speaking && termSet(heardText).size < 2) return;
    }
    this.lastHumanActivityAt = Math.max(this.lastHumanActivityAt, at);
    if (this.speaking && at >= (this.speaking.req.spokenAt ?? 0) + 300) this.stop('a person started speaking');
  }

  private isOwnEcho(text: string, now: Millis): boolean {
    this.recentSpeech = this.recentSpeech.filter((r) => now - r.at < this.cfg.echoWindowMs);
    const t = termSet(text);
    if (t.size < 2) return false;
    return this.recentSpeech.some((r) => {
      const s = termSet(r.text);
      // Heard text is (part of) what ThirdSeat said: most of the heard words occur in its speech.
      return coverage(t, s) >= 0.7;
    });
  }

  // ───────────── what to say ─────────────

  private onIntervention(gap: Gap): void {
    if (!this.cfg.enabled) return;
    if (gap.type === 'KNOWLEDGE') this.lastKnowledgeGapId = gap.id;
    const isReply = gap.reason === 'USER_REQUESTED' && this.pendingAsks.has(gap.id);
    const can = speakable(gap);
    if (!can.ok) {
      this.metrics.screenOnly++;
      this.log(`screen only (${can.why}): "${truncate(gap.interpretedQuestion, 50)}"`);
      if (isReply) this.enqueueReply("I found something, but I can't verify it well enough to say it — it's on screen.", 'RESEARCH');
      this.pendingAsks.delete(gap.id);
      return;
    }
    if (!isReply && gap.priority < this.cfg.minPriority && gap.type === 'KNOWLEDGE') {
      this.metrics.screenOnly++;
      this.log(`screen only (priority ${gap.priority}): "${truncate(gap.interpretedQuestion, 50)}"`);
      return;
    }
    this.pendingAsks.delete(gap.id);
    this.queue.push({ id: newId('say'), kind: isReply ? 'reply' : 'contribution', priority: isReply ? 2 : gap.priority, queuedAt: this.clock.now(), gap, intent: isReply ? 'RESEARCH' : undefined });
    this.tick();
  }

  private onGap(gap: Gap): void {
    if (this.pendingAsks.has(gap.id) && gap.status === 'UNRESOLVED') {
      this.pendingAsks.delete(gap.id);
      this.enqueueReply(`I couldn't find a reliable answer on ${topicOf(gap.interpretedQuestion)}.`, 'RESEARCH');
    }
  }

  private enqueueReply(text: string, intent: AddressedIntent): void {
    if (this.muted) return; // muted means silent; anything looked up still appears on screen
    this.queue.push({ id: newId('say'), kind: 'reply', priority: 2, queuedAt: this.clock.now(), text, intent });
    this.tick();
  }

  private async handleAddressed(rest: string, u: IncomingUtterance): Promise<void> {
    const ctx = this.engine.state.recent(6).map((x) => `${x.speaker}: ${x.text}`);
    const { intent, question } = this.llm ? await classifyAddressedWithLlm(this.llm, rest, ctx) : classifyAddressed(rest);
    this.metrics.addressed[intent] = (this.metrics.addressed[intent] ?? 0) + 1;
    this.log(`addressed by ${u.speaker}: ${intent.toLowerCase()}`);
    // Shown in the transcript, but never analysed as conversation (a lookup records its own entry).
    if (intent !== 'RESEARCH' || !question) this.engine.ingestOwn(u.text, `${u.speaker} → ThirdSeat`);
    const lastGap = this.lastKnowledgeGapId ? this.engine.state.gaps.get(this.lastKnowledgeGapId) : undefined;
    switch (intent) {
      case 'MUTE':
        this.setMuted(true);
        return; // silence is the acknowledgement; the UI shows it is muted
      case 'UNMUTE':
        if (!this.muted) return;
        this.setMuted(false);
        return this.enqueueReply("I'm back.", intent);
      case 'THANKS':
      case 'NONE':
        return;
      case 'SOURCE': {
        const src = lastGap?.evidence.find((e) => e.url) ?? lastGap?.evidence[0];
        return this.enqueueReply(src ? `That's from ${src.title}. The link is on screen.` : "I haven't cited anything yet.", intent);
      }
      case 'CONFIDENCE': {
        if (!lastGap?.confidence) return this.enqueueReply("I haven't given an answer yet.", intent);
        const c = lastGap.confidence;
        return this.enqueueReply(
          c === 'HIGH' ? 'Pretty sure — an official source says it directly.' : c === 'LIKELY' ? 'Fairly, not fully — the source only partly covers it.' : "Not sure at all — I couldn't verify it.",
          intent,
        );
      }
      case 'WRONG': {
        if (lastGap) this.engine.flag(lastGap.id, 'INCORRECT' as FeedbackFlag);
        return this.enqueueReply("Noted — I've flagged that as possibly wrong.", intent);
      }
      case 'OPEN_ITEMS': {
        const open = this.engine.state.unresolvedImportant(0.4);
        return this.enqueueReply(open.length ? `Still open: ${open.slice(0, 3).map((g) => spokenQuestion(g.interpretedQuestion)).join(' ')}` : "Nothing I'm tracking is still open.", intent);
      }
      case 'REPEAT':
        return this.lastSpoken ? this.enqueueReply(this.lastSpoken.text, intent) : undefined;
      case 'RESEARCH': {
        if (!question) return this.enqueueReply("Sorry, what should I look up?", intent);
        const gap = this.engine.ask(question, u.speaker);
        this.pendingAsks.add(gap.id);
        return this.enqueueReply('Let me check.', intent);
      }
      case 'OUT_OF_SCOPE':
        return this.enqueueReply("That one's yours — I'll jump in on open questions and facts.", intent);
    }
  }

  // ───────────── turn-taking ─────────────

  /** Called on a timer and after events. Speaks the most important pending item if the floor is free. */
  tick(): void {
    const now = this.clock.now();
    if (this.speaking && now >= this.speaking.until) this.finish(this.speaking.req.id);
    // The moment passes: unspoken items expire; resolved/dismissed ones are withdrawn.
    this.queue = this.queue.filter((p) => {
      const stale = now - p.queuedAt > (p.kind === 'reply' ? this.cfg.maxWaitMs * 1.5 : this.cfg.maxWaitMs);
      const settled = p.gap && ['DISMISSED', 'NATURALLY_RESOLVED', 'NOT_A_GAP'].includes(this.engine.state.gaps.get(p.gap.id)?.status ?? '');
      if (stale || settled) {
        this.metrics.droppedMomentPassed++;
        this.log(`not spoken (${settled ? 'already resolved' : 'the moment passed'}): ${p.gap ? `"${truncate(p.gap.interpretedQuestion, 50)}"` : p.text}`);
        return false;
      }
      return true;
    });
    if (!this.active) return;
    if (this.speaking || this.composing || this.queue.length === 0) return;
    if (now - this.lastHumanActivityAt < this.cfg.silenceMs) return; // never talk over people
    const sorted = [...this.queue].sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
    const next = sorted.find((p) => p.kind === 'reply' || now - this.lastContributionAt >= this.cfg.cooldownMs);
    if (!next) return;
    this.queue = this.queue.filter((p) => p !== next);
    void this.say(next);
  }

  private async say(p: Pending): Promise<void> {
    this.composing = true;
    let text: string;
    try {
      text = p.text ?? (await this.composer.compose(this.engine.state.gaps.get(p.gap!.id) ?? p.gap!));
    } finally {
      this.composing = false;
    }
    const now = this.clock.now();
    // Someone may have started talking while the sentence was being prepared.
    if (now - this.lastHumanActivityAt < this.cfg.silenceMs) {
      this.queue.unshift(p);
      return;
    }
    const req: SpeakRequest = { id: p.id, text, kind: p.kind, gapId: p.gap?.id, intent: p.intent, queuedAt: p.queuedAt, spokenAt: now };
    const seconds = text.split(/\s+/).length / this.cfg.wordsPerSecond + 0.5;
    this.speaking = { req, until: now + seconds * 1000 };
    this.recentSpeech.push({ text, at: now });
    this.lastSpoken = req;
    this.spoken.push(req);
    if (p.kind === 'contribution') {
      this.lastContributionAt = now;
      this.metrics.spokenContributions++;
      if (p.gap?.type === 'KNOWLEDGE') this.metrics.triggerToSpeechMs.push(now - p.gap.timing.triggerAt);
    } else this.metrics.spokenReplies++;
    this.engine.ingestOwn(text);
    this.emit({ type: 'speak', request: req });
  }

  /** Playback reports from the client (or the estimate in tick) end the turn. */
  finish(id: string): void {
    if (this.speaking?.req.id !== id) return;
    this.speaking = undefined;
    // Speaking ends a turn; the people get the floor first.
    this.lastHumanActivityAt = Math.max(this.lastHumanActivityAt, this.clock.now() - this.cfg.silenceMs + 500);
  }

  stop(reason: string): void {
    if (!this.speaking) return;
    const id = this.speaking.req.id;
    this.speaking = undefined;
    this.metrics.interrupted++;
    this.log(`stopped speaking: ${reason}`);
    this.emit({ type: 'speak-stop', id, reason });
  }

  /** Client playback status. */
  playback(id: string, status: 'started' | 'finished' | 'interrupted' | 'failed'): void {
    if (status === 'finished' || status === 'failed') this.finish(id);
    if (status === 'interrupted' && this.speaking?.req.id === id) {
      this.speaking = undefined;
      this.metrics.interrupted++;
      this.log('stopped speaking: interrupted (client)');
    }
  }

  isSpeaking(): boolean {
    return !!this.speaking;
  }
}
