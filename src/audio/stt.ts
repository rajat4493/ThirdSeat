// Speech-to-text boundary. The product never depends on a specific transcription vendor.

export interface SttWord {
  text: string;
  /** Seconds from the start of the audio stream. */
  start: number;
  end: number;
  /** Diarized speaker index within the channel, if the provider separates speakers. */
  speaker?: number;
}

export type SttEvent =
  /** Partial text for live captions only; never analysed. */
  | { type: 'interim'; channel: number; text: string }
  /** Words the provider will not revise any more. */
  | { type: 'final'; channel: number; words: SttWord[] }
  /** The provider detected the end of a spoken turn on this channel. */
  | { type: 'endpoint'; channel: number };

export interface SttStreamOptions {
  sampleRate: number;
  /** 1 = one mixed source; 2 = separate sources (0 = microphone, 1 = call/tab audio). */
  channels: number;
  onEvent: (e: SttEvent) => void;
  onError: (e: Error) => void;
  onClose?: () => void;
}

export interface SttStream {
  /** 16-bit little-endian PCM, interleaved when channels = 2. */
  send(pcm: Buffer): void;
  close(): Promise<void>;
}

export interface SpeechToTextProvider {
  readonly id: string;
  open(opts: SttStreamOptions): Promise<SttStream>;
}

export interface AssembledUtterance {
  channel: number;
  speaker?: number;
  text: string;
  start: number;
  end: number;
}

/**
 * Turns final words into conversational utterances: one per speaker turn, flushed at endpoints.
 * A speaker change inside a final segment splits it, so "who answered whom" survives transcription.
 */
export class UtteranceAssembler {
  private buffers = new Map<number, SttWord[]>();
  private emit: (u: AssembledUtterance) => void;
  /** Flush a turn that runs longer than this even without an endpoint (monologues). */
  maxTurnSeconds: number;

  constructor(emit: (u: AssembledUtterance) => void, maxTurnSeconds = 30) {
    this.emit = emit;
    this.maxTurnSeconds = maxTurnSeconds;
  }

  handle(e: SttEvent): void {
    if (e.type === 'interim') return;
    if (e.type === 'endpoint') return this.flush(e.channel);
    if (!this.buffers.has(e.channel)) this.buffers.set(e.channel, []);
    for (const w of e.words) {
      const last = this.buffers.get(e.channel)!.at(-1);
      if (last && last.speaker !== w.speaker) this.flush(e.channel);
      this.buffers.get(e.channel)!.push(w);
    }
    const buf = this.buffers.get(e.channel)!;
    if (buf.length && buf.at(-1)!.end - buf[0].start > this.maxTurnSeconds) this.flush(e.channel);
  }

  flush(channel?: number): void {
    for (const ch of channel === undefined ? [...this.buffers.keys()] : [channel]) {
      const buf = this.buffers.get(ch);
      if (!buf || buf.length === 0) continue;
      const text = buf.map((w) => w.text).join(' ').replace(/\s+([,.?!;:])/g, '$1').trim();
      if (text) this.emit({ channel: ch, speaker: buf[0].speaker, text, start: buf[0].start, end: buf.at(-1)!.end });
      this.buffers.set(ch, []);
    }
  }
}

/** Generic speaker labels; participants can rename them in the UI. */
export function speakerLabel(channels: number, channel: number, speaker?: number): string {
  const n = speaker === undefined ? '' : ` ${speaker + 1}`;
  if (channels === 1) return speaker === undefined ? 'Room' : `Speaker${n}`;
  return channel === 0 ? `Mic${n}` : `Call${n}`;
}
