// Input abstraction. The product intelligence never knows where utterances come from.
// Future: TeamsConversationSource, MeetConversationSource, ZoomConversationSource, …

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManualClock } from '../clock.ts';

export interface IncomingUtterance {
  speaker: string;
  text: string;
  at?: number;
}

export type UtteranceSink = (u: IncomingUtterance) => void;

export interface ConversationSource {
  readonly id: string;
  start(sink: UtteranceSink): void;
  stop(): void;
}

/** Utterances pushed from outside: typed input or browser speech recognition via the HTTP API. */
export class ManualConversationSource implements ConversationSource {
  readonly id = 'manual';
  private sink?: UtteranceSink;
  start(sink: UtteranceSink): void {
    this.sink = sink;
  }
  stop(): void {
    this.sink = undefined;
  }
  push(u: IncomingUtterance): void {
    if (!this.sink) throw new Error('source not started');
    this.sink(u);
  }
}

export interface ScriptLine {
  /** Seconds from scenario start. */
  t: number;
  s: string;
  text: string;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  objective?: string;
  sourceUrls?: string[];
  lines: ScriptLine[];
}

/** Replays a scripted conversation in real time (scaled by `speed`). */
export class SimulationConversationSource implements ConversationSource {
  readonly id: string;
  private timers: NodeJS.Timeout[] = [];
  private scenario: Scenario;
  private speed: number;
  onEnd?: () => void;

  constructor(scenario: Scenario, speed = 1) {
    this.scenario = scenario;
    this.speed = Math.max(0.1, speed);
    this.id = `simulation:${scenario.id}`;
  }

  start(sink: UtteranceSink): void {
    for (const line of this.scenario.lines) {
      this.timers.push(setTimeout(() => sink({ speaker: line.s, text: line.text }), (line.t * 1000) / this.speed));
    }
    const end = Math.max(0, ...this.scenario.lines.map((l) => l.t));
    this.timers.push(setTimeout(() => this.onEnd?.(), (end * 1000) / this.speed + 50));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

/**
 * Deterministic replay on a ManualClock: advances virtual time line by line, letting the engine
 * tick and finish async work between lines. Used by tests and the scenario runner.
 */
export async function replayDeterministic(
  scenario: Scenario,
  clock: ManualClock,
  engine: { ingest(u: IncomingUtterance): unknown; drain(): Promise<void>; tick(): void },
  opts: { tailSeconds?: number; afterLine?: (i: number) => Promise<void> | void } = {},
): Promise<void> {
  const start = clock.now();
  for (let i = 0; i < scenario.lines.length; i++) {
    const line = scenario.lines[i];
    const target = start + line.t * 1000;
    // Tick once per virtual second so time-based behaviour (watch expiry, drift) is exercised.
    while (clock.now() + 1000 <= target) {
      clock.advance(1000);
      engine.tick();
    }
    clock.set(Math.max(clock.now(), target));
    engine.ingest({ speaker: line.s, text: line.text, at: clock.now() });
    await engine.drain();
    await opts.afterLine?.(i);
  }
  for (let s = 0; s < (opts.tailSeconds ?? 30); s++) {
    clock.advance(1000);
    engine.tick();
  }
  await engine.drain();
}

export async function loadScenarios(dir: string): Promise<Scenario[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as Scenario));
}
