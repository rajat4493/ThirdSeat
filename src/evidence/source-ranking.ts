// Configurable source authority. Domain → tier rules are data, not code paths.

import type { Confidence, Evidence, SourceTier } from '../domain/types.ts';

export const TIER_WEIGHT: Record<SourceTier, number> = {
  conversation: 0.9,
  official_docs: 1.0,
  official_support: 0.85,
  user_supplied: 0.8,
  reliable_technical: 0.7,
  general_web: 0.45,
};

export interface TierRule {
  /** Hostname suffix or "host/path-prefix" (e.g. "raw.githubusercontent.com/MicrosoftDocs"). */
  match: string;
  tier: SourceTier;
}

/**
 * Default rules. Extend via THIRDSEAT_SOURCE_RULES (JSON array of TierRule).
 * Vendor documentation hosts are listed as examples of "official"; unknown hosts are general_web.
 */
export const DEFAULT_RULES: TierRule[] = [
  { match: 'learn.microsoft.com', tier: 'official_docs' },
  { match: 'raw.githubusercontent.com/MicrosoftDocs', tier: 'official_docs' },
  { match: 'raw.githubusercontent.com/microsoftgraph', tier: 'official_docs' },
  { match: 'docs.aws.amazon.com', tier: 'official_docs' },
  { match: 'cloud.google.com', tier: 'official_docs' },
  { match: 'developers.google.com', tier: 'official_docs' },
  { match: 'support.google.com', tier: 'official_support' },
  { match: 'success.outsystems.com', tier: 'official_docs' },
  { match: 'docs.anthropic.com', tier: 'official_docs' },
  { match: 'platform.claude.com', tier: 'official_docs' },
  { match: 'developer.mozilla.org', tier: 'reliable_technical' },
  { match: 'support.microsoft.com', tier: 'official_support' },
  { match: 'techcommunity.microsoft.com', tier: 'official_support' },
  { match: 'zoom.us', tier: 'official_docs' },
  { match: 'developers.zoom.us', tier: 'official_docs' },
  { match: 'stackoverflow.com', tier: 'reliable_technical' },
  { match: 'github.com', tier: 'reliable_technical' },
  { match: 'wikipedia.org', tier: 'reliable_technical' },
];

function loadRules(): TierRule[] {
  const extra = process.env.THIRDSEAT_SOURCE_RULES;
  if (!extra) return DEFAULT_RULES;
  try {
    return [...(JSON.parse(extra) as TierRule[]), ...DEFAULT_RULES];
  } catch {
    return DEFAULT_RULES;
  }
}

const RULES = loadRules();

export function tierForUrl(url: string | undefined, fallback: SourceTier = 'general_web'): SourceTier {
  if (!url) return fallback;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return fallback;
  }
  const hostPath = u.hostname + u.pathname;
  for (const r of RULES) {
    if (r.match.includes('/')) {
      if (hostPath.startsWith(r.match)) return r.tier;
    } else if (u.hostname === r.match || u.hostname.endsWith('.' + r.match)) {
      return r.tier;
    }
  }
  return fallback;
}

export function isAuthoritative(t: SourceTier): boolean {
  return t === 'official_docs' || t === 'official_support' || t === 'conversation';
}

/**
 * Caps a proposed confidence by the quality of evidence actually held.
 * Confidence describes sourcing quality; it never exceeds what the evidence supports.
 */
export function capConfidence(proposed: Confidence, evidence: Evidence[]): Confidence {
  if (evidence.length === 0) return 'UNVERIFIED';
  const best = evidence.some((e) => isAuthoritative(e.sourceTier));
  if (proposed === 'HIGH' && !best) return 'LIKELY';
  return proposed;
}
