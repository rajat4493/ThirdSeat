# Rigorous test: proactive, reactive and retroactive in one conversation

Date: 2026-10-04 · Mode tested: **no-AI (heuristic analysis)** with simulated search results.
The AI analyzer was not testable here (no API key).

## Method and bias controls

1. Each conversation and its answer key were written and **committed to git before the run**
   (`086975c` x01, `3d840b1` probes, `ebe5dc6` x03).
2. Lines were written as natural speech, not to match ThirdSeat's phrase lists. They include
   **negative controls**: confident human answers, rhetorical/social questions, an internal
   question, a topic proposal, an unanswerable question, and a human answering mid-research.
3. Search results are simulated (marked FIXTURE), so the test isolates *judgement and timing*,
   not research quality. Two lookups are deliberately slow, to test late answers and cancellation.
4. Phrasing robustness was measured on ~60 pre-registered phrasings, split into **dev** (may
   inform fixes) and **held-out** (measured only).
5. A **fresh confirmation conversation** in a different domain was written after the fixes and run
   **once**. No fixes were allowed in response.
6. Runs are deterministic: three repeats gave identical results.

## Results

| Run | What | Score |
|---|---|---|
| x01 run 1 | Original conversation, before any fix | **12/15** |
| Probes (baseline) | Natural phrasings: dev / held-out | **21/28 · 11/28** |
| x01 run 2 | After phrasing fixes (from dev misses only) | 13/15: new failure exposed (P3), and the L1 key error |
| x01 run 3 | After pacing fix + key correction | 15/15 (not unbiased: fixed after seeing it) |
| Probes (after fixes) | dev / held-out | **28/28 · 17/28** (held-out is optimistic: its misses had been seen) |
| **x03 confirmation** | **Fresh, unseen, different domain, single run** | **6/9**, plus a content failure the key did not check |

**The x03 confirmation run is the most honest number.** About two-thirds of the expected
behaviours are right on an unseen conversation in no-AI mode.

## What works reliably (seen in every run)

- **Proactive answer to an unanswered question** after the grace period (x01 P1, x03 P1).
- **Question asked to the room** answered immediately (x01 P3, after the pacing fix).
- **Late answers framed retroactively** ("Back to … (raised N min ago)") (x01 L1, x03 L1).
- **Conclusion support** fires on "where does that leave us" (x01 C1, x03 C1).
- **Stands down correctly** on clearly confident human answers, cancels research when humans answer
  mid-lookup, says nothing when research finds nothing, and ignores rhetorical/social lines and topic proposals.
- **No extra cards** in any run (precision of *which cards appear* was 100%).

## Failures found (and what happened to them)

| # | Failure | Found in | Status |
|---|---|---|---|
| F1 | "Hmm, couldn't tell you offhand" read as acknowledgement ("hmm"). The card still came, but as proactive instead of reactive | x01 run 1 | **Fixed (general):** "hmm" no longer counts as acknowledgement; negated knowing/telling counts as uncertainty |
| F2 | Product names at the start of a sentence ("Meet…", "Slack…") not recognised, so tentative claims were missed | x01 run 1 | **Fixed (general):** a sentence-initial capital counts as a name unless it's ordinary vocabulary |
| F3 | **False stand-down**: "not something I know", "fairly sure it does" and "I checked … a while ago" were read as confident answers | probes | **Partly fixed:** negation and qualified "sure" now handled. *"Last I checked it did, but that was a while ago" still stands down* (held-out, deliberately not tuned) |
| F4 | **Pacing bug**: ignored cards blocked new answers for 150 s (active-card cap), so a room question was answered 46 s late | x01 run 2 (hidden in run 1) | **Fixed:** an unactioned card stops occupying attention after 60 s |
| F5 | My answer-key window for L1 contradicted the test's own release schedule | x01 run 1 | Key corrected (visible note in the scenario file); product output unchanged |
| F6 | Tentative claims depend on a verb list: "Stripe takes about two days to pay out, I think" was missed ("takes") | **x03** | **Open** |
| F7 | **False stand-down on an important question**: "What happens if we pick the wrong one…?" was not seen as strategic, and "Yeah, that would hurt" was read as a confident "yes" answer, so the migration risk was never tracked | **x03** | **Open: serious** (the main blocker was lost) |
| F8 | **Polluted conclusion card**: listed "Is everyone okay with a quick break at eleven?" as an unresolved blocker, and missed the migration risk (F7) | **x03** | **Open** |
| F9 | Two cards surfaced in the same second (dropped thread + late deferred answer); deferred answers count as "urgent" and skip the cooldown | x01 | Open (pacing judgement; not in the key) |
| F10 | Held-out phrasings still missed (9 reactive cases fall back to a proactive card ~4 s later; 1 claim missed) | probes | Open, by design of the test |

## Interpretation

- The **timing logic** (when to act proactively, reactively or retroactively; when to stay silent;
  pacing) behaved as designed once F4 was fixed.
- The weak point is **language understanding in no-AI mode**. Phrase and verb lists don't
  generalise: 61% on held-out phrasings, and an unseen conversation lost its most important open
  question (F7, F8). Patching more phrases would only chase the test set.
- This is the job the AI analyzer exists for. The next real step is to run these exact files in AI
  mode and compare: `npm run test:ai` (needs `ANTHROPIC_API_KEY`).

## AI-mode comparison (ready, not yet run)

- `--ai` swaps in Claude for understanding the conversation and writing answers. **Search stays
  simulated**, so the two modes differ only in understanding.
- x01, x03 and the probes are fair tests for the AI: the no-AI rules were fixed against them, but the
  AI instructions were not, and **will not be changed before the first scored AI run**.
- **Guard against a misleading score:** if any AI call fails, ThirdSeat falls back to the no-AI
  rules. The harness marks such a run INVALID instead of reporting it as an AI score. This was
  verified with a deliberately invalid key: all 34 AI calls failed, and the run was marked INVALID
  rather than showing "15/15".

## Reproduce

```bash
node scripts/rigorous-three-modes.ts                                         # x01 (15/15)
node scripts/rigorous-three-modes.ts scenarios/x03-confirmation-payments.json # x03 (6/9)
node scripts/phrasing-probes.ts                                              # dev 28/28, held-out 17/28
```
