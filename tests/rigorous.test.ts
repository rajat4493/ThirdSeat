// Regression guard: the scored x01 conversation must keep passing its answer key.
// (x03 is the unbiased confirmation run and has known open failures — see docs/evidence/RIGOROUS_TEST_REPORT.md.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('x01 three-mode conversation passes its pre-committed answer key', () => {
  const r = spawnSync(process.execPath, ['scripts/rigorous-three-modes.ts'], { encoding: 'utf8' });
  assert.match(r.stdout, /15\/15 checks passed/, r.stdout.slice(-2000));
});
