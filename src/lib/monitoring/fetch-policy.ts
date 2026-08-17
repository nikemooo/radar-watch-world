/**
 * Adaptive detail-fetch policy.
 *
 * Pure, category-agnostic decision layer that answers two questions before any
 * network call is made:
 *   1. HOW MANY detail pages may this sweep read (budget), bounded by a hard
 *      per-sweep cost ceiling.
 *   2. WHICH candidates are worth those reads.
 *
 * It never changes what counts as a valid comparable, never invents data and
 * never lowers a quality threshold — it only spends a bounded budget where it
 * is most likely to produce genuine, stated, item-level facts.
 */
import type { CandidateItem } from "./candidates.server";

export interface HostStat {
  host: string;
  attempts: number;
  successes: number;
}

export interface UrlState {
  url: string;
  consecutiveFailures: number;
  /** ISO timestamp before which this URL must not be retried. */
  nextAttemptAt: string | null;
}

/** What we already know about an item we have persisted before. */
export interface KnownItem {
  url: string;
  detailStatus: string;
  detailFetchedAt: string | null;
  /** True when the persisted item already carries a usable comparable value. */
  hasComparableValue: boolean;
  /** True when the item is missing attributes the radar considers critical. */
  missingCritical: boolean;
}

export interface BudgetInput {
  /** Radar's configured baseline budget (`max_detail_fetches`). */
  configured: number;
  /** Radar cadence — a faster radar earns a slightly larger budget. */
  frequency: string;
  /** How many usable comparable observations are still missing (0 = enough). */
  comparableGap: number;
  /** Candidates that are actually fetchable this sweep. */
  fetchableCandidates: number;
  /** Cost already committed this sweep (search stage). */
  spentCost: number;
  /** Hard per-sweep cost ceiling for this radar. */
  costCeiling: number;
  /** Estimated cost of one detail fetch. */
  perFetchCost: number;
}

export interface BudgetResult {
  budget: number;
  /** Human-readable reason, surfaced in telemetry. */
  reason: string;
  affordable: number;
}

export const HARD_MAX_DETAIL_FETCHES = 25;

const CADENCE_BONUS: Record<string, number> = {
  instant: 4,
  smart: 2,
  daily: 2,
  weekly: 0,
};

/**
 * Adaptive budget: the configured value is a floor, coverage need raises it,
 * and the cost ceiling always wins.
 */
export function adaptiveBudget(input: BudgetInput): BudgetResult {
  const base = Math.max(0, Math.min(input.configured || 8, HARD_MAX_DETAIL_FETCHES));
  const cadence = CADENCE_BONUS[input.frequency] ?? 2;
  // Each missing comparable may justify up to two fetches (not every page yields one).
  const coverageNeed = input.comparableGap > 0 ? Math.min(input.comparableGap * 2, 12) : 0;
  const want = Math.min(base + cadence + coverageNeed, HARD_MAX_DETAIL_FETCHES);

  const headroom = Math.max(0, input.costCeiling - input.spentCost);
  const affordable = input.perFetchCost > 0 ? Math.floor(headroom / input.perFetchCost) : want;
  const budget = Math.max(0, Math.min(want, input.fetchableCandidates, affordable, HARD_MAX_DETAIL_FETCHES));

  let reason: string;
  if (budget === 0) {
    reason = affordable === 0 ? "cost ceiling reached — no detail fetches" : "no fetchable candidates";
  } else if (affordable < want && affordable <= input.fetchableCandidates) {
    reason = `capped by the per-sweep cost ceiling (${input.costCeiling})`;
  } else if (input.fetchableCandidates < want) {
    reason = "limited by the number of fetchable candidates";
  } else if (coverageNeed > 0) {
    reason = `raised by ${coverageNeed} to close a comparable-coverage gap of ${input.comparableGap}`;
  } else {
    reason = "comparable coverage sufficient — standard budget";
  }
  return { budget, reason, affordable };
}

export interface PriorityInput {
  candidates: CandidateItem[];
  hostStats: Map<string, HostStat>;
  urlStates: Map<string, UrlState>;
  known: Map<string, KnownItem>;
  /** True when this radar computes comparable baselines and still needs data. */
  needsComparables: boolean;
  budget: number;
  now?: number;
}

