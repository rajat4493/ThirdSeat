// Deepgram streaming speech-to-text (live websocket API) with speaker diarization.
// Audio sent here leaves the machine: see duck/HANDOVER.md → External services.

import WebSocket from 'ws';
import type { SpeechToTextProvider, SttStream, SttStreamOptions, SttWord } from './stt.ts';

export interface DeepgramOptions {
  apiKey: string;
  /** Override for self-hosted Deepgram or a test double. */
  url?: string;
  model?: string;
  language?: string;
}

interface DeepgramResult {
  type: 'Results';
  channel_index?: number[];
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string; words?: { word: string; punctuated_word?: string; start: number; end: number; speaker?: number }[] }[] };
}

export class DeepgramStt implements SpeechToTextProvider {
  readonly id: string;
  private opts: DeepgramOptions;

  constructor(opts: DeepgramOptions) {
    this.opts = opts;
    this.id = `deepgram:${opts.model ?? 'nova-3'}`;
  }

  buildUrl(o: Pick<SttStreamOptions, 'sampleRate' | 'channels'>): string {
    const u = new URL(this.opts.url ?? 'wss://api.deepgram.com/v1/listen');
    const p: Record<string, string> = {
      model: this.opts.model ?? 'nova-3',
      language: this.opts.language ?? 'en',
      encoding: 'linear16',
      sample_rate: String(o.sampleRate),
      channels: String(o.channels),
      multichannel: String(o.channels > 1),
      diarize: 'true',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '400',
      utterance_end_ms: '1200',
      vad_events: 'true',
    };
    for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
    return u.toString();
  }

  open(o: SttStreamOptions): Promise<SttStream> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.buildUrl(o), { headers: { Authorization: `Token ${this.opts.apiKey}` } });
      let opened = false;
      // Deepgram closes idle streams; keep it alive while people are silent.
      const keepAlive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'KeepAlive' })), 5000);

      ws.on('open', () => {
        opened = true;
        resolve({
          send: (pcm) => ws.readyState === WebSocket.OPEN && ws.send(pcm),
          close: () =>
            new Promise<void>((done) => {
              clearInterval(keepAlive);
              if (ws.readyState !== WebSocket.OPEN) return done();
              ws.send(JSON.stringify({ type: 'CloseStream' }));
              const t = setTimeout(() => ws.terminate(), 3000);
              ws.once('close', () => {
                clearTimeout(t);
                done();
              });
            }),
        });
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg: DeepgramResult | { type: 'UtteranceEnd'; channel?: number[] } | { type: string };
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.type === 'UtteranceEnd') {
          const ch = (msg as { channel?: number[] }).channel?.[0] ?? 0;
          o.onEvent({ type: 'endpoint', channel: ch });
          return;
        }
        if (msg.type !== 'Results') return;
        const r = msg as DeepgramResult;
        const channel = r.channel_index?.[0] ?? 0;
        const alt = r.channel?.alternatives?.[0];
        if (!alt) return;
        if (!r.is_final) {
          if (alt.transcript) o.onEvent({ type: 'interim', channel, text: alt.transcript });
          return;
        }
        const words: SttWord[] = (alt.words ?? []).map((w) => ({ text: w.punctuated_word ?? w.word, start: w.start, end: w.end, speaker: w.speaker }));
        if (words.length) o.onEvent({ type: 'final', channel, words });
        if (r.speech_final) o.onEvent({ type: 'endpoint', channel });
      });
      ws.on('unexpected-response', (_req, res) => {
        const err = new Error(`speech-to-text connection refused (HTTP ${res.statusCode})`);
        if (!opened) reject(err);
        else o.onError(err);
      });
      ws.on('error', (e) => (opened ? o.onError(e) : reject(e)));
      ws.on('close', () => {
        clearInterval(keepAlive);
        o.onClose?.();
      });
    });
  }
}
