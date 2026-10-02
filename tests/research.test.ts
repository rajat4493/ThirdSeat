import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtractiveSynthesizer, LlmSynthesizer, chooseDraft } from '../src/research/synthesizers.ts';
import { SuppliedSourcesTool, cleanText } from '../src/research/tools/supplied-sources.ts';
import { ClaudeWebSearchTool, parseConfidence } from '../src/research/tools/claude-web-search.ts';
import { tierForUrl, capConfidence } from '../src/evidence/source-ranking.ts';
import { ConversationState } from '../src/state/conversation-state.ts';
import type { Evidence, Gap } from '../src/domain/types.ts';
import type { LlmClient } from '../src/llm/client.ts';

const ev = (over: Partial<Evidence>): Evidence => ({ id: 'e1', toolId: 't', sourceTier: 'official_docs', title: 'Doc', url: 'https://x', excerpt: 'text', score: 0.9, retrievedAt: 0, ...over });
const gap = (q: string): Gap => ({
  id: 'g1', sessionId: 's', type: 'KNOWLEDGE', reason: 'EXPLICIT_UNANSWERED_QUESTION', status: 'DETECTED', triggerUtteranceId: 'u', contextUtteranceIds: [],
  trigger: q, interpretedQuestion: q, relevanceToObjective: 0.6, researchable: true, priority: 0.7, evidence: [], timing: { triggerAt: 0, detectedAt: 0 },
  decisionLog: [], userActions: [], feedback: [],
});

test('source tiers are configurable rules over hosts and paths', () => {
  assert.equal(tierForUrl('https://learn.microsoft.com/en-us/graph/api/x'), 'official_docs');
  assert.equal(tierForUrl('https://raw.githubusercontent.com/MicrosoftDocs/msteams-docs/main/a.md'), 'official_docs');
  assert.equal(tierForUrl('https://raw.githubusercontent.com/someone/blog/main/a.md'), 'general_web');
  assert.equal(tierForUrl('https://stackoverflow.com/q/1'), 'reliable_technical');
  assert.equal(tierForUrl('https://random-blog.example.com/post'), 'general_web');
});

test('confidence is capped by evidence quality', () => {
  assert.equal(capConfidence('HIGH', []), 'UNVERIFIED');
  assert.equal(capConfidence('HIGH', [ev({ sourceTier: 'general_web' })]), 'LIKELY');
  assert.equal(capConfidence('HIGH', [ev({})]), 'HIGH');
});

test('extractive synthesizer never claims more than UNVERIFIED and refuses weak evidence', async () => {
  const s = new ExtractiveSynthesizer();
  const strong = await s.synthesize({ question: 'q', evidence: [ev({ score: 0.8 })] });
  assert.equal(strong.outcome, 'PARTIALLY_RESOLVED');
  assert.equal(strong.confidence, 'UNVERIFIED');
  assert.match(strong.answer!, /Possibly relevant/);
  const weak = await s.synthesize({ question: 'q', evidence: [ev({ score: 0.3 })] });
  assert.equal(weak.outcome, 'UNRESOLVED');
  assert.equal(weak.answer, undefined);
  const web = await s.synthesize({ question: 'q', evidence: [ev({ sourceTier: 'general_web' })] });
  assert.equal(web.outcome, 'UNRESOLVED', 'general web passages are not offered as answers');
});

test('cited drafts are used only when they cite retrieved evidence', () => {
  const e = ev({ id: 'e9' });
  assert.equal(chooseDraft([{ answer: 'A', confidence: 'HIGH', citedEvidenceIds: ['nope'] }], [e]), undefined);
  const ok = chooseDraft([{ answer: 'A', confidence: 'HIGH', citedEvidenceIds: ['e9'] }], [e]);
  assert.equal(ok?.outcome, 'RESOLVED');
});