export interface ScoredCandidate {
  candidate: CandidateItem;
  score: number;
  reasons: string[];
}

export interface PriorityResult {
  selected: CandidateItem[];
  scored: ScoredCandidate[];
  skippedBackoff: number;
}

/** Laplace-smoothed success rate so a single failure does not blacklist a host. */
export function hostSuccessRate(stat: HostStat | undefined): number {
  if (!stat || stat.attempts === 0) return 0.6; // neutral prior for unseen hosts
  return (stat.successes + 1) / (stat.attempts + 2);
}

const DAY_MS = 86_400_000;

/**
 * Rank candidates by expected value of the fetch, then take the budget.
 * Never simply the first N results.
 */
export function prioritizeCandidates(input: PriorityInput): PriorityResult {
  const now = input.now ?? Date.now();
  const scored: ScoredCandidate[] = [];
  let skippedBackoff = 0;

  for (const c of input.candidates) {
    if (!c.url || !c.individual) continue;
    let host = "";
    try {
      host = new URL(c.url).host.replace(/^www\./, "");
    } catch {
      continue;
    }

    // 5. Repeated permanent failures are not retried until the backoff expires.
    const state = input.urlStates.get(c.url);
    if (state?.nextAttemptAt && Date.parse(state.nextAttemptAt) > now) {
      skippedBackoff += 1;
      continue;
    }

    const reasons: string[] = [];
    let score = c.relevance * 2 + c.likelihood;
    if (c.url !== c.discovery_url) score += 0.5;
    if (c.clue) score += 0.25;

    // Source-specific performance learning (never source-specific extraction).
    const rate = hostSuccessRate(input.hostStats.get(host));
    score += (rate - 0.6) * 2;
    if (rate < 0.4) reasons.push(`${host} has a low detail-fetch success rate`);

    const known = input.known.get(c.url);
    if (known) {
      if (known.detailStatus === "fetched" && !known.missingCritical) {
        // Already have stated facts for this item — re-reading adds little.
        const age = known.detailFetchedAt ? now - Date.parse(known.detailFetchedAt) : Infinity;
        score -= age < 7 * DAY_MS ? 1.5 : 0.5;
        reasons.push("already has item-level facts");
      } else if (known.missingCritical || known.detailStatus !== "fetched") {
        score += 0.75;
        reasons.push("missing critical attributes");
      }
      // Coverage objective: an item that could add a usable comparable ranks up,
      // but only when it is relevant — never fetch noise to inflate a sample.
      if (input.needsComparables && !known.hasComparableValue && c.relevance >= 0.5) {
        score += 1;
        reasons.push("could add a comparable observation");
      }
    } else if (input.needsComparables && c.relevance >= 0.5) {
      score += 1;
      reasons.push("could add a comparable observation");
    }

    if (state && state.consecutiveFailures > 0) {
      score -= Math.min(state.consecutiveFailures * 0.5, 1.5);
      reasons.push(`${state.consecutiveFailures} previous failure(s)`);
    }

    scored.push({ candidate: c, score, reasons });
  }

  scored.sort((a, b) => b.score - a.score);

  const selected: CandidateItem[] = [];
  const seen = new Set<string>();
  const perHost = new Map<string, number>();
  const hostCap = Math.max(2, Math.ceil(input.budget / 2));
  for (const s of scored) {
    if (selected.length >= input.budget) break;
    const url = s.candidate.url!;
    if (seen.has(url)) continue;
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }
    const used = perHost.get(host) ?? 0;
    if (used >= hostCap) continue;
    perHost.set(host, used + 1);
    seen.add(url);
    selected.push(s.candidate);
  }

  return { selected, scored, skippedBackoff };
}

/** Exponential backoff for a URL that could not be read. */
export function backoffUntil(consecutiveFailures: number, reason: string, now = Date.now()): string {
  const permanent = /\b(403|404|410|451)\b/.test(reason);
  const baseHours = permanent ? 24 : 3;
  const hours = Math.min(baseHours * 2 ** Math.max(0, consecutiveFailures - 1), 24 * 30);
  return new Date(now + hours * 3_600_000).toISOString();
}
