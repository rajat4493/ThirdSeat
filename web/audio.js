// Captures audio in the browser and streams 16-bit PCM to the ThirdSeat server over a WebSocket.
//   mode "room": microphone only (one channel; the server separates speakers).
//   mode "call": microphone (channel 0) + a shared browser tab's audio (channel 1), e.g. a Teams/Zoom/Meet web call.

export async function startAudio({ sessionId, mode, onStatus }) {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  let tab = null;
  if (mode === 'call') {
    try {
      tab = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (e) {
      mic.getTracks().forEach((t) => t.stop());
      throw new Error('Tab sharing was cancelled.');
    }
    if (tab.getAudioTracks().length === 0) {
      [...mic.getTracks(), ...tab.getTracks()].forEach((t) => t.stop());
      throw new Error('No tab audio. Choose the browser tab with your call and tick "Share tab audio".');
    }
  }

  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
  } catch {
    ctx = new AudioContext();
  }
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const channels = tab ? 2 : 1;
  const node = new AudioWorkletNode(ctx, 'pcm-capture', { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
  const micSrc = ctx.createMediaStreamSource(mic);
  if (tab) {
    const merger = ctx.createChannelMerger(2);
    micSrc.connect(merger, 0, 0);
    ctx.createMediaStreamSource(new MediaStream(tab.getAudioTracks())).connect(merger, 0, 1);
    merger.connect(node);
  } else {
    micSrc.connect(node);
  }
  // The worklet must be pulled by the graph; route it to a muted output.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/sessions/${sessionId}/audio?channels=${channels}&sampleRate=${ctx.sampleRate}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data);
      if (msg.type === 'status') onStatus?.(msg.state, msg.message);
    } catch {}
  };
  ws.onclose = () => onStatus?.('closed');
  ws.onerror = () => onStatus?.('error', 'Could not connect the audio stream (is server speech-to-text configured?)');
  node.port.onmessage = (e) => ws.readyState === WebSocket.OPEN && ws.send(e.data);
  // If the user stops sharing from the browser bar, end cleanly.
  tab?.getTracks().forEach((t) => (t.onended = () => stop()));

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
    [...mic.getTracks(), ...(tab?.getTracks() ?? [])].forEach((t) => t.stop());
    await ctx.close();
  }
  return { stop, channels, sampleRate: ctx.sampleRate };
}