test('LLM synthesizer rejects answers that cite no real evidence', async () => {
  const fake = (r: unknown): LlmClient => ({ id: 'fake', json: async <T>() => r as T, webSearch: async () => ({ text: '', citations: [], results: [] }) });
  const signal = new AbortController().signal;
  const bad = await new LlmSynthesizer(fake({ answerable: true, answer: 'Yes', confidence: 'HIGH', evidence_ids: ['made-up'], caveat: '' })).synthesize({ question: 'q', context: [], evidence: [ev({})], signal });
  assert.equal(bad.outcome, 'UNRESOLVED');
  const good = await new LlmSynthesizer(fake({ answerable: true, answer: 'Yes, with limits.', confidence: 'HIGH', evidence_ids: ['e1'], caveat: '' })).synthesize({ question: 'q', context: [], evidence: [ev({})], signal });
  assert.equal(good.outcome, 'RESOLVED');
  const webOnly = await new LlmSynthesizer(fake({ answerable: true, answer: 'Yes', confidence: 'HIGH', evidence_ids: ['e1'], caveat: '' })).synthesize({ question: 'q', context: [], evidence: [ev({ sourceTier: 'general_web' })], signal });
  assert.equal(webOnly.confidence, 'LIKELY', 'HIGH requires an authoritative source');
});

test('web search tool turns citations into evidence and parses confidence', async () => {
  assert.deepEqual(parseConfidence('Yes, via X.\nCONFIDENCE: HIGH'), { body: 'Yes, via X.', confidence: 'HIGH' });
  assert.equal(parseConfidence('No marker').confidence, 'UNVERIFIED');
  const llm: LlmClient = {
    id: 'fake',
    json: async () => { throw new Error('unused'); },
    webSearch: async () => ({
      text: 'Graph transcripts are available after the meeting ends.\nCONFIDENCE: HIGH',
      citations: [{ url: 'https://learn.microsoft.com/graph/transcripts', title: 'Transcripts', citedText: 'after the meeting ends' }],
      results: [],
    }),
  };
  const r = await new ClaudeWebSearchTool(llm).research({ gap: gap('q'), query: 'q', context: [], state: new ConversationState(), depth: 'normal', signal: new AbortController().signal });
  assert.equal(r.evidence[0].sourceTier, 'official_docs');
  assert.equal(r.draft?.confidence, 'HIGH');
  assert.deepEqual(r.draft?.citedEvidenceIds, [r.evidence[0].id]);
  const none: LlmClient = { ...llm, webSearch: async () => ({ text: 'I think yes.\nCONFIDENCE: HIGH', citations: [], results: [] }) };
  const r2 = await new ClaudeWebSearchTool(none).research({ gap: gap('q'), query: 'q', context: [], state: new ConversationState(), depth: 'normal', signal: new AbortController().signal });
  assert.equal(r2.draft?.confidence, 'UNVERIFIED', 'no citations → unverified');
});

test('supplied sources: markdown cleaned, chunked and ranked by relevance (local, no network)', async () => {
  const md = `---\ntitle: Widget API limits\n---\n# Widget API\n\nIntro text about widgets.\n\n## Rate limits\n\nThe Widget API allows 600 requests per minute per tenant. Bursts above that return HTTP 429.\n\n## Webhooks\n\nWebhooks fire when a widget is created or deleted.`;
  assert.equal(cleanText(md).title, 'Widget API limits');
  const tool = new SuppliedSourcesTool({ docs: [{ url: 'https://docs.example.com/widgets', title: 'Widget API limits', text: cleanText(md).text }] });
  const r = await tool.research({ gap: gap('What is the rate limit of the Widget API?'), query: 'What is the rate limit of the Widget API?', context: [], state: new ConversationState(), depth: 'normal', signal: new AbortController().signal });
  assert.ok(r.evidence.length >= 1);
  assert.match(r.evidence[0].title, /Rate limits/);
  assert.match(r.evidence[0].excerpt, /600 requests per minute/);
});
