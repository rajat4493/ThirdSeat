// Server-side text-to-speech (optional). Without it, the browser speaks with its built-in voices.
// A server voice is needed to route ThirdSeat's speech to a chosen output device (e.g. a virtual
// microphone feeding a web call). Speech text sent here leaves the machine.

export interface TextToSpeech {
  readonly id: string;
  synthesize(text: string, signal?: AbortSignal): Promise<{ audio: Buffer; contentType: string }>;
}

export class DeepgramTts implements TextToSpeech {
  readonly id: string;
  private apiKey: string;
  private url: string;
  private voice: string;

  constructor(o: { apiKey: string; voice?: string; url?: string }) {
    this.apiKey = o.apiKey;
    this.voice = o.voice ?? 'aura-2-thalia-en';
    this.url = o.url ?? 'https://api.deepgram.com/v1/speak';
    this.id = `deepgram-tts:${this.voice}`;
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<{ audio: Buffer; contentType: string }> {
    const u = new URL(this.url);
    u.searchParams.set('model', this.voice);
    const res = await fetch(u, {
      method: 'POST',
      headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`text-to-speech failed (HTTP ${res.status})`);
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'audio/mpeg' };
  }
}
