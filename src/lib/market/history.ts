/**
 * Market history math — pure functions, no I/O, fully testable.
 *
 * Observations arrive one per sweep; from that series we derive the numbers
 * the UI and the rule engine need: current vs previous, absolute/percentage
 * change, and windowed changes (24h / 7d / 30d) against the observation that
 * was current at the start of each window.
 */

export interface MarketPoint {
  /** ISO timestamp of when the value was observed. */
  t: string;
  v: number;
}

export interface WindowChange {
  from: number;
  fromAt: string;
  abs: number;
  pct: number | null;
}

export interface MarketChanges {
  current: number;
  currentAt: string;
  previous: number | null;
  previousAt: string | null;
  /** current − previous */
  abs: number | null;
  /** (current − previous) / previous × 100 */
  pct: number | null;
  windows: Record<"24h" | "7d" | "30d", WindowChange | null>;
}

export const WINDOW_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const;

function pctOf(current: number, from: number): number | null {
  if (from === 0) return null;
  return ((current - from) / from) * 100;
}

/** The value that was current at `now − windowMs`: the latest point at or before the cutoff. */
export function changeOverWindow(
  pointsAsc: MarketPoint[],
  windowMs: number,
  now: number = Date.now(),
): WindowChange | null {
  if (pointsAsc.length < 2) return null;
  const cutoff = now - windowMs;
  let reference: MarketPoint | null = null;
  for (const p of pointsAsc) {
    const t = Date.parse(p.t);
    if (!Number.isFinite(t)) continue;
    if (t <= cutoff) reference = p;
    else break;
  }
  // Not enough history to say anything about this window.
  if (!reference) return null;
  const current = pointsAsc[pointsAsc.length - 1]!;
  return {
    from: reference.v,
    fromAt: reference.t,
    abs: current.v - reference.v,
    pct: pctOf(current.v, reference.v),
  };
}

/**
 * Derive change facts from an ascending series. Points with unparseable
 * timestamps or non-finite values are ignored; the input is not mutated.
 */
export function computeMarketChanges(
  points: MarketPoint[],
  now: number = Date.now(),
): MarketChanges | null {
  const clean = points
    .filter((p) => Number.isFinite(p.v) && Number.isFinite(Date.parse(p.t)))
    .slice()
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const last = clean[clean.length - 1];
  if (!last) return null;
  const previous = clean.length > 1 ? clean[clean.length - 2]! : null;
  return {
    current: last.v,
    currentAt: last.t,
    previous: previous?.v ?? null,
    previousAt: previous?.t ?? null,
    abs: previous ? last.v - previous.v : null,
    pct: previous ? pctOf(last.v, previous.v) : null,
    windows: {
      "24h": changeOverWindow(clean, WINDOW_MS["24h"], now),
      "7d": changeOverWindow(clean, WINDOW_MS["7d"], now),
      "30d": changeOverWindow(clean, WINDOW_MS["30d"], now),
    },
  };
}

export type Freshness =
  | { state: "fresh"; ageMs: number }
  /** Exchange-traded instrument: the value is the last trade, market has not traded since. */
  | { state: "last_close"; ageMs: number }
  /** Continuously traded instrument (crypto/forex/commodity) whose source timestamp is old. */
  | { state: "stale"; ageMs: number };

/** How old a source timestamp may be before the UI must stop presenting it as current. */
export const FRESHNESS_LIMIT_MS: Record<string, number> = {
  crypto: 2 * 60 * 60 * 1000,
  forex: 6 * 60 * 60 * 1000,
  commodity: 6 * 60 * 60 * 1000,
  stock: 3 * 60 * 60 * 1000,
  index: 3 * 60 * 60 * 1000,
  other: 24 * 60 * 60 * 1000,
};

/**
 * Classify a datapoint by the gap between when the SOURCE says it was
 * observed and when we retrieved it. A gap larger than the instrument's
 * limit means the number is not "current": for exchange-traded instruments
 * it is the last close (weekend / holiday / pre-market), for 24/7 markets it
 * is simply stale data.
 */
export function priceFreshness(
  kind: string,
  observedAt: string,
  retrievedAt: string | null | undefined,
  now: number = Date.now(),
): Freshness {
  const observed = Date.parse(observedAt);
  const retrieved = retrievedAt ? Date.parse(retrievedAt) : NaN;
  const reference = Number.isFinite(retrieved) ? retrieved : now;
  const ageMs = Math.max(0, reference - (Number.isFinite(observed) ? observed : reference));
  const limit = FRESHNESS_LIMIT_MS[kind] ?? FRESHNESS_LIMIT_MS["other"]!;
  if (ageMs <= limit) return { state: "fresh", ageMs };
  return { state: kind === "stock" || kind === "index" ? "last_close" : "stale", ageMs };
}

/** Pick the row that is genuinely latest: newest source timestamp, then newest retrieval. */
export function latestObservation<T extends { observed_at: string; retrieved_at?: string | null }>(
  rows: T[],
): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!best) {
      best = row;
      continue;
    }
    const dt = Date.parse(row.observed_at) - Date.parse(best.observed_at);
    const dr = Date.parse(row.retrieved_at ?? "") - Date.parse(best.retrieved_at ?? "");
    if (dt > 0 || (dt === 0 && (Number.isNaN(dr) ? true : dr >= 0))) best = row;
  }
  return best;
}
