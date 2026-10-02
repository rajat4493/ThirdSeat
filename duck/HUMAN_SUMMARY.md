# ThirdSeat — Human Summary

> TheDuck artifact 6 of 8. Plain English. Updated 2026-10-02 after the first build.

## What does the product currently do?

You open ThirdSeat in a browser, optionally type what the conversation is meant to achieve
(the *objective*), and optionally paste links to documents worth checking (vendor docs,
for example). Then you talk. The conversation gets into ThirdSeat by typing, by Chrome's
microphone, or from a scripted rehearsal.

While you talk, ThirdSeat:

- **Notices factual questions nobody can answer.** If someone says "not sure", "no idea",
  "let's check after the meeting" or gives a shaky "I think so", it looks the answer up straight
  away and shows a short card with the source and an honest confidence label.
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

- All 10 required behaviours, as repeatable automated tests (31 tests, all passing).
- A real end-to-end run with no faked answers: a question in the conversation became a gap.
  ThirdSeat fetched the official Microsoft docs live, quoted the relevant passage, and showed it
  about 0.3 seconds after the question was left unanswered. Every quoted passage was checked
  against the live documents.
- Timing is measured for every gap, and every card shows it.
- The UI works end to end (screenshots in `docs/evidence/`).

## What is mocked?

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
- **The microphone** works only in Chrome. It sends audio to Google's speech service and can't tell
  speakers apart. It hasn't been tried yet.
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
2. Check the microphone in Chrome for 5 minutes.
3. Run the first real 30–60 minute two-person whiteboarding session in AI mode, with an
   objective set. Fill in the validation form, and record honestly what helped and what got in
   the way.
4. Tune only what that session shows is wrong.
