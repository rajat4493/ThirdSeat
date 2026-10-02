# ThirdSeat — Engineering Handover

> TheDuck artifact 7 of 8. Professional handover for the next engineer (human or agent).
> Read `HUMAN_INTENT.md` first; scope is governed by `SCOPE.md`.

## 1. Architecture

Modular monolith: one Node.js process, in-memory state, no database, no queue, no build step.

```
ConversationSource ──► GapEngine ──► ConversationAnalyzer (heuristic | LLM)
 (manual / simulation)     │                └─ signals: questions, responses, thread activity,
                           │                   statements, conclusion/commitment, reasoning, claims
                           ├─ watches → qualification → Gap
                           ├─ ResearchService ─► ToolRegistry ─► ResearchTool[]
                           │       │                 ├ ConversationContextTool (already established)
                           │       │                 ├ SuppliedSourcesTool (URLs / local docs, BM25)
                           │       │                 └ ClaudeWebSearchTool (Anthropic server tool)
                           │       └─ AnswerSynthesizer (cited draft | LLM | extractive) + confidence caps
                           ├─ open threads, drift, conclusion, reasoning checks (tick)
                           └─ InterventionPolicy (priority, cooldown, active cap, expiry) ─► events
HTTP server (JSON + SSE) ◄── events ──► web UI (vanilla JS)
```

Design rules that matter:
- **Analyzers only observe; the engine decides.** Heuristic and LLM analyzers emit the same
  signal contract (`src/analysis/types.ts`), so either can drive the engine and the heuristic is
  an automatic fallback.
- **Two-stage detection.** A question opens a *watch*. It becomes a gap only after a qualifying
  signal (uncertainty, deferral, weak answer, or no answer before the window closes).
- **Research never interrupts on failure.** UNRESOLVED gaps are listed, not surfaced.
- **All time goes through `Clock`.** Tests use `ManualClock` and replay scripts deterministically.

## 2. Modules

| Path | Responsibility |
|---|---|
| `src/domain/` | Types (`Gap`, `Evidence`, …), ids, text utilities (tokenise, stem, BM25) |
| `src/clock.ts` | Real and manual clocks |
| `src/conversation/sources.ts` | `ConversationSource` interface, manual + simulation sources, deterministic replay, scenario loader |
| `src/state/conversation-state.ts` | Compact live state; `compactView()` for LLM prompts (never the full transcript) |
| `src/analysis/heuristic-analyzer.ts` | Deterministic, explainable analyzer (lexicons are generic conversational phrases) |
| `src/analysis/llm-analyzer.ts` | Claude-based analyzer with strict JSON schema; validates every id it gets back |
| `src/gaps/engine.ts` | The core loop and all product decisions |
| `src/research/` | Tool interface, registry, research service (parallel tools, timeout, cancellation), synthesizers |
| `src/evidence/source-ranking.ts` | Configurable domain → tier rules; confidence caps |
| `src/intervention/policy.ts` | Priority queue, cooldown, active-card cap, expiry |
| `src/metrics/report.ts` | Session report (validation metrics + latency stats) |
| `src/llm/` | `LlmClient` interface + Anthropic implementation (official SDK) |
| `src/app.ts` | Composition root (`buildEngine`) |
| `src/server/main.ts` | HTTP API, SSE, static UI, session lifecycle |
| `web/` | UI (`index.html`, `app.js`, `styles.css`) |
| `scenarios/` | Scripted conversations (s01–s10 required scenarios; w01 whiteboard rehearsal) |
| `tests/` | `node:test` suites; `fixtures.ts` holds clearly-marked fake research results |
| `scripts/` | `run-scenario.ts` (replay + print), `e2e-real-research.ts` (real retrieval proof) |

## 3. Data model (key types)

