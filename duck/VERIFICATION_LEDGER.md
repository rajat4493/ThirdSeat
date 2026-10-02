# ThirdSeat — Verification Ledger

> TheDuck artifact 5 of 8. Every important claim is listed with the evidence for it.
> **Status legend:** ✅ verified (evidence in repo) · 🟡 implemented, verified only with fakes/fixtures ·
> ⛔ not verified / not done. Do not claim anything that is not ✅ without saying so.

Last updated: 2026-10-02 (V0 build + live audio input).

## Core loop

| # | Claim | Status | Evidence |
|---|---|---|---|
| 1 | Detects an explicit factual question that humans cannot answer | ✅ | `tests/scenarios.test.ts` S1; `docs/evidence/scenarios-with-fixtures.txt` |
| 2 | Stays silent when another human answers confidently (no research spent) | ✅ | S2 asserts 0 interventions and 0 research calls |
| 3 | Treats a weak answer ("I think so") as a verification opportunity | ✅ | S3 (`LOW_CONFIDENCE_HUMAN_RESPONSE`) |
| 4 | Treats deferral ("check after the meeting") as a high-priority gap, framed as avoided follow-up | ✅ | S4 (priority ≥ 0.75, text mentions follow-up) |
| 5 | Retains an abandoned important question as an open thread, does not surface it immediately, recovers it at a decision point | ✅ | S5 asserts surfacing on the pricing/MVP line only |
| 6 | Surfaces one lightweight drift note only after ≥3 min sustained tangent **and** unresolved objective items | ✅ | S6; "no objective → no drift" test |
| 7 | When research finds nothing: UNRESOLVED, no answer text, no interruption | ✅ | S7 |
| 8 | Prioritises multiple simultaneous gaps (deferred first) and paces interruptions (cooldown) | ✅ | S8 |
| 9 | Cancels in-flight research and suppresses the card when humans resolve the gap meanwhile | ✅ | S9 (gated fixture; `aborted === 1`, 0 interventions) |
| 10 | At a conclusion signal, lists remaining blockers (not a summary) and excludes answered questions | ✅ | S10 |
| 11 | Reasoning gap (feasibility → commitment) is conservative: needs an objective, expires in 15 s | ✅ | reasoning test; w01 rehearsal shows it dropped rather than piled on |
| 12 | Topic proposals ("What about X?") are not treated as gaps | ✅ | S4 assertion + analyzer test (found as a false positive in the first run, then fixed) |

## Real research (not fixtures)

| # | Claim | Status | Evidence |
|---|---|---|---|
| 13 | At least one end-to-end flow performs conversation → detection → **real external retrieval** → answer → surfaced intervention | ✅ | `scripts/e2e-real-research.ts` → `docs/evidence/e2e-real-research.json`: official Microsoft docs fetched live over HTTPS, ranked, quoted; card surfaced 306 ms after the trigger. |
| 14 | Evidence excerpts are genuine (not hard-coded) | ✅ | Same record: `evidenceVerification` — 6/6 excerpts found in independently re-fetched live documents. |
| 15 | No-LLM answers never claim more than UNVERIFIED | ✅ | `tests/research.test.ts` (extractive synthesizer); e2e record shows `UNVERIFIED`. |
| 16 | No-LLM extractive answers are often only *partly* relevant | ✅ (honest finding) | e2e record: the Teams question matched a passage about "live events" (a meeting type), not live transcript access. Labelled "Possibly relevant … keywords only". This is why LLM synthesis exists. |
| 17 | Confidence is capped by evidence quality (HIGH requires an official source) | ✅ | `tests/research.test.ts` |
| 18 | LLM synthesis rejects answers that cite no retrieved evidence | 🟡 | Fake-LLM unit test only |
| 19 | Claude web search returns cited evidence that becomes Evidence objects | 🟡 | Fake-LLM unit test only. **Not run against the live API**: the build environment has no Anthropic credentials and general web egress is blocked. |
| 20 | LLM conversation analyzer improves on heuristics | ⛔ | Implemented and contract-tested with a fake client; **quality not measured**. Needs a run with credentials. |
| 21 | Fallback to heuristics when the LLM fails | 🟡 | `tests/llm-analyzer.test.ts` (simulated failure) |

## Latency & metrics

