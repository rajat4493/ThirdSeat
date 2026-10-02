// The LLM analyzer's contract: it maps model output into the same signals as the heuristic,
// and drops anything referencing ids the model was never given. Uses a fake client (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmAnalyzer } from '../src/analysis/llm-analyzer.ts';
import { ConversationState } from '../src/state/conversation-state.ts';
import type { JsonRequest, LlmClient } from '../src/llm/client.ts';
import { ManualClock } from '../src/clock.ts';
import { buildEngine } from '../src/app.ts';
import { FixtureResearchTool } from '../src/research/tools/fixture.ts';
import { FIXTURES } from './fixtures.ts';

function fakeLlm(respond: (req: JsonRequest) => unknown): LlmClient & { requests: JsonRequest[] } {
  const requests: JsonRequest[] = [];
  return {
    id: 'fake',
    requests,
    json: async <T>(req: JsonRequest) => {
      requests.push(req);
      return respond(req) as T;
    },
    webSearch: async () => ({ text: '', citations: [], results: [] }),
  };
}

const empty = { questions: [], responses: [], thread_activity: [], statements: [], conclusion_signals: [], commitment_signals: [], reasoning: [], claims: [], topic_relatedness: 0.9, topic_label: 'x' };

test('maps output, validates ids, sends compact state not full transcript', async () => {
  const state = new ConversationState('Decide X');
  for (let i = 1; i <= 30; i++) state.addUtterance({ id: `old${i}`, sessionId: 's', speaker: 'A', text: `older line ${i}`, at: i, seq: i });
  const u = { id: 'u31', sessionId: 's', speaker: 'B', text: 'Does Okta support SCIM?', at: 31, seq: 31 };
  state.addUtterance(u);
  const llm = fakeLlm(() => ({
    ...empty,
    questions: [
      { utterance_id: 'u31', kind: 'FACTUAL', interpreted_question: 'Does Okta support SCIM provisioning?', researchable: true, relevance: 1.7, note: 'n' },
      { utterance_id: 'ghost', kind: 'FACTUAL', interpreted_question: 'invented', researchable: true, relevance: 1, note: 'n' },
    ],
    responses: [{ utterance_id: 'u31', target_id: 'not-given', kind: 'UNCERTAIN', note: 'n' }],
  }));
  const out = await new LlmAnalyzer(llm).analyze({ state, newUtterances: [u], openQuestions: [] });
  assert.equal(out.questions.length, 1);
  assert.equal(out.questions[0].relevance, 1, 'clamped');
  assert.equal(out.responses.length, 0, 'unknown target dropped');
  const prompt = llm.requests[0].user;
  assert.doesNotMatch(prompt, /older line 1\b/, 'not the whole transcript');
  assert.match(prompt, /older line 30/);
  assert.equal(llm.requests[0].effort, 'low');
});

test('engine runs end-to-end on LLM signals and falls back to heuristics on LLM failure', async () => {
  const clock = new ManualClock(0);
  let fail = false;
  const llm = fakeLlm((req) => {
    if (fail) throw new Error('rate limited');
    const m = [...req.user.matchAll(/\[(u_[^\]]+)\] (\w+): (.*)/g)];
    const newPart = req.user.split('NEW UTTERANCES:')[1];
    const ids = [...newPart.matchAll(/\[(u_[^\]]+)\]/g)].map((x) => x[1]);
    if (/Teams/.test(newPart)) return { ...empty, questions: [{ utterance_id: ids[0], kind: 'FACTUAL', interpreted_question: 'Can Teams give external apps live transcript data?', researchable: true, relevance: 0.9, note: 'n' }] };
    if (/no clue/.test(newPart)) {
      const q = req.user.match(/\[(u_[^\]]+)\] \(FACTUAL/);
      return { ...empty, responses: [{ utterance_id: ids[0], target_id: q![1], kind: 'UNCERTAIN', note: 'n' }] };
    }
    void m;
    return empty;
  });
  const { engine } = buildEngine({
    session: { id: 's', createdAt: 0, title: 't', config: { objective: 'Decide whether to build on Teams', sourceUrls: [] } },
    clock,
    llm,
    webSearch: false,
    extraTools: [new FixtureResearchTool(FIXTURES)],
  });
  engine.ingest({ speaker: 'A', text: 'Can Teams give us the live transcript?' });
  await engine.drain();
  clock.advance(3000);
  engine.ingest({ speaker: 'B', text: 'I have no clue.' });
  await engine.drain();
  const g = [...engine.state.gaps.values()].find((x) => x.type === 'KNOWLEDGE')!;
  assert.equal(g.reason, 'EXPLICIT_UNANSWERED_QUESTION');
  assert.equal(g.interpretedQuestion, 'Can Teams give external apps live transcript data?');
  assert.equal(g.status, 'RESOLVED');

  fail = true;
  engine.ingest({ speaker: 'A', text: 'Does Snowflake support row-level security on external tables?' });
  engine.ingest({ speaker: 'B', text: 'No idea.' });
  await engine.drain();
  assert.ok(engine.log.some((l) => /using heuristic/.test(l.message)), 'fallback recorded');
  assert.ok([...engine.state.gaps.values()].some((x) => /Snowflake/.test(x.interpretedQuestion)));
});