- `Utterance {id, speaker, text, at, seq}`
- `Gap {id, type, reason, status, trigger, interpretedQuestion, relevanceToObjective, researchable,
  priority, confidence, evidence[], answer, caveat, interventionText, timing{triggerAt, detectedAt,
  qualifiedAt, researchStartedAt, firstEvidenceAt, answeredAt, surfacedAt, resolvedAt},
  researchDurationMs, topicLiveAtSurface, decisionLog[], userActions[], feedback[], relatedGapIds}`
- `GapType`: KNOWLEDGE, EVIDENCE, CONTEXT (reserved), OPEN_THREAD, REASONING, DECISION, DRIFT
- `GapStatus`: DETECTED, RESEARCHING, OPEN, RESOLVED, PARTIALLY_RESOLVED, UNRESOLVED, NATURALLY_RESOLVED, DISMISSED, NOT_A_GAP
- `DetectionReason`: QUESTION_RAISED (watched, stood down), EXPLICIT_UNANSWERED_QUESTION, DEFERRED_FOR_LATER,
  LOW_CONFIDENCE_HUMAN_RESPONSE, IMPORTANT_OPEN_THREAD, OBJECTIVE_BLOCKER, MATERIAL_OBJECTIVE_DRIFT,
  CONCLUSION_WITH_OPEN_BLOCKERS, UNSUPPORTED_INFERENCE, UNSUPPORTED_MATERIAL_CLAIM, USER_REQUESTED
- `Evidence {id, toolId, sourceTier, title, url, excerpt, score, retrievedAt}`
- `Confidence`: HIGH (official source directly answers) · LIKELY (good but partial) · UNVERIFIED

Outcome mapping: HIGH → RESOLVED, LIKELY → PARTIALLY_RESOLVED, no reliable answer → UNRESOLVED.
Extractive (no-LLM) answers from authoritative sources are PARTIALLY_RESOLVED but always UNVERIFIED.

## 4. Setup

Requires Node.js ≥ 22.18 (native TypeScript type stripping).

```bash
npm install
npm start                      # http://127.0.0.1:4317
```

## 5. Development commands

```bash
npm test                       # all tests (31): deterministic, no external network
npm run typecheck              # tsc --noEmit
npm run scenario -- all --fixtures         # replay all scenarios with fixture research, print timeline
npm run scenario -- w01 --real-sources     # rehearsal with live-fetched official docs
npm run e2e:real               # real-retrieval proof; writes docs/evidence/e2e-real-research.json
THIRDSEAT_LLM=anthropic npm run e2e:real   # same with Claude analysis/synthesis/web search
```

Code is TypeScript limited to erasable syntax (`erasableSyntaxOnly`): no enums, no parameter properties.

## 6. Tests

| Suite | Covers |
|---|---|
| `tests/scenarios.test.ts` | The 10 required scenarios + reasoning + no-objective drift |
| `tests/analyzer.test.ts` | Question kinds, response classes, entities, internal vs external, pronoun context |
| `tests/policy.test.ts` | Thresholds, staleness, cooldown, cap, urgency, withdrawal |
| `tests/research.test.ts` | Source tiers, confidence caps, extractive/LLM synthesis guards, web-search mapping, local retrieval |
| `tests/llm-analyzer.test.ts` | LLM signal mapping, id validation, compact prompt, end-to-end on LLM signals, heuristic fallback |
| `tests/server.test.ts` | Real server process: API, SSE, actions, report, privacy checks, deletion |

## 7. Deployment

V0 is meant to run locally on the facilitator's laptop: `npm start`, then open the browser. It binds
to 127.0.0.1 by default. To share it on a LAN, set `HOST=0.0.0.0`, but there is **no authentication**,
so only do that on a trusted network. A container or PaaS deploy is just `node src/server/main.ts` with
env vars. Sessions are in memory, so restarting the process loses them by design.

## 8. External services

