// Plays ThirdSeat's spoken turns and reports playback to the server (which owns turn-taking).
// Server voice → <audio> (can be routed to a chosen output device, e.g. a virtual mic for a web call).
// Otherwise → the browser's built-in speech synthesis on the default speakers.

export function createVoicePlayer({ sessionId, serverVoice, getSinkId, onState }) {
  let current = null;

  const report = (id, status) =>
    fetch(`/api/sessions/${sessionId}/voice/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status }) }).catch(() => {});

  function done(id, status) {
    if (!current || current.id !== id) return;
    current = null;
    onState?.(false);
    report(id, status);
  }

  function speakWithBrowser(req) {
    if (!('speechSynthesis' in window)) return done(req.id, 'failed');
    const u = new SpeechSynthesisUtterance(req.text);
    u.rate = 1.05;
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find((v) => /en[-_](US|GB)/i.test(v.lang) && /natural|neural|google|samantha|daniel/i.test(v.name)) ?? voices.find((v) => /^en/i.test(v.lang)) ?? null;
    u.onend = () => done(req.id, 'finished');
    u.onerror = () => done(req.id, 'failed');
    current = { id: req.id, stop: () => speechSynthesis.cancel() };
    speechSynthesis.speak(u);
  }

  async function speak(req) {
    stop('superseded');
    onState?.(true, req.text);
    report(req.id, 'started');
    if (serverVoice) {
      const a = new Audio(`/api/sessions/${sessionId}/voice/audio/${req.id}`);
      const sink = getSinkId?.();
      if (sink && typeof a.setSinkId === 'function') await a.setSinkId(sink).catch(() => {});
      current = { id: req.id, stop: () => a.pause() };
      a.onended = () => done(req.id, 'finished');
      a.onerror = () => {
        // Server voice failed: fall back to the browser voice for this turn.
        if (current?.id === req.id) speakWithBrowser(req);
      };
      try {
        await a.play();
      } catch {
        if (current?.id === req.id) speakWithBrowser(req);
      }
      return;
    }
    speakWithBrowser(req);
  }

  function stop() {
    if (!current) return;
    const c = current;
    current = null;
    c.stop();
    onState?.(false);
    report(c.id, 'interrupted');
  }

  return { speak, stop, get speaking() { return !!current; } };
}

export async function listOutputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audiooutput');
  } catch {
    return [];
  }
}