| # | Claim | Status | Evidence |
|---|---|---|---|
| 22 | Per-gap timing recorded: trigger, detected, qualified, research start, first evidence, answered, surfaced, resolved | ✅ | S1 asserts every field; e2e JSON `latencyMs` |
| 23 | TIME_TO_USEFUL_INTERVENTION shown in UI and report | ✅ | `docs/evidence/ui-03-live-end.png` (card meta "surfaced +…"), `ui-05-report.png` (median/p90) |
| 24 | "Topic still live at surface time" recorded | ✅ | report metric `surfacedWhileTopicLive`; UI report |
| 25 | Real-world LLM latency | ⛔ | Not measured (no credentials). Supplied-docs path: research 2–4 ms after a one-off ~60 ms fetch at session start. |
| 26 | Validation metrics: used/dismissed, false positives, incorrect, follow-ups avoided (confirmed vs inferred kept separate), threads recovered, drift/conclusion counts | ✅ | `src/metrics/report.ts`; `tests/server.test.ts`; `ui-05-report.png` |

## UI, API, privacy

| # | Claim | Status | Evidence |
|---|---|---|---|
| 27 | Create session with optional objective + source URLs; live typed input; simulated conversation; cards with Use / Open source / Research more / Mark resolved / Dismiss; feedback flags; session-end validation view with human form | ✅ | Playwright drive: `docs/evidence/ui-01…05*.png`, 0 page errors |
| 28 | Browser built-in speech recognition fallback (Chrome Web Speech API) | ⛔ | Implemented, not testable headless. Check manually in Chrome. |
| 28a | Room audio: browser captures the microphone, encodes 16 kHz PCM, streams it to the server, which forwards it to speech-to-text; speaker-separated utterances drive the engine and UI | ✅ (pipeline) | `scripts/e2e-audio-browser.ts` → `docs/evidence/e2e-audio-browser.json`, `audio-02-listening-room.png`: real Chromium, fake mic device, 186 KB real audio received, "Speaker 1/2" utterances, gap card created. |
| 28b | Call audio: microphone on channel 0 + shared call tab on channel 1 (multichannel), labelled Mic/Call | ✅ (pipeline) | Same record, call mode: a real tab playing audio was captured; non-silent samples on **both** channels (7,946 / 3,360); "Call 1 / Mic 1 / Call 2"; gap card created. `audio-02-listening-call.png` |
| 28c | Deepgram protocol handling: auth header, query parameters (linear16, diarize, multichannel, interim), interim captions, final + speech_final → utterances, UtteranceEnd, KeepAlive, CloseStream | 🟡 | `tests/audio.test.ts` against a stand-in server speaking Deepgram's protocol. **Not run against the real Deepgram service** (unreachable from the build environment). |
| 28d | Real transcription accuracy, diarization quality, and transcription latency | ⛔ | Needs a real `DEEPGRAM_API_KEY` run. Transcription latency is recorded per utterance (report → `audio.transcriptionLatencyMs`) and included in time-to-intervention, because utterances are stamped with *speech* time. |
| 28e | Mic echo of the call is dropped in call mode | 🟡 | Unit test with scripted echo. Only text-similarity based; headphones remain the recommendation. |
| 28f | Speech-to-text key never reaches the browser; speech content not logged; audio endpoint refuses (503) when speech-to-text is off | ✅ | `tests/audio.test.ts` server test |
| 29 | API keys never sent to the client | ✅ | `tests/server.test.ts` checks `/api/config`; key only read by the server SDK |
| 30 | Server logs do not contain utterance text by default | ✅ | `tests/server.test.ts` |
| 31 | Session-end report excludes the transcript; deleting a session removes its data | ✅ | `tests/server.test.ts` |
| 32 | No meeting-type terminology hard-coded in core logic | ✅ | Review: lexicons in `heuristic-analyzer.ts` are generic conversational phrases; scenario content only in `scenarios/` |

## Live validation (first two-person whiteboarding test)

| # | Claim | Status | Evidence |
|---|---|---|---|
| 33 | ThirdSeat made a real, unscripted conversation more productive | ⛔ | **Not yet run.** Template below. |

### Live validation template (fill in after each session)

```
Date / participants / duration:
Mode: heuristic | LLM (model, effort) | sources supplied:
Objective entered:
Useful interventions (what, why):
Useless / distracting interventions:
False positives (count + examples):
Incorrect answers:
Research gaps resolved during the session:
Unresolved questions recovered:
Missed gaps (from "Ask" usage + participants' notes):
Median / p90 time-to-intervention; # surfaced after topic moved on:
Follow-up work avoided (confirmed by participants):
Was the conclusion clearer because of ThirdSeat? (participants' words):
Would they want it next session? (participants' words):
Attach: exported validation JSON.
```
