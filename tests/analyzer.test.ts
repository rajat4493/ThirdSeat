import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, parseQuestion, namedEntities, HeuristicAnalyzer } from '../src/analysis/heuristic-analyzer.ts';
import { ConversationState } from '../src/state/conversation-state.ts';

test('question kinds', () => {
  const k = (t: string) => parseQuestion(t)?.kind;
  assert.equal(k('Does OutSystems support SAML in this configuration?'), 'FACTUAL');
  assert.equal(k('So, what is the API rate limit for Graph?'), 'FACTUAL');
  assert.equal(k("Why wouldn't Microsoft just build this into Copilot?"), 'STRATEGIC');
  assert.equal(k('Would customers pay for this?'), 'STRATEGIC');
  assert.equal(k('Should we go with option B?'), 'DECISION');
  assert.equal(k('Right?'), 'SOCIAL');
  assert.equal(k('Does that make sense?'), 'SOCIAL');
  assert.equal(k('What about the onboarding flow?'), 'SOCIAL');
  assert.equal(k('We should ship on Friday.'), undefined);
});

test('embedded uncertain question ("not sure whether …") is a question with built-in uncertainty', () => {
  const q = parseQuestion("I'm not sure whether Zoom exposes raw audio to apps.");
  assert.equal(q?.kind, 'FACTUAL');
  assert.equal(q?.embeddedUncertain, true);
});

test('response classification', () => {
  const k = (t: string) => classifyResponse(t)?.kind;
  assert.equal(k("I'm not sure."), 'UNCERTAIN');
  assert.equal(k('No idea, honestly.'), 'UNCERTAIN');
  assert.equal(k("Let's check after the meeting."), 'DEFERRAL');
  assert.equal(k("I assume so. We'd need to check."), 'DEFERRAL', 'deferral outranks hedging');
  assert.equal(k('I think so.'), 'WEAK_ANSWER');
  assert.equal(k('Probably.'), 'WEAK_ANSWER');
  assert.equal(k("I'm almost sure."), 'WEAK_ANSWER');
  assert.equal(k('Yes. We already use Y for that in Project Z.'), 'CONFIDENT_ANSWER');
  assert.equal(k("That's a good point."), 'ACKNOWLEDGE');
  assert.equal(k('The portal needs accounts and invoices.'), undefined);
});

test('named entities drive "externally researchable"', () => {
  assert.deepEqual(namedEntities('Can Teams expose live transcript data to apps?'), ['Teams']);
  assert.ok(namedEntities('Does OutSystems support SAML?').includes('OutSystems'));
  assert.ok(namedEntities('Is S3 cheaper than GCS?').includes('S3'));
});

test('internal questions are not sent to public research', async () => {
  const a = new HeuristicAnalyzer();
  const state = new ConversationState('Decide the release scope');
  const u = { id: 'u1', sessionId: 's', speaker: 'A', text: 'Do we have budget for a contractor this quarter?', at: 0, seq: 1 };
  state.addUtterance(u);
  const out = await a.analyze({ state, newUtterances: [u], openQuestions: [] });
  assert.equal(out.questions[0].kind, 'FACTUAL');
  assert.equal(out.questions[0].researchable, false);
});

test('pronoun-only question is interpreted with the previous utterance as context', async () => {
  const a = new HeuristicAnalyzer();
  const state = new ConversationState();
  const u1 = { id: 'u1', sessionId: 's', speaker: 'A', text: 'We were looking at Okta for the login piece.', at: 0, seq: 1 };
  const u2 = { id: 'u2', sessionId: 's', speaker: 'B', text: 'Does it support SCIM provisioning?', at: 1, seq: 2 };
  state.addUtterance(u1);
  state.addUtterance(u2);
  const out = await a.analyze({ state, newUtterances: [u2], openQuestions: [] });
  assert.match(out.questions[0].interpretedQuestion, /Okta/);
});
