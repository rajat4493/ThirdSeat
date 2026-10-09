# ThirdSeat — Coding-Agent Specification

> TheDuck artifact 2 of 8. Translates `HUMAN_INTENT.md` into buildable requirements.
> Scope is governed by `SCOPE.md`. Evidence for every claim lives in `VERIFICATION_LEDGER.md`.

## 0. Repository starting point (verified)

The repository was empty at start (no commits, no files). This is a greenfield build.
No existing code was reused.

## 1. Functional behaviour

### 1.1 Core loop

```
utterance arrives (ConversationSource)
  → transcript window + ConversationState updated
  → ConversationAnalyzer proposes: new gap candidates, updates to existing gaps,
    current topic, established facts, conclusion signal
  → GapEngine qualifies candidates (is this a meaningful gap? which reason?)
  → for researchable knowledge gaps: ResearchPlanner → ToolRegistry → tools → Evidence
  → EvidenceAssessor ranks sources, sets confidence, decides RESOLVED / PARTIALLY_RESOLVED / UNRESOLVED
  → InterventionPolicy decides: surface now / hold / suppress
  → surfaced interventions appear in the private side panel
  → user actions (Use, Dismiss, Open source, Research more, Mark resolved, feedback flags)
    feed back into state and metrics
  → periodic tick: watch windows expire, open-thread recall, drift check, conclusion support
```

The system continuously understands; it rarely speaks.

### 1.2 Gap types and V0 support level

| Type | V0 support | Trigger (machine-readable reason) |
|---|---|---|
| KNOWLEDGE | **Primary.** Detect, research, answer with evidence | `EXPLICIT_UNANSWERED_QUESTION`, `DEFERRED_FOR_LATER`, `LOW_CONFIDENCE_HUMAN_RESPONSE` |
| OPEN_THREAD | **Supported.** Track, recall when it becomes relevant again and still unresolved | `IMPORTANT_OPEN_THREAD`, `OBJECTIVE_BLOCKER` |
| DRIFT | **Conservative.** Only when sustained AND unresolved objective-relevant items exist | `MATERIAL_OBJECTIVE_DRIFT` |
| CONCLUSION (decision gap) | **Conservative.** When the group signals it is concluding, list what still blocks the objective | `CONCLUSION_WITH_OPEN_BLOCKERS` |
| REASONING | **Narrow + conservative.** Only the feasibility→commitment leap pattern (heuristic) or high-confidence LLM finding | `UNSUPPORTED_INFERENCE` |
| EVIDENCE | LLM analyzer only, low priority | `UNSUPPORTED_MATERIAL_CLAIM` |
| CONTEXT | Not in V0 (needs enterprise/previous-meeting sources). Model reserved | — |

### 1.3 Knowledge-gap lifecycle

1. A factual question is asked → a **watch** opens (not yet a gap; nothing surfaced) and research starts in the background (see 1.3a).
2. Within the watch window (default: 3 following utterances or 25 s):
   - credible, specific human answer → `NATURALLY_RESOLVED` (no research, no intervention)
   - uncertainty ("not sure", "no idea") → qualify `EXPLICIT_UNANSWERED_QUESTION`
   - deferral ("check later", "after the meeting") → qualify `DEFERRED_FOR_LATER` (highest priority)
   - weak answer ("I think so", "probably") → qualify `LOW_CONFIDENCE_HUMAN_RESPONSE` (verification)
   - acknowledgement without answer ("good point") on a strategic question → open thread
   - nothing / topic change → qualify `EXPLICIT_UNANSWERED_QUESTION`
3. Qualified researchable gap → research starts immediately.
4. If humans resolve it while research is running → research is **aborted** and/or the
   intervention is **suppressed**; status `NATURALLY_RESOLVED`.
5. Research outcome → `RESOLVED` (HIGH), `PARTIALLY_RESOLVED` (LIKELY), `UNRESOLVED` (no reliable evidence).
6. RESOLVED/PARTIALLY_RESOLVED are offered to the policy as interventions. UNRESOLVED is
   listed in the side panel as "couldn't verify" but **does not interrupt**.
7. User actions finalise: `USED`, `DISMISSED`, `MARK_RESOLVED`, plus feedback flags.

### 1.3a Timing modes: proactive, reactive, retroactive

