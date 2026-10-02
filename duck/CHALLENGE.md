# ThirdSeat — Challenge Pass

> TheDuck artifact 3 of 8. Honest challenges to the thesis and the design, and what we do
> about each. Rule: a challenge may change *how* we build, never *what* we are building.
> We do not retreat into an easier product (note taker, summariser, chatbot).

| # | Challenge | Why it is real | Response in V0 | Residual risk |
|---|---|---|---|---|
| 1 | **Can meaningful gaps be detected reliably?** | Most questions in conversation are rhetorical, social, or answered immediately. "Meaningful" depends on the objective. | Two-stage design: a question only opens a *watch*; it becomes a gap only after a qualifying signal (uncertainty, deferral, weak answer, no answer). Every gap stores a machine-readable reason so precision can be audited. Heuristic analyzer for determinism + LLM analyzer for real nuance. | Heuristic recall on paraphrased uncertainty is limited. LLM analyzer is implemented but not yet validated live (no credentials in the build environment). |
| 2 | **False positives** | A wrong interruption costs more than a missed one. | Precision over recall: watch windows, natural-resolution suppression, UNRESOLVED never interrupts, false-positive feedback flag recorded per intervention. | Thresholds are untuned until the first live sessions. |
| 3 | **Intervention fatigue** | Twenty mediocre cards destroy the experience. | Cooldown, active-card cap (3), priority queue, dedupe, drift/thread/conclusion require sustained conditions. Metrics count dismissals, not quantity. | Real fatigue tolerance unknown until humans use it. |
| 4 | **Latency** | An answer after the topic moved has little value. | Research starts at qualification (not end of meeting); parallel tools; per-gap timing; "topic still live at surface time" recorded. Extractive path has no LLM round-trip. | LLM web search is typically several seconds to tens of seconds. Speculative pre-research is a possible next step, deliberately not built yet (cost/noise). |
| 5 | **Research reliability** | Web results can be outdated or wrong; synthesis can overreach. | Source tiers (official docs first), confidence levels, answer must reference evidence IDs (LLM path validates them), extractive path is capped below HIGH, "couldn't verify" preferred. | Official docs can be stale too; confidence is about sourcing, not truth. |
| 6 | **Noisy conversations** | Crosstalk, filler, half sentences. | Analyzer works on a window, not single lines; filler tolerated; UI allows manual correction by typing. | Heuristic may mis-assign answers to the wrong question when two are open at once. |
| 7 | **Ambiguous questions** | "Does it support that?" — what is "it"? | Interpreted question is stored and shown; heuristic resolves short pronoun questions using the previous utterance; LLM analyzer rewrites into a standalone question. User can "Research more". | Heuristic interpretation of pronouns is shallow. |
| 8 | **Overlapping threads** | Several questions open simultaneously. | Each watch tracks its own window; answers attach to the most recent compatible watch; multiple gaps prioritised (Scenario 8). | Attribution errors possible with single-speaker mic input. |
| 9 | **Transcript quality** | Browser speech recognition has errors and no speaker separation. | Source abstraction keeps the core independent of transcription; speaker-agnostic logic where possible (single "Room" speaker works, with reduced accuracy for "another person answered"). | Live mic quality not yet measured. Chrome's speech recognition sends audio to Google (documented). |
| 10 | **Context-window management** | 60-minute sessions are long. | LLM analyzer receives compact state + recent window (≈12 utterances), never the full transcript. State is consolidated (facts capped, resolved items compressed). | Long-range references ("what we said 40 min ago") depend on state quality. |
| 11 | **Objective interpretation** | Objectives are vague ("explore X"). | Objective is optional; with none, relevance defaults to neutral and drift detection is disabled (no reference to drift from). Relevance uses objective + open items, not meeting-type keywords. | Heuristic relevance is lexical; LLM relevance is better but unvalidated. |
| 12 | **Will humans actually find it useful?** | The whole thesis. | Session-end view captures per-intervention feedback and a human validation form; ledger records actual outcomes only. | Unknown until live validation. This is the main open question. |
| 13 | **Can public research answer enough gaps to prove value?** | Many meeting gaps are internal ("did legal approve?"). | V0 targets public, verifiable knowledge gaps (vendor capabilities, limits, docs) + open-thread recall, which needs no research. Supplied URLs/docs let a session bring its own context. Enterprise sources are a documented future `ResearchTool`. | If live sessions show most gaps are internal, the value proof must lean on threads/drift/conclusion until enterprise tools exist. Record this honestly. |
| 14 | **Heuristics are not "understanding"** | Keyword rules are brittle; the human asked for more than keyword matching. | Heuristics combine several signals (question form, factuality, response classification, speaker change, topic change, objective relevance) and are used for deterministic testing and as a no-LLM fallback. The LLM analyzer is the intended primary mode. | Until LLM mode is validated, the product's understanding is limited to the heuristic. Stated plainly in `HUMAN_SUMMARY.md`. |
| 15 | **Generic vs. first test** | Easy to tune for "two people whiteboarding". | No meeting-type words in core code; scenario content lives in `scenarios/` only; tests include non-whiteboarding scenarios (vendor/technical). | — |

## Ambiguities resolved by sensible defaults (not escalated)

- **Where do `/duck` artifacts live?** In `duck/` at repository root.
- **Product name:** the repo is named ThirdSeat; used as the product name.
- **Stack:** TypeScript on Node 22, no framework, no build step, vanilla UI. Minimal deps.
- **LLM:** Anthropic Claude via official SDK, model `claude-opus-5-5`; optional at runtime.
- **What counts as "real research" without an LLM key:** fetching and ranking real
  official documentation (user-supplied URLs) and returning an extractive, cited answer
  with confidence capped at LIKELY. Labelled as such; never presented as HIGH.
- **UNRESOLVED gaps:** listed, not interrupting.
- **Reasoning gaps:** narrow heuristic only (feasibility → commitment); low priority.
