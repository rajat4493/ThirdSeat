// Injectable time so every behaviour can be replayed deterministically in tests.

export interface Clock {
  now(): number;
}

export const realClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  private t: number;
  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(t: number): void {
    this.t = t;
  }
}
