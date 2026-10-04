# TheDuck — Learnings from ThirdSeat

> TheDuck artifact 8 of 8. Practical lessons for improving TheDuck itself.

## Ambiguities that mattered (and how they were settled)

| Ambiguity | Settled by | Lesson for TheDuck |
|---|---|---|
| What counts as "real research" when the build environment has no LLM key and blocks most of the web? | Probed egress first. Found official docs reachable on raw.githubusercontent.com, built a no-LLM retrieval path, and labelled its answers UNVERIFIED. | Add an **environment-capability probe** step (keys, egress, browsers) before architecture. It changed the design. |
| Is a question "a gap" the moment it's asked? | No. A two-stage *watch → qualify* model. | The intent's examples (Scenarios 2, 3, 9) implied this. Asking "what must *not* trigger?" was more useful than "what should trigger?". |
| Should UNRESOLVED research interrupt? | No. Listed silently. | "Minimum interruption" needs operationalising into explicit rules early, or every component defaults to speaking. |
| Should the LLM be on by default if a key exists? | No. Explicit opt-in, because content leaves the machine. | Privacy defaults deserve a line in the spec template. |
| Where do `/duck` files live? | Repo root `duck/`. | Trivial, but state it in the template. |

## Assumptions that were safe to make without asking

Stack (TypeScript, Node, no framework), product name from the repo, port, thresholds as
documented defaults, vanilla UI, in-memory storage, the scenario wording. All are reversible and
documented.

## Where the coding agent tended to broaden scope (caught)

- Wanting to export the transcript or a meeting summary at session end → rejected. It drifts toward note-taking.
- Wanting charts on the session-end view → rejected as analytics clutter.
- Wanting speculative research for every question → deferred. It optimises latency before there is evidence it's needed.
- The "Ask ThirdSeat" box is a borderline chatbot risk. It was kept but framed and counted as a
  *missed-detection signal*, not as a feature.

## Where the human intent was at risk of being distorted

- **Heuristic-first builds drift toward "keyword matching"**, which the intent explicitly says is
  insufficient. Mitigation: multi-signal heuristics, the same signal contract as the LLM analyzer,
  and the gap stated plainly in HUMAN_SUMMARY.
- **The first validation scenario (whiteboarding) is seductive.** It is easy to tune lexicons to
  "branding", "pricing" and "Copilot". Mitigation: core lexicons are generic conversational
  phrases, scenario content is confined to `scenarios/`, and non-whiteboard scenarios are included.
- **"Answer generation" without an LLM** risks dressing up a quoted passage as an answer. The first
  real run showed an off-target passage labelled LIKELY. It was downgraded to UNVERIFIED with
  "possibly relevant" wording. *Run the real path early: it exposed an honesty bug that fixtures never would.*

## Validation artifacts that were most useful

1. **The deterministic scenario runner timeline** (`npm run scenario`). Reading what the system did
   minute-by-minute found three behaviour bugs in one pass ("What about…?" false positive, the
   conclusion card blocked by the active-card cap, the reasoning card piling on).
2. **The real-retrieval e2e record with excerpt verification.** It is cheap proof that evidence isn't fabricated.
3. **Gated fixtures** to test cancellation while research is in flight. Instant fixtures hid Scenario 9.
4. **Headless UI drive with screenshots** caught nothing broken but made the UI claims evidence-backed.

## Follow-up request: "audio enablement like Vera"

- The request named a reference product the agent could not identify or look up. Asking one
  structured question ("audio input, private speech, or speaking into the meeting?") avoided both
  guessing and silently breaking a SCOPE rule (no speaking into the meeting). **Lesson: when a request
  references an unknown product, translate it into options that map onto existing scope lines.**
- Asking *where* the live test happens (room vs call) changed the design (two-channel capture with
  separate mic/call labels), which in turn preserves the engine's "another person answered" signal.
- Unreachable vendor ≠ untestable. A stand-in speaking the vendor's wire protocol, plus a real
  browser with fake devices, proved everything except recognition accuracy. The ledger tier 🟡 kept
  that boundary honest.

## Follow-up: "we are being very retroactive — we have to be all 3"

- The first build over-applied "minimum interruption": it waited for a human signal before even
  *starting* research. That turned a good principle into a reactive-only product. **Lesson: separate
  "when to work" from "when to speak".** Working early (research at question time) costs nothing in
  interruptions, and the policy still decides when to speak.
- An earlier scope decision ("defer speculative research") was overturned by the human with a
  product reason. The SCOPE log made the reversal explicit instead of silent.
- Without AI, proactive mode surfaces little, because unverified passages fall below the threshold. That is
  correct, but it means the no-AI demo under-shows the feature. Say so instead of lowering thresholds.

## Rigorous test (2026-10-04)

- **Commit the answer key before the run.** It made the L1 key error visible and correctable in the
  open, instead of quietly "adjusting expectations".
- **Fixing one bug unmasked another** (F1/F2 fixes → more cards → pacing bug F4). A passing scenario
  hides interactions; re-run everything after every fix.
- **A run you have fixed against is no longer evidence.** Only the fresh, single-run x03 (6/9) is
  an unbiased number. Keep a held-out set and spend it once.
- **Check card content, not just presence.** x03's conclusion card "passed" the key but listed a
  coffee-break question as a blocker. Answer keys need content assertions.

## Suggested changes to TheDuck templates

- Add an "**Environment capabilities**" section to AGENT_SPEC: credentials, network egress, runtime.
- Add a "**What must stay silent**" list next to the functional behaviour in AGENT_SPEC.
- Use status levels in VERIFICATION_LEDGER (✅ verified / 🟡 fakes only / ⛔ not verified). The
  middle tier stops "tested" being over-claimed.
- Require HUMAN_SUMMARY to have a "What is mocked?" section. It forces honesty about fixtures.
- VERIFICATION: require one **pre-registered, single-use confirmation run** for any behavioural claim.
- Add "**Timing stance**" (proactive / reactive / retroactive) as an explicit intent question when the product interrupts people.
- Add "**Reference products named by the human**" to the ambiguity pass: name what is being borrowed (input? output? UX?) before building.