ThirdSeat chooses *when* to contribute per question and situation (human request, 2026-10-04: "we are
being very retroactive — we have to be all 3"):

| Mode | When | Examples |
|---|---|---|
| **PROACTIVE** | Before anyone signals a gap | Research starts the moment a factual question is asked. If the answer is ready and nobody has answered after a short grace period (2 utterances or 8 s), it is offered. A question asked to the room ("does anyone know…") is answered as soon as the answer is ready. A tentative factual claim about something external ("I think X supports Y") is checked unprompted. Drift and reasoning notes. |
| **REACTIVE** | When humans signal a gap | "Not sure", "let's check later", "I think so". The answer is usually already prepared, so it appears at once. |
| **RETROACTIVE** | Returning to something the conversation moved past | An answer that arrives ≥ 90 s after the question or after the topic moved on is framed "Back to “…” (raised N min ago)". Dropped threads are recalled at decision points. Open items are listed at a conclusion. |

Guardrails: research done ahead of time is invisible and discarded if a human answers. Proactive
contributions pass the same priority threshold, so weak (UNVERIFIED) evidence is listed without
interrupting. `THIRDSEAT_PROACTIVE=0` disables advance research.

### 1.3b Voice participation (human request, 2026-10-09)

ThirdSeat can take part in the meeting by voice, like a team member, **only on gap points**.

| Aspect | Behaviour |
|---|---|
| What it says unprompted | The same contributions it surfaces as cards: answers (HIGH/LIKELY confidence only, never UNVERIFIED), checked assumptions, dropped threads at decision points, material drift, open items at a conclusion, conservative reasoning gaps. One short spoken turn each (≤ 40 words). |
| Phrasing | Teammate style per timing mode ("I can take that one…", "I checked that one…", "Going back to the question about Zoom — …", "Before we decide — we never settled this: …?"). With AI, Claude may rephrase, but any number or name not present in the source rejects the rephrasing (template used instead). |
| Turn-taking | Speaks only after ≥ 1.5 s of silence; never starts over a person; stops mid-sentence when someone starts talking (barge-in) and does not repeat. Unsolicited turns ≥ 30 s apart. Not spoken within 20 s → the moment has passed (card stays on screen). |
| Addressed by name | Vocative only ("ThirdSeat, …", "…, ThirdSeat?"). In scope: where an answer came from, how sure it is, "that's wrong" (flags INCORRECT), "what's still open?", "repeat", "check/look up X" (researched, answer spoken), "quiet" (mute) and "you can talk again". Anything else: "That one's yours — I'll jump in on open questions and facts." "Thanks" gets silence. Addressed lines are never analysed as conversation. |
| Hearing itself | Heard text that mostly repeats its own recent speech is dropped (in both utterances and live captions). |
| Control | Off by default; switched on per session; Mute button; "ThirdSeat, quiet". |
| Output | Browser built-in voices (default) or a server voice (Deepgram Aura), which can be routed to any output device, e.g. a virtual microphone for a web call. |

### 1.4 Open-thread lifecycle

Strategic/important question raised → acknowledged or left → conversation moves on → kept
as `OPEN` with relevance to objective. Surfaced later **only when** all hold:
- still unresolved and not being discussed right now,
- enough time/turns have passed (default ≥ 120 s and ≥ 6 utterances),
- the current discussion reaches an objective-critical moment (conclusion signal, or a
  topic overlapping the thread / objective), or a drift intervention needs to name blockers.

### 1.5 Session objective

Optional free text, e.g. "Decide whether this idea deserves validation and identify the
biggest unknowns". It is the intended outcome, not an agenda. It is used for relevance
scoring, drift materiality, and conclusion support. No meeting-type keywords are
hard-coded anywhere in the core.

### 1.6 Intervention policy

- Priority = base(type, reason) × confidence factor × objective relevance, minus
  interruption cost (recent interventions), with urgency boost for deferrals.
- Cooldown between interruptions (default 20 s) unless priority ≥ 0.85.
- At most 3 *active* (unactioned) intervention cards; extra items queue by priority.
- Duplicate questions are merged (token-set similarity).
- Every decision stores a concise reason string (no chain-of-thought).

### 1.7 User actions

`USE`, `DISMISS`, `OPEN_SOURCE`, `RESEARCH_MORE`, `MARK_RESOLVED`, and feedback flags:
`INCORRECT`, `FALSE_POSITIVE`, `SAVED_FOLLOW_UP`, `HELPED_CONCLUSION`, `TOO_LATE`.

### 1.8 Session-end validation view

Counts and lists for evaluation: gaps detected/resolved/open, naturally resolved,
interventions used/dismissed, false positives, incorrect answers, follow-ups avoided
(system-inferred vs. human-confirmed, kept separate), threads recovered, drift
interventions, conclusion-support interventions, time-to-useful-intervention
(median/p90), plus a free-text human validation form. This exists for evaluation; it is
not the product.

## 2. Non-functional requirements

| Area | Requirement |
|---|---|
| Latency | Record per gap: detected, qualified, research started, first evidence, answer ready, surfaced, resolved. Primary metric **TIME_TO_USEFUL_INTERVENTION** = surfaced − trigger utterance time. Also record whether the topic was still live when surfaced. |
| Honesty | No answer without evidence. Answers carry confidence + sources. Unverifiable → UNRESOLVED. |
| Determinism | All core logic runs against an injectable `Clock`; scripted scenarios replay identically in tests. |
| Replaceability | `ConversationSource`, `ConversationAnalyzer`, `ResearchTool`, `AnswerSynthesizer`, `LlmClient` are interfaces. |
| Privacy | Transcript kept in memory only; deleted with the session. Logs never contain utterance text unless `THIRDSEAT_LOG_CONTENT=1`. API keys server-side only. External services receiving content are documented in `HANDOVER.md`. |
| Simplicity | Modular monolith, one Node process, no database, no queue. |

## 3. Domain concepts

`Session`, `Utterance`, `Objective`, `ConversationState`, `Watch` (pending question),
`Gap`, `GapType`, `GapStatus`, `DetectionReason`, `Evidence`, `SourceTier`, `Confidence`,
`ResearchRun`, `Intervention`, `UserAction`, `FeedbackFlag`, `SessionMetrics`.

Gap (implemented shape, deliberately close to the human's sketch):

```
id, sessionId, type, reason, status, triggerUtteranceId, transcriptContext[],
interpretedQuestion, relevanceToObjective (0..1), priority, confidence,
evidence[], answer, caveat, interventionText, decisionLog[] (concise reasons),
timing { triggerAt, detectedAt, qualifiedAt, researchStartedAt, firstEvidenceAt,
         answeredAt, surfacedAt, resolvedAt }, userActions[], feedback[], researchDurationMs
```

## 4. Architecture

TypeScript on Node 22 (native type stripping — no build step). One process.

```
src/
  domain/        types, ids, text utilities (tokenise, similarity)
  clock.ts       Clock (real / manual for deterministic tests)
  conversation/  ConversationSource + Simulation / Manual sources, scenario loader
  state/         ConversationState (compact, consolidated)
  analysis/      ConversationAnalyzer interface; HeuristicAnalyzer; LlmAnalyzer (Claude)
  gaps/          GapEngine (orchestration: watches, qualification, natural resolution,
                 research dispatch, open threads, drift, conclusion)
  research/      ResearchTool interface, ToolRegistry, ResearchPlanner,
                 tools: ConversationContextTool, SuppliedSourcesTool (URLs/files, BM25),
                 ClaudeWebSearchTool; synthesizers: Extractive (no LLM), Llm (Claude)
  evidence/      source ranking (configurable tiers), confidence assessment
  intervention/  InterventionPolicy (priority, cooldown, active cap, dedupe)
  metrics/       session metrics + latency + report
  llm/           LlmClient interface + Anthropic implementation
  server/        node:http JSON API + Server-Sent Events + static UI
web/             minimal UI (vanilla HTML/CSS/JS)
scenarios/       scripted conversations (10 required + whiteboarding validation)
tests/           node:test suites
scripts/         scenario runner, real-research end-to-end run
```

Tool layer: `Gap → ResearchPlanner → ToolRegistry → ResearchTool → Evidence[] →
EvidenceAssessor → AnswerSynthesizer → Answer`. An MCP-backed tool is a future
`ResearchTool` implementation; the product intelligence stays above the tool layer.

## 5. Integrations

| Integration | V0 status |
|---|---|
| Anthropic Claude (analysis, synthesis, web search server tool) | Implemented; enabled when credentials are present (`THIRDSEAT_LLM=anthropic`). Model `claude-opus-5-5`, effort configurable. |
| User-supplied URLs / local documents | Implemented (fetch, chunk, BM25 rank). Works without any LLM. |
| Browser microphone (Web Speech API) | Implemented in UI as an optional live source (Chrome). |
| Teams / Meet / Zoom | Not in V0 (future `ConversationSource` implementations). |
| MCP / enterprise tools | Not in V0 (future `ResearchTool` implementations). |

## 6. Validation criteria

- The 10 required scenarios (`scenarios/s01…s10`) pass as automated tests with
  deterministic research fixtures.
- At least one recorded run uses **real external retrieval** with no hard-coded answer.
- Latency fields populated and shown in UI and report.
- First live validation: two humans, unscripted, 30–60 min, objective entered first;
  capture per `VERIFICATION_LEDGER.md` §Live validation template.

## 7. Constraints

No hard-coded meeting-type terminology in core logic. No autonomous speech. No exposure
of hidden reasoning. No fabricated answers. No feature that fails the North Star test:
*does this help identify or close a meaningful gap while the conversation is happening?*

## 8. Explicit non-goals

See `SCOPE.md` → OUT OF SCOPE FOR V0. In short: not a note taker, transcriber, summariser,
minutes generator, action-item manager, analytics product, avatar, voice bot, chairperson,
interview scorer, sales coach, CRM, or enterprise search.
