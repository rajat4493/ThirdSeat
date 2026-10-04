# ThirdSeat — Human Summary

> TheDuck artifact 6 of 8. Plain English. Updated 2026-10-02 after adding live audio input.

## What does the product currently do?

You open ThirdSeat in a browser, optionally type what the conversation is meant to achieve
(the *objective*), and optionally paste links to documents worth checking (vendor docs,
for example). Then you talk. ThirdSeat can **listen**:

- **In a room:** it uses the laptop microphone and tells the speakers apart ("Speaker 1", "Speaker 2").
  Click a name to rename it.
- **On a video call** (Teams, Zoom or Meet in a browser tab): it hears your microphone *and* the call
  tab, so it knows what you said versus what the others said.

You see live captions while people speak. Typing and scripted rehearsals still work too.

While you talk, ThirdSeat:

- **Notices factual questions nobody can answer.** If someone says "not sure", "no idea",
  "let's check after the meeting" or gives a shaky "I think so", it looks the answer up straight
  away and shows a short card with the source and an honest confidence label.
- **Chooses when to speak up, depending on the situation:**
  - *Proactive:* it starts looking up a factual question the moment it's asked. If nobody answers
    within a few seconds, it offers what it found. Nobody needs to say "not sure" first. It answers
    "does anyone know…?" as soon as it can, and checks tentative claims like "I think X supports Y"
    without being asked.
  - *Reactive:* when someone says "not sure" or "let's check later", the answer is usually already
    there, so it appears instantly.
  - *Retroactive:* if an answer only arrives after you've moved on, it says "Back to your earlier
    question…". It also brings back dropped questions when you start deciding.
- **Stays quiet when you've got it.** If someone answers confidently, it stands down. If someone
  answers while it is still researching, it cancels the research and shows nothing.
- **Remembers important questions you dropped.** "Why wouldn't Microsoft just build this?" gets
  tracked. It only comes back when you start making decisions that might depend on it.
- **Flags real drift, rarely.** It notes the drift only after several minutes on a tangent, and only
  while important questions are still open.
- **Helps you land.** When you say something like "so where does that leave us?", it lists what is
  still unresolved for your objective. It does not summarise the meeting.
- **Says when it can't verify something.** It does not make answers up. If it can't verify an
  answer, the question goes into the "open" list without interrupting you.

At the end you get a validation page with counts, timings, your per-card feedback and a short
questionnaire. It is for judging whether ThirdSeat helped. It is not meeting minutes, and it
does not include the transcript.

## What can I test today?

1. `npm install && npm start`, then open http://127.0.0.1:4317.
2. **Rehearsal:** pick "Two-person whiteboarding rehearsal" and watch it run against real
   Microsoft documentation.
3. **Live:** start a session with an objective and type (or speak, in Chrome) the conversation.
4. With an Anthropic API key and `THIRDSEAT_LLM=anthropic`, it can also search the public web
   and understand paraphrases far better. That mode is built but **has not yet been tried with a
   real key** (see below).

## What actually works (proven)

- All 10 required behaviours, as repeatable automated tests (45 tests in total, all passing).
- A real end-to-end run with no faked answers: a question in the conversation became a gap.
  ThirdSeat fetched the official Microsoft docs live, quoted the relevant passage, and showed it
  about 0.3 seconds after the question was left unanswered. Every quoted passage was checked
  against the live documents.
- Timing is measured for every gap, and every card shows it.
- The UI works end to end (screenshots in `docs/evidence/`).

- **Audio listening works from microphone to card.** In a real browser, microphone audio and call-tab
  audio were captured, sent to the server, split by speaker and turned into gap cards.

## What is mocked?

- **The speech recognition itself.** The transcription service (Deepgram) can't be reached from the
  build environment, so the audio tests use a stand-in that speaks the same protocol and plays back
  a script. Everything around it is real: capturing, encoding, streaming, speaker separation and
  what happens next. How well real speech gets transcribed is **not yet known**.

- The scenario tests use **fake research results** (marked "FIXTURE") so they run the same way
  every time. They prove the *behaviour*, not the *research quality*.
- The AI (Claude) parts are tested only with a **fake AI client**. No real AI call has been made
  yet because this build environment had no API key.

## What is incomplete or weak?

- **Without the AI, understanding is shallow.** It relies on wording patterns ("not sure", "I think
  so") and on whether words overlap. Unusual phrasings will be missed, and drift detection can't
  tell "branding" from "pricing" by meaning. It only sees that the words are new.
- **Without the AI, answers are "possibly relevant passages", not answers.** In the real run, one
  passage was about Teams *live events* when the question was about *live transcripts*.
  ThirdSeat labels these "UNVERIFIED — keywords only", but a person still has to read them.
- **Public web search needs the AI mode**, which hasn't been tried live yet.
- **Real audio needs a transcription account** (Deepgram key). Without one, room listening falls back
  to Chrome's built-in recognition (no speaker names, audio goes to Google), and call listening isn't
  available.
- On calls without headphones the microphone also hears the call. ThirdSeat drops obvious repeats,
  but headphones are recommended.
- Thresholds (how long before drift counts, how often cards may appear) are educated guesses
  until real sessions tune them.

## What did the latest validation show?

Only scripted validation so far. The rehearsal behaved as intended:

- two knowledge cards, both with real sources
- one recovered thread ("why wouldn't Microsoft build this?") at the pricing/MVP moment
- one "you're close to a conclusion" card listing three open items
- a too-eager reasoning card and a false "What about…?" gap were caught and fixed during the build

**No real two-person session has happened yet.** That is the test that matters.

## What is the next sensible milestone?

1. Run once with a real Anthropic key (`npm run e2e:real` with `THIRDSEAT_LLM=anthropic`). Check
   answer quality and real latency, and record them in the ledger.
2. Get a Deepgram key, run `THIRDSEAT_STT=deepgram`, and talk for 5 minutes in each setup (room
   and call). Check how accurate the words are, whether the speaker split is right, and the
   transcription delay shown in the session report.
3. Run the first real 30–60 minute two-person whiteboarding session in AI mode, with an
   objective set. Fill in the validation form, and record honestly what helped and what got in
   the way.
4. Tune only what that session shows is wrong.
