// Browser proof of voice participation: real server + UI, voice switched on at setup, a scripted rehearsal,
// a person addressing ThirdSeat by name, an interruption, and ThirdSeat's own voice heard back.
// Headless Chromium has no audio output, so speechSynthesis is replaced by a recorder that "speaks" for 2.5 s.
// Requires Playwright + Chromium (PLAYWRIGHT_MODULE can point at the module path).

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const PORT = 4393;
const server = spawn(process.execPath, ['src/server/main.ts'], { env: { ...process.env, PORT: String(PORT), THIRDSEAT_LLM: 'off' }, stdio: 'pipe' });
let logs = '';
server.stdout.on('data', (d) => (logs += d));
for (let i = 0; i < 50 && !logs.includes('listening on'); i++) await new Promise((r) => setTimeout(r, 100));

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
await page.addInitScript(() => {
  const w = window as unknown as Record<string, unknown>;
  w.__spoken = [] as string[];
  w.__cancelled = 0;
  let cur: SpeechSynthesisUtterance | null = null;
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      speak(u: SpeechSynthesisUtterance) {
        (w.__spoken as string[]).push(u.text);
        cur = u;
        setTimeout(() => {
          if (cur === u) {
            cur = null;
            u.onend?.(new Event('end') as SpeechSynthesisEvent);
          }
        }, 2500);
      },
      cancel() {
        (w.__cancelled as number)++;
        cur = null;
      },
      getVoices: () => [],
    },
  });
});
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.check('#voiceOn');
await page.screenshot({ path: 'docs/evidence/voice-01-setup.png' });
await page.click('summary');
await page.selectOption('#scenario', 's10-conclusion');
await page.selectOption('#speed', '10');
await page.click('#rehearseBtn');
await page.waitForTimeout(10_000); // 70 s script at 10× + pause + speaking
const afterRehearsal = await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.slice());
await page.screenshot({ path: 'docs/evidence/voice-02-spoke.png' });

const say = async (speaker: string, text: string) => {
  await page.selectOption('#speaker', speaker);
  await page.fill('#text', text);
  await page.click('#say button[type=submit]');
};
// Addressed by name.
await say('B', "ThirdSeat, what's still open?");
await page.waitForTimeout(2200);
const reply = await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.at(-1));
// Interruption: someone starts talking while it speaks (browser recognition reports activity).
const sessionId = await page.evaluate(() => (document.querySelector('#transcript')?.closest('main') ? (window as unknown as { __sid?: string }).__sid : undefined));
void sessionId;
await page.waitForTimeout(300);
const cancelledBefore = await page.evaluate(() => (window as unknown as { __cancelled: number }).__cancelled);
await page.evaluate(async () => {
  const id = (await (await fetch('/api/sessions')).json()).at(-1).id;
  await fetch(`/api/sessions/${id}/activity`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hang on let me add something here' }) });
});
await page.waitForTimeout(800);
const cancelledAfter = await page.evaluate(() => (window as unknown as { __cancelled: number }).__cancelled);
// Its own voice picked up and transcribed back.
await say('Room', reply ?? '');
await page.waitForTimeout(800);
const roomLines = await page.$$eval('.utt .s', (n: Element[]) => n.filter((x) => x.textContent === 'Room').length);
// Mute by voice.
await say('A', 'ThirdSeat, quiet please.');
await page.waitForTimeout(800);
const muteLabel = await page.textContent('#voiceBtn');
await page.screenshot({ path: 'docs/evidence/voice-03-addressed-muted.png' });
const ownLines = await page.$$eval('.utt.own .x', (n: Element[]) => n.map((x) => x.textContent));
await browser.close();
server.kill();

const record = {
  ranAt: new Date().toISOString(),
  note: 'Headless browser: speech output recorded by a stub (no audio device). Turn-taking, addressing, interruption and echo handling are real.',
  spokenDuringRehearsal: afterRehearsal,
  addressedReply: reply,
  interruption: { cancelCallsBefore: cancelledBefore, cancelCallsAfter: cancelledAfter },
  ownVoiceHeardBackAddedAsRoomLine: roomLines > 0,
  muteButtonAfterVoiceCommand: muteLabel,
  thirdSeatTranscriptLines: ownLines,
  pageErrors: errors,
};
await writeFile('docs/evidence/e2e-voice-browser.json', JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
const ok = afterRehearsal.length > 0 && /^Still open:/.test(reply ?? '') && cancelledAfter > cancelledBefore && roomLines === 0 && /Muted/.test(muteLabel ?? '') && errors.length === 0;
process.exit(ok ? 0 : 1);
