# ThirdSeat — Scope Control

> TheDuck artifact 4 of 8. **Any proposed feature must be checked against this file** and
> against the North Star:
>
> *Does this help the AI identify or close a meaningful gap while the conversation is
> happening, so the people can make progress now rather than later?*
> If no → exclude it.

## IN SCOPE (V0)

- Live conversation ingestion (via a replaceable `ConversationSource`: simulation, typed input, live audio: room microphone or browser-tab call audio, with server speech-to-text and speaker separation)
- Objective awareness (optional session objective)
- Conversation state (compact, live)
- Knowledge-gap detection (explicit, deferred, weak-answer verification)
- Natural-resolution suppression (incl. cancelling in-flight research)
- Unresolved-thread tracking and recall
- Research (replaceable tools; supplied URLs/docs; Claude web search when credentials exist)
- Evidence-backed intervention with confidence and sources
- Basic, conservative drift detection
- Conservative conclusion support (remaining blockers, not a summary)
- Validation metrics, latency instrumentation, session-end validation view
- Deterministic simulation harness

## OUT OF SCOPE FOR V0

- Generic meeting notes
- Meeting transcription product (transcript is an input, never a deliverable)
- Post-meeting summaries / minutes
- Autonomous voice participation
- Calendar integrations
- Full Teams/Meet/Zoom integration
- Enterprise MCP ecosystem
- Interview scoring
- Sales coaching
- Action-item project management
- Complex analytics, graphs, dashboards
- Meeting avatars
- Autonomous meeting chairing
- User accounts, auth, multi-tenant permissions
- Persistent database

## FUTURE (designed for, not built)

- Enterprise MCP tools (as `ResearchTool` implementations)
- Previous-meeting memory (CONTEXT gaps)
- Internal knowledge search
- Role-specific AI presence (`MeetingPolicy` configuration)
- Autonomous public participation (voice)
- Richer reasoning-gap detection
- Decision support
- Interviews, architecture reviews, sales, incident response (as policies, not forks)

## Scope decisions log

| Date | Proposal | Decision | Why |
|---|---|---|---|
| 2026-10-02 | Export transcript at session end | **Rejected** | Turns product toward note-taking; privacy. Report contains gaps/interventions, not the transcript. |
| 2026-10-02 | Summarise the conversation at the end | **Rejected** | Summariser. Conclusion support lists *remaining blockers* only, live. |
| 2026-10-02 | Speculative research on every factual question before qualification | **Deferred** | Could cut latency but increases cost/noise; revisit with live latency data. |
| 2026-10-04 | Be proactive, reactive *and* retroactive depending on the situation (human request) | **Accepted** | Supersedes the deferral above: advance research is now on by default (switchable off). Proactive cards still pass the priority threshold, so silence remains the default. |
| 2026-10-02 | Browser mic input via Web Speech API | **Accepted** | Needed for live validation; behind the `ConversationSource` abstraction. |
| 2026-10-02 | Charts in session-end view | **Rejected** | Analytics clutter; counts and lists suffice for validation. |
| 2026-10-02 | "Audio enablement" (human request) | **Accepted as audio *input*** | Human chose better listening (room mic + call tab, speaker separation) over speaking. Directly serves gap detection. Server speech-to-text behind `SpeechToTextProvider`. |
| 2026-10-02 | ThirdSeat speaking (private or into the meeting) | **Not built** | Not chosen by the human; speaking into the meeting stays OUT OF SCOPE FOR V0. |
| 2026-10-02 | Native Teams/Zoom/Meet integration for audio | **Deferred** | Browser tab capture covers web calls for validation; platform bots remain FUTURE. |
