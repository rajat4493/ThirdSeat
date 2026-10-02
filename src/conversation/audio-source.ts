// Live audio as a ConversationSource: PCM frames in → speech-to-text → speaker-separated utterances out.
// The engine sees ordinary utterances; it never knows they came from audio.

import type { Clock } from '../clock.ts';
import { UtteranceAssembler, speakerLabel, type SpeechToTextProvider, type SttStream } from '../audio/stt.ts';
import type { ConversationSource, UtteranceSink } from './sources.ts';
import { jaccard, termSet } from '../domain/text.ts';

export interface AudioSourceOptions {
  provider: SpeechToTextProvider;
  clock: Clock;
  sampleRate: number;
  channels: number;
  /** Live captions (interim text). Display only. */
  onCaption?: (c: { speaker: string; text: string }) => void;
  onError?: (e: Error) => void;
}

export class AudioConversationSource implements ConversationSource {
  readonly id: string;
  private o: AudioSourceOptions;
  private stream?: SttStream;
  private sink?: UtteranceSink;
  private assembler: UtteranceAssembler;
  /** Wall-clock time of the first audio frame; provider timestamps are relative to it. */
  private audioStartedAt?: number;
  bytesReceived = 0;
  /** Speech end → utterance delivered, per utterance (transcription latency). */
  readonly sttLatencyMs: number[] = [];

  constructor(o: AudioSourceOptions) {
    this.o = o;
    this.id = `audio:${o.provider.id}`;
    this.assembler = new UtteranceAssembler((u) => {
      if (!this.sink) return;
      const now = this.o.clock.now();
      // Stamp the utterance with when it was *spoken*, so time-to-intervention includes transcription delay.
      const spokenEnd = this.audioStartedAt !== undefined ? Math.min(now, this.audioStartedAt + u.end * 1000) : now;
      if (this.isEcho(u.channel, u.text, now)) return;
      this.sttLatencyMs.push(now - spokenEnd);
      if (this.sttLatencyMs.length > 500) this.sttLatencyMs.shift();
      this.sink({ speaker: speakerLabel(this.o.channels, u.channel, u.speaker), text: u.text, at: spokenEnd });
    });
  }

  private recentCall: { text: string; at: number }[] = [];

  /**
   * In call mode without headphones the microphone also hears the call. Drop a microphone utterance
   * that repeats something the call channel delivered moments ago.
   */
  private isEcho(channel: number, text: string, now: number): boolean {
    if (this.o.channels < 2) return false;
    this.recentCall = this.recentCall.filter((r) => now - r.at < 8000);
    if (channel === 1) {
      this.recentCall.push({ text, at: now });
      return false;
    }
    const t = termSet(text);
    return t.size >= 2 && this.recentCall.some((r) => jaccard(t, termSet(r.text)) >= 0.6);
  }

  /** Opens the speech-to-text stream. Must resolve before audio is pushed. */
  async open(): Promise<void> {
    this.stream = await this.o.provider.open({
      sampleRate: this.o.sampleRate,
      channels: this.o.channels,
      onEvent: (e) => {
        if (e.type === 'interim') this.o.onCaption?.({ speaker: speakerLabel(this.o.channels, e.channel), text: e.text });
        this.assembler.handle(e);
      },
      onError: (e) => this.o.onError?.(e),
    });
  }

  start(sink: UtteranceSink): void {
    this.sink = sink;
  }

  pushAudio(pcm: Buffer): void {
    if (!this.stream) throw new Error('audio source not open');
    this.audioStartedAt ??= this.o.clock.now();
    this.bytesReceived += pcm.length;
    this.stream.send(pcm);
  }

  stop(): void {
    void this.close();
  }

  async close(): Promise<void> {
    const s = this.stream;
    this.stream = undefined;
    if (s) await s.close();
    this.assembler.flush();
    this.sink = undefined;
  }
}
