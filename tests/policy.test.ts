import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InterventionPolicy } from '../src/intervention/policy.ts';

const c = (gapId: string, priority: number, offeredAt = 0, expiresAt = 1e9) => ({ gapId, kind: 'KNOWLEDGE' as const, priority, text: gapId, offeredAt, expiresAt });

test('drops low-priority and stale candidates; surfaces highest first; respects cooldown', () => {
  const p = new InterventionPolicy({ cooldownMs: 20_000, maxActive: 3, minPriority: 0.4, urgentPriority: 0.85 });
  p.offer(c('low', 0.2));
  p.offer(c('stale', 0.7, 0, 10));
  p.offer(c('a', 0.6));
  p.offer(c('b', 0.8));
  const d = p.flush(100, 0);
  const by = Object.fromEntries(d.map((x) => [x.candidate.gapId, x.decision]));
  assert.deepEqual(by, { low: 'DROP', stale: 'DROP', b: 'SURFACE', a: 'HOLD' });
  assert.deepEqual(p.flush(10_000, 1).map((x) => x.decision), ['HOLD']);
  assert.deepEqual(p.flush(21_000, 1).map((x) => x.decision), ['SURFACE']);
});

test('active-card cap holds normal items; urgent items bypass cap and cooldown', () => {
  const p = new InterventionPolicy({ cooldownMs: 20_000, maxActive: 2, minPriority: 0.4, urgentPriority: 0.85 });
  p.offer(c('n', 0.7));
  p.offer(c('u', 0.9));
  const d = p.flush(0, 2);
  const by = Object.fromEntries(d.map((x) => [x.candidate.gapId, x.decision]));
  assert.deepEqual(by, { u: 'SURFACE', n: 'HOLD' });
});

test('withdraw removes a pending candidate (natural resolution)', () => {
  const p = new InterventionPolicy();
  p.offer(c('x', 0.9));
  assert.equal(p.withdraw('x'), true);
  assert.equal(p.flush(0, 0).length, 0);
});
