// Browser audio pipeline proof: real Chromium captures a (fake-device) microphone, the AudioWorklet
// encodes PCM, the page streams it to the server, the server forwards it to a speech-to-text endpoint
// (a local stand-in speaking Deepgram's protocol, since the real service is not reachable here),
// and the resulting utterances drive the engine and the UI. Screenshots go to docs/evidence/.
// Requires Playwright + Chromium (PLAYWRIGHT_MODULE can point at the module path).

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { startMockDeepgram } from '../tests/mock-deepgram.ts';

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

interface ModeResult { mode: string; audioStatus: string | null; transcriptSpeakers: (string | null)[]; gapCards: (string | null)[]; provider: object; pageErrors: string[]; ok: boolean }

async function runMode(mode: 'room' | 'call', port: number): Promise<ModeResult> {
  const script =
    mode === 'room'
      ? [
          { speaker: 0, text: 'Can Microsoft Teams give an external app access to live transcript data?' },
          { speaker: 1, text: "I assume so, but we'd need to check." },
          { speaker: 0, text: 'Okay, let us sketch the architecture meanwhile.' },
        ]
      : [
          { channel: 1, speaker: 0, text: 'Does Zoom let apps receive raw meeting audio in real time?' },
          { channel: 0, speaker: 0, text: 'No idea, honestly.' },
          { channel: 1, speaker: 1, text: 'Let us move on to pricing for now.' },
        ];
  const mock = await startMockDeepgram(script, { bytesPerTurn: mode === 'room' ? 32000 : 64000 }); // ~1 s of audio per turn
  const server = spawn(process.execPath, ['src/server/main.ts'], {
    env: { ...process.env, PORT: String(port), THIRDSEAT_LLM: 'off', THIRDSEAT_STT: 'deepgram', DEEPGRAM_API_KEY: 'test-key', THIRDSEAT_STT_URL: mock.url },
    stdio: 'pipe',
  });
  let logs = '';
  server.stdout.on('data', (d) => (logs += d));
  for (let i = 0; i < 50 && !logs.includes('listening on'); i++) await new Promise((r) => setTimeout(r, 100));

  const browser = await pw.chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-tab-capture-source-by-title=FakeCall', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  if (mode === 'call') {
    // Stands in for a Teams/Zoom/Meet web call tab that is playing audio.
    const call = await ctx.newPage();
    await call.setContent('<title>FakeCall</title><script>const c=new AudioContext();const o=c.createOscillator();o.frequency.value=330;o.connect(c.destination);o.start();</script>');
  }
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#obj', mode === 'room' ? 'Decide whether to build on Microsoft Teams first.' : 'Choose which meeting platform to support first.');
  await page.selectOption('#audioMode', mode);
  if (mode === 'room') await page.screenshot({ path: 'docs/evidence/audio-01-setup.png' });
  await page.click('#startBtn');
  await page.waitForSelector('.utt', { timeout: 15000 });
  await page.waitForTimeout(mode === 'room' ? 4500 : 5000);
  await page.screenshot({ path: `docs/evidence/audio-02-listening-${mode}.png` });
  const audioStatus = await page.textContent('#audioStatus');
  const transcriptSpeakers = await page.$$eval('.utt .s', (n: Element[]) => n.map((x) => x.textContent));
  const gapCards = await page.$$eval('#now .card .q, #open .card .q, #researching .card .q', (n: Element[]) => n.map((x) => x.textContent));
  await page.click('#micBtn');
  await page.waitForTimeout(500);
  await browser.close();
  server.kill();
  await mock.close();
  const c = mock.connections[0];
  const q = c ? new URL(c.url, 'http://x').searchParams : undefined;
  return {
    mode,
    audioStatus,
    transcriptSpeakers,
    gapCards,
    provider: { channels: q?.get('channels'), multichannel: q?.get('multichannel'), diarize: q?.get('diarize'), sampleRate: q?.get('sample_rate'), authorization: c?.authorization ? 'Token ***' : null, bytesReceived: c?.bytes, nonSilentSamples: c?.nonSilentSamples, nonSilentByChannel: c?.nonSilentByChannel, controls: c?.controls },
    pageErrors: errors,
    ok: !!c && c.nonSilentByChannel.every((n) => n > 1000) && gapCards.length > 0 && errors.length === 0 && q?.get('channels') === (mode === 'call' ? '2' : '1'),
  };
}

const results = [await runMode('room', 4391), await runMode('call', 4392)];
const record = {
  ranAt: new Date().toISOString(),
  note: "Speech recognition is a local stand-in speaking Deepgram's protocol (the real service is unreachable from the build environment). Audio capture (fake microphone device; a real tab playing audio for call mode), AudioWorklet PCM encoding, WebSocket streaming, diarized utterance assembly, the engine and the UI are real.",
  results,
};
await writeFile('docs/evidence/e2e-audio-browser.json', JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
