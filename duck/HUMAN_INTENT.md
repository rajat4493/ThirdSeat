# ThirdSeat — Human Intent

> TheDuck artifact 1 of 8. This file restates the human's intent in plain English.
> It is authoritative over every other artifact in this folder. If code or docs drift from
> it, the code and docs are wrong.

## The product in one sentence

ThirdSeat is a **generic intelligent presence inside a live conversation** that notices
**meaningful gaps** — things that are stopping the people from making progress — and
**helps close them while the conversation is still happening**, so people reach useful
conclusions with fewer follow-ups.

## The problem

Meetings stall on gaps:

- a factual question nobody can answer ("Does X support Y?")
- "I'll check and come back"
- an important assumption nobody verifies
- an important question that is raised, then forgotten
- the group moving on before resolving something that matters
- the discussion drifting away from what it was meant to achieve
- the group having enough to conclude, but not concluding
- missing context that blocks progress

Today these gaps become follow-up emails, action items, extra research, delayed decisions,
another meeting, or a vague conclusion.

## What the product does about it

It listens to the live conversation, keeps track of what the session is trying to achieve,
and asks itself one question over and over:

> **What is missing right now that would help this conversation move forward —
> and can we do something useful about it before the conversation moves on?**

When the answer is "something, yes", it quietly surfaces a short, evidence-backed
contribution in a private side panel. When the answer is "nothing worth interrupting for",
it stays silent. Silence is a feature.

## The critical distinction

| The product is NOT asking | The product IS asking |
|---|---|
| "What was said?" | "What is missing right now?" |
| "What should the minutes say?" | "Can we close this before the topic moves on?" |

It is **not** a note taker, transcriber, summariser, minutes generator, action-item
extractor, agenda tool, interview tool, sales coach, analytics dashboard, CRM, avatar,
voice bot, autonomous chairperson, or generic enterprise search. Some of those might exist
around the core one day. None of them is the core.

## Generic product vs. first validation scenario

**These are different things and must stay different.**

| | Generic product | First validation scenario |
|---|---|---|
| What | Gap-closing presence for *any* live conversation (product, strategy, technical, vendor, planning, incident, interviews, sales, discovery, reviews…) | Two humans whiteboarding an idea or strategy for 30–60 minutes, with ThirdSeat as the third participant |
| Role | The thing we are building | The first place we check whether the thing works |
| Design rule | No meeting-type-specific behaviour in the core. Meeting-specific tuning, if ever needed, is configuration (a future `MeetingPolicy`) | Must not shape the architecture. We do not optimise for these two humans, this topic, or this format |

The whiteboarding session is a **test environment**, not a product definition. If a design
decision only makes sense for two people whiteboarding, it is the wrong decision.

## What "good" looks like

After several sessions the people involved feel that **removing ThirdSeat would make the
conversation worse** — e.g. "we'd otherwise have had to check that later", "good catch, we
forgot that question", "that helped us decide".

## What "bad" looks like (and must be reported honestly)

Mostly obvious information; answers humans already knew; answers arriving after the
discussion has moved on; many false positives; constant distraction; most interventions
dismissed; untrustworthy research; "ChatGPT in a side panel"; no effect on conclusions or
follow-up work.

## Non-negotiables carried from the human

1. Prefer "I couldn't verify this reliably" over an unsupported answer. Never fabricate certainty.
2. Minimum interruption, maximum contribution. The AI may — and usually should — stay silent.
3. Interventions appear privately in the product UI. The AI does not speak into the meeting.
4. Do not expose hidden chain-of-thought; store concise machine-readable reasons.
5. Timing matters: measure time-to-useful-intervention from day one.
6. At least one real end-to-end flow (conversation → gap → research → real external
   evidence → answer → surfaced intervention). No hard-coded answers dressed up as success.
