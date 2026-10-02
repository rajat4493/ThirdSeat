// Decides when a candidate contribution is worth an interruption. Minimum interruption, maximum contribution.

import type { GapType, Millis } from '../domain/types.ts';

export interface Candidate {
  gapId: string;
  kind: GapType;
  priority: number;
  text: string;
  offeredAt: Millis;
  /** Candidates go stale: a contribution that arrives too late is noise. */
  expiresAt: Millis;
}

export interface PolicyConfig {
  cooldownMs: number;
  maxActive: number;
  minPriority: number;
  /** At or above this, cooldown and the active-card cap are ignored (e.g. the group is concluding with open blockers). */
  urgentPriority: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  cooldownMs: 20_000,
  maxActive: 3,
  minPriority: 0.4,
  urgentPriority: 0.85,
};

export interface PolicyDecision {
  candidate: Candidate;
  decision: 'SURFACE' | 'HOLD' | 'DROP';
  reason: string;
}

export class InterventionPolicy {
  private queue = new Map<string, Candidate>();
  private lastSurfacedAt = -Infinity;
  cfg: PolicyConfig;

  constructor(cfg: Partial<PolicyConfig> = {}) {
    this.cfg = { ...DEFAULT_POLICY, ...cfg };
  }

  offer(c: Candidate): void {
    this.queue.set(c.gapId, c);
  }

  withdraw(gapId: string): boolean {
    return this.queue.delete(gapId);
  }

  pending(): Candidate[] {
    return [...this.queue.values()].sort((a, b) => b.priority - a.priority);
  }

  /** Returns a decision for every queued candidate; SURFACE and DROP ones leave the queue. */
  flush(now: Millis, activeCount: number): PolicyDecision[] {
    const out: PolicyDecision[] = [];
    let active = activeCount;
    for (const c of this.pending()) {
      if (c.priority < this.cfg.minPriority) {
        this.queue.delete(c.gapId);
        out.push({ candidate: c, decision: 'DROP', reason: `priority ${c.priority.toFixed(2)} below threshold` });
        continue;
      }
      if (now > c.expiresAt) {
        this.queue.delete(c.gapId);
        out.push({ candidate: c, decision: 'DROP', reason: 'stale: conversation has moved on' });
        continue;
      }
      const urgent = c.priority >= this.cfg.urgentPriority;
      if (active >= this.cfg.maxActive && !urgent) {
        out.push({ candidate: c, decision: 'HOLD', reason: `${active} unactioned cards already visible` });
        continue;
      }
      if (!urgent && now - this.lastSurfacedAt < this.cfg.cooldownMs) {
        out.push({ candidate: c, decision: 'HOLD', reason: 'cooldown after recent intervention' });
        continue;
      }
      this.queue.delete(c.gapId);
      this.lastSurfacedAt = now;
      active++;
      out.push({ candidate: c, decision: 'SURFACE', reason: urgent ? 'high priority' : `priority ${c.priority.toFixed(2)}` });
    }
    return out;
  }
}