| Service | When | What is sent |
|---|---|---|
| Anthropic API (Claude) | Only when `THIRDSEAT_LLM=anthropic` | Analysis: objective, compact state (open items, recent facts), ≈8 earlier + new utterances. Research: the interpreted question + up to 6 context lines. Synthesis: question, context, retrieved excerpts. Web search runs on Anthropic's side. |
| Supplied URLs | When a session lists source URLs | Plain HTTPS GET from the server, with no conversation content. |
| Google (via Chrome Web Speech API) | Only if the user clicks Mic in Chrome | Microphone audio, sent by the browser, not by ThirdSeat. |

## 9. Secrets / config

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` (or `ant auth login` profile) | — | Claude credentials, read only server-side by the SDK |
| `THIRDSEAT_LLM` | `off` | `anthropic` to enable Claude (explicit opt-in because content leaves the machine) |
| `THIRDSEAT_MODEL` | `claude-opus-5-5` | Model id |
| `THIRDSEAT_LLM_FALLBACKS` | `1` | Server-side refusal fallback routing (beta `server-side-fallback-2026-07-01`, `fallbacks: "default"`); `0` disables |
| `THIRDSEAT_WEB_SEARCH` | `1` | `0` disables Claude web search tool |
| `THIRDSEAT_DOCS_DIR` | — | Folder of `.md/.txt/.html` files to research in, for every session |
| `THIRDSEAT_SOURCE_RULES` | — | JSON array of `{match, tier}` source-ranking rules (prepended to defaults) |
| `THIRDSEAT_LOG_CONTENT` | `0` | `1` lets server logs include quoted conversation text |
| `THIRDSEAT_SESSION_TTL_HOURS` | `12` | Idle sessions are deleted after this |
| `PORT` / `HOST` | `4317` / `127.0.0.1` | Bind address |

LLM calls use effort `low` for analysis/synthesis (latency) and `medium` for "research more".

## 10. Known risks

1. **Heuristic understanding is lexical.** Paraphrases, sarcasm, and indirect uncertainty are missed. Drift can't separate semantic topics, only new vocabulary.
2. **Extractive answers can be off-target** (proven in e2e run). They are labelled UNVERIFIED and need a human to read them.
3. **LLM path is unvalidated live.** The prompt, schema and latency are untested against the real API. The first real run may need prompt or schema fixes (for example, strict-schema acceptance of `number` fields).
4. **Single-mic input has no diarization.** "Another person answered" logic degrades when every utterance is from "Room". The heuristic then treats any next utterance as a possible answer.
5. **Thresholds are untuned:** watch window 3 utterances / 25 s, cooldown 20 s, drift ≥ 3 min and 10 substantive utterances, thread recall ≥ 2 min and 6 utterances.
6. **Rehearsal speed distorts pacing.** Cooldown is in real seconds, so at 10× speed fewer cards surface than in a real-time conversation.
7. **SSRF surface.** The server fetches user-supplied URLs (http/https only, 2 MB cap, 15 s timeout). That is fine on localhost, but add an allowlist before any shared deployment.
8. **No auth.** Anyone who can reach the port can read sessions.

## 11. Limitations (by design for V0)

No persistence, no multi-user, no Teams/Meet/Zoom integration, no enterprise sources, no speech
output, no CONTEXT gaps (previous meetings), evidence gaps only in LLM mode.

## 12. Extension points

- **New input:** implement `ConversationSource` (`src/conversation/sources.ts`), e.g. a Teams real-time media bot feeding transcribed utterances.
- **New research source / MCP:** implement `ResearchTool` and register it in `buildEngine`. An MCP-backed tool is just another implementation. Rank its sources via `SourceTier` rules.
- **New LLM provider:** implement `LlmClient` (`json`, `webSearch`).
- **Meeting-specific behaviour:** add a `MeetingPolicy` that adjusts `EngineConfig` and policy weights. Keep it as configuration, not forks of the engine.
- **Speculative research** (start researching factual questions before qualification) to cut latency. It was deliberately deferred (see `SCOPE.md`).
