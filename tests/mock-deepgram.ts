// A stand-in for Deepgram's live streaming endpoint that speaks its wire protocol (Results /
// UtteranceEnd messages, KeepAlive / CloseStream controls). It does not recognise speech: after it
// has received enough real audio bytes it plays back a scripted conversation. Used to test the whole
// audio pipeline without network access to the real provider.

import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

export interface ScriptedTurn {
  channel?: number;
  speaker: number;
  text: string;
}

export interface MockDeepgram {
  url: string;
  connections: { url: string; authorization?: string; bytes: number; nonSilentSamples: number; nonSilentByChannel: number[]; controls: string[] }[];
  close(): Promise<void>;
}

export async function startMockDeepgram(script: ScriptedTurn[], opts: { bytesPerTurn?: number } = {}): Promise<MockDeepgram> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const connections: MockDeepgram['connections'] = [];
  const perTurn = opts.bytesPerTurn ?? 3200; // 0.1 s of 16 kHz mono PCM

  wss.on('connection', (ws: WebSocket, req) => {
    const channels = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('channels') ?? 1);
    const conn = { url: req.url ?? '', authorization: req.headers.authorization, bytes: 0, nonSilentSamples: 0, nonSilentByChannel: new Array(channels).fill(0), controls: [] as string[] };
    connections.push(conn);
    let next = 0;
    let t = 0;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString());
        conn.controls.push(msg.type);
        if (msg.type === 'CloseStream') ws.close();
        return;
      }
      const buf = data as Buffer;
      conn.bytes += buf.length;
      for (let i = 0; i + 1 < buf.length; i += 2) {
        if (Math.abs(buf.readInt16LE(i)) <= 50) continue;
        conn.nonSilentSamples++;
        conn.nonSilentByChannel[(i / 2) % channels]++;
      }
      while (next < script.length && conn.bytes >= perTurn * (next + 1)) {
        const turn = script[next++];
        const words = turn.text.split(/\s+/).map((w, i) => ({ word: w.toLowerCase().replace(/[^a-z0-9']/g, ''), punctuated_word: w, start: t + i * 0.3, end: t + i * 0.3 + 0.25, speaker: turn.speaker }));
        t = words.at(-1)!.end + 0.5;
        const ch = turn.channel ?? 0;
        ws.send(JSON.stringify({ type: 'Results', channel_index: [ch, 2], is_final: false, channel: { alternatives: [{ transcript: turn.text.split(' ').slice(0, 3).join(' ') }] } }));
        ws.send(JSON.stringify({ type: 'Results', channel_index: [ch, 2], is_final: true, speech_final: true, channel: { alternatives: [{ transcript: turn.text, words }] } }));
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/listen`,
    connections,
    close: () => new Promise((r) => wss.close(() => r())),
  };
}

/** A 440 Hz tone as 16-bit PCM — real, non-silent audio bytes. */
export function tone(seconds: number, sampleRate = 16000, channels = 1): Buffer {
  const n = Math.round(seconds * sampleRate);
  const b = Buffer.alloc(n * 2 * channels);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), (i * channels + c) * 2);
  return b;
}
