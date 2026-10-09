# ThirdSeat

A live-conversation presence that notices **what is missing right now** (an unanswered factual
question, a deferred check, a dropped important question, a drift away from the objective) and
helps close it **while the conversation is still happening**. It stays silent when it has nothing
useful to add.

Not a note taker, transcriber or summariser. See [`duck/HUMAN_INTENT.md`](duck/HUMAN_INTENT.md).

```bash
npm install
npm start            # http://127.0.0.1:4317
npm test             # 59 deterministic tests
npm run e2e:real     # real-retrieval proof run → docs/evidence/
```

Live audio (room microphone, or a video call in a browser tab + your mic, with speaker separation):

```bash
export DEEPGRAM_API_KEY=...
THIRDSEAT_STT=deepgram npm start     # then choose the audio input when starting a session
```

Without it, room listening falls back to Chrome's built-in speech recognition.

Scored AI-vs-no-AI comparison (needs `ANTHROPIC_API_KEY`): `npm run test:ai`

Voice participation: tick **"ThirdSeat speaks in the meeting"** when starting a session. It speaks only on
gap points, waits for pauses, stops when interrupted, and answers when addressed ("ThirdSeat, where's that from?").
Optional server voice: `THIRDSEAT_TTS=deepgram`.

Optional AI mode (sends conversation snippets to Anthropic):

```bash
export ANTHROPIC_API_KEY=...
THIRDSEAT_LLM=anthropic npm start
```

| Read | For |
|---|---|
| [`duck/HUMAN_SUMMARY.md`](duck/HUMAN_SUMMARY.md) | What works today, in plain English |
| [`duck/AGENT_SPEC.md`](duck/AGENT_SPEC.md) | Behaviour and architecture |
| [`duck/SCOPE.md`](duck/SCOPE.md) | What is in / out — check before adding anything |
| [`duck/VERIFICATION_LEDGER.md`](duck/VERIFICATION_LEDGER.md) | Evidence for every claim |
| [`duck/HANDOVER.md`](duck/HANDOVER.md) | Engineering handover: setup, config, risks |
| [`duck/CHALLENGE.md`](duck/CHALLENGE.md) | Honest risks to the thesis |
| [`duck/THEDUCK_LEARNINGS.md`](duck/THEDUCK_LEARNINGS.md) | Lessons for the TheDuck method |
