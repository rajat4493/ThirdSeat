// Regression guard: voice participation over the full scored conversation keeps all invariants
// (never over people, only gap points, silent on controls, paced, scoped replies when addressed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('voice simulation over x01 passes all invariants', () => {
  const r = spawnSync(process.execPath, ['scripts/voice-simulation.ts'], { encoding: 'utf8' });
  assert.match(r.stdout, /10\/10 checks passed/, r.stdout.slice(-2500));
});
