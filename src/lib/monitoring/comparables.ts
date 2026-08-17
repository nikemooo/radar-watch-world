/**
 * Generic comparable / baseline engine — pure, deterministic, category-agnostic.
 *
 * Hard rules encoded here:
 *  - A baseline is only ever produced from REAL persisted observations.
 *  - Below the minimum sample size the result is `insufficient` and no
 *    market claim ("cheap", "below market", ...) may be made anywhere.
 *  - All statistics are computed numerically. The AI may only *explain* a
 *    baseline that was calculated here, never invent one.
 *  - Nothing in this file knows about cars, watches or apartments: the
 *    comparability rules are derived from the radar's attribute schema.
 */
import type { AttributeSpec, AttributeValue } from "./normalize";

export const DEFAULT_MIN_COMPARABLES = 10;

/** One persisted observation that may serve as a comparable. */
export interface Observation {
  fingerprint: string;
  title: string;
  url: string | null;
  /** Normalized attributes keyed by attribute spec key. */
  attributes: Record<string, AttributeValue>;
  /** Fallback numeric value + currency when no attribute carries the price. */
  numericValue: number | null;
  currency: string | null;
  /** When the observation was last confirmed to exist. */
  observedAt: string | null;
  /** True when the value came from an item-level (detail) page. */
  detailFetched: boolean;
}

export interface ComparableSettings {
  /** Minimum reliable comparables before any baseline is produced. */
  minComparables: number;
  /** Observations older than this are never used. */
  maxObservationAgeDays: number;
  /** Weight halves every N days. */
  halfLifeDays: number;
  /** Minimum similarity (0-1) for an observation to count as comparable. */
  minSimilarity: number;
  /** When true, items may be compared on category alone (opt-in, off by default). */
  allowBroadComparison: boolean;
}

export function comparableSettings(
  overrides: Partial<ComparableSettings> | null | undefined,
  recencyDays: number,
): ComparableSettings {
  const base: ComparableSettings = {
    minComparables: DEFAULT_MIN_COMPARABLES,
    // Comparable freshness follows the radar's own monitoring window, with a
    // floor so slow-moving markets still gather a sample.
    maxObservationAgeDays: Math.max(90, Math.min(recencyDays * 4, 720)),
    halfLifeDays: Math.max(30, Math.min(recencyDays * 2, 180)),
    minSimilarity: 0.6,
    allowBroadComparison: false,
  };
  return { ...base, ...(overrides ?? {}) };
}

/** Which attribute carries the value being benchmarked (usually price). */
export function valueAttributeKey(specs: AttributeSpec[]): string | null {
  const money = specs.find((s) => s.kind === "money");
  return money?.key ?? null;
}

/** Attributes that DEFINE comparability, i.e. everything but the value itself. */
export function comparabilityKeys(specs: AttributeSpec[], valueKey: string | null): AttributeSpec[] {
  return specs.filter(
    (s) => s.key !== valueKey && s.kind !== "url" && s.kind !== "date" && s.key !== "title",
  );
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Per-attribute agreement in [0,1], or null when either side is unknown. */
function attributeAgreement(spec: AttributeSpec, a: AttributeValue, b: AttributeValue): number | null {
  if (!a?.raw || !b?.raw) return null;
  switch (spec.kind) {
    case "year": {
      if (a.value === null || b.value === null) return null;
      const d = Math.abs(a.value - b.value);
      return d === 0 ? 1 : d <= 1 ? 0.8 : d <= 2 ? 0.5 : 0;
    }
    case "number":
    case "distance":
    case "area": {
      if (a.value === null || b.value === null) return null;
      const bigger = Math.max(Math.abs(a.value), Math.abs(b.value), 1);
      const rel = Math.abs(a.value - b.value) / bigger;
      return rel <= 0.1 ? 1 : rel <= 0.25 ? 0.75 : rel <= 0.5 ? 0.4 : 0;
    }
    default: {
      const x = norm(a.raw);
      const y = norm(b.raw);
      if (!x || !y) return null;
      if (x === y) return 1;
      if (x.includes(y) || y.includes(x)) return 0.8;
      const xs = new Set(x.split(" "));
      const ys = y.split(" ");
      const overlap = ys.filter((t) => xs.has(t)).length;
      const union = new Set([...xs, ...ys]).size;
      return union === 0 ? null : overlap / union;
    }
  }
}

export interface Similarity {
  score: number;
  /** Attribute keys that were actually compared (both sides known). */
  matchedOn: string[];
  /** Attribute keys that could not be compared for lack of data. */
  unknown: string[];
}

/** Similarity of two observations across the radar's comparability attributes. */
export function similarity(
  subject: Observation,
  candidate: Observation,
  keys: AttributeSpec[],
): Similarity {
  const matchedOn: string[] = [];
  const unknown: string[] = [];
  let total = 0;
  let counted = 0;
  for (const spec of keys) {
    const a = subject.attributes[spec.key];
    const b = candidate.attributes[spec.key];
    const agreement = a && b ? attributeAgreement(spec, a, b) : null;
    if (agreement === null) {
      unknown.push(spec.key);
      continue;
    }
    matchedOn.push(spec.key);
    total += agreement;
    counted += 1;
  }
  // No shared, known discriminator = not comparable. Sharing a category is
  // explicitly NOT enough (rule 8).
  if (counted === 0) return { score: 0, matchedOn, unknown };
  return { score: total / counted, matchedOn, unknown };
}

/** Normalized value + currency of the benchmarked attribute for an observation. */
export function observedValue(
  obs: Observation,
  valueKey: string | null,
): { value: number; currency: string | null; stated: boolean } | null {
  const attr = valueKey ? obs.attributes[valueKey] : undefined;
  if (attr && attr.value !== null && attr.raw) {
    return {
      value: attr.value,
      currency: attr.currency,
      stated: attr.confidence === "stated" || attr.confidence === "structured",
    };
  }
  if (obs.numericValue !== null) {
    return { value: obs.numericValue, currency: obs.currency, stated: obs.detailFetched };
  }
  return null;
}

// ------------------------------ statistics ------------------------------

/** Weighted percentile (p in 0-100) over value/weight pairs. Linear interpolation. */
export function weightedPercentile(points: { value: number; weight: number }[], p: number): number {
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return NaN;
  const target = (p / 100) * total;
  let cumulative = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const point = sorted[i]!;
    const next = cumulative + point.weight;
    if (next >= target) {
      const prev = sorted[i - 1];
      if (!prev || point.weight === 0) return point.value;
      const within = (target - cumulative) / point.weight;
      return prev.value + (point.value - prev.value) * Math.min(1, Math.max(0, within));
    }
    cumulative = next;
  }
  return sorted[sorted.length - 1]!.value;
}

/** Position of a value inside the sample, 0-100. Deterministic, weight-aware. */
export function percentileOf(points: { value: number; weight: number }[], value: number): number {
  const total = points.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return NaN;
  const below = points.reduce((s, x) => s + (x.value < value ? x.weight : x.value === value ? x.weight / 2 : 0), 0);
  return (below / total) * 100;
}

export interface BaselineStats {
  count: number;
  median: number;
  mean: number;
  min: number;
  max: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  /** Only reported when the sample is large enough to be meaningful. */
  stddev: number | null;
}

export function baselineStats(points: { value: number; weight: number }[]): BaselineStats {
  const values = points.map((p) => p.value);
  const totalWeight = points.reduce((s, p) => s + p.weight, 0);
  const mean = points.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;
  const variance =
    points.length >= 8
      ? points.reduce((s, p) => s + p.weight * (p.value - mean) ** 2, 0) / totalWeight
      : null;
  return {
    count: points.length,
    median: weightedPercentile(points, 50),
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    p10: weightedPercentile(points, 10),
    p25: weightedPercentile(points, 25),
    p75: weightedPercentile(points, 75),
    p90: weightedPercentile(points, 90),
    stddev: variance === null ? null : Math.sqrt(variance),
  };
}

// ------------------------------ baseline ------------------------------

export type BaselineStatus = "computed" | "insufficient_comparables" | "no_value" | "not_applicable";

export interface ComparableUsed {
  fingerprint: string;
  title: string;
  url: string | null;
  value: number;
  similarity: number;
  weight: number;
  observedAt: string | null;
}

export interface BaselineResult {
  status: BaselineStatus;
  /** Human-readable, safe to show verbatim. Never claims a market position
   *  unless status === "computed". */
  statement: string;
  currency: string | null;
  value: number | null;
  stats: BaselineStats | null;
  /** Absolute difference from the comparable median (negative = below). */
  difference: number | null;
  /** Percentage difference from the median. */
  differencePct: number | null;
  /** Position within the comparable sample, 0-100. */
  percentile: number | null;
  /** 0-1, explicitly a *baseline confidence*, not statistical certainty. */
  confidence: number;
  confidenceLabel: "low" | "moderate" | "high";
  confidenceFactors: {
    sample: number;
    completeness: number;
    similarity: number;
    sourceQuality: number;
    recency: number;
  };
  /** Deterministic 0-1 measure of how far from typical the value sits. */
  anomalyScore: number | null;
  /** Deterministic 0-1 measure of attractiveness (low value = opportunity). */
  opportunityScore: number | null;
  comparedOn: string[];
  limitations: string[];
  sample: ComparableUsed[];
  minComparables: number;
}

function insufficient(
  reason: string,
  status: BaselineStatus,
  minComparables: number,
  comparedOn: string[] = [],
  limitations: string[] = [],
): BaselineResult {
  return {
    status,
    statement: reason,
    currency: null,
    value: null,
    stats: null,
    difference: null,
    differencePct: null,
    percentile: null,
    confidence: 0,
    confidenceLabel: "low",
    confidenceFactors: { sample: 0, completeness: 0, similarity: 0, sourceQuality: 0, recency: 0 },
    anomalyScore: null,
    opportunityScore: null,
    comparedOn,
    limitations,
    sample: [],
    minComparables,
  };
}

const INSUFFICIENT_STATEMENT =
  "Insufficient comparable data — there are not enough comparable observations to determine whether this is above or below market value.";

function ageDays(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now - t) / 86_400_000);
}

/**
 * Build a baseline for `subject` from `population`.
 * Returns a `computed` result only when the sample clears the minimum size.
 */
export function buildBaseline(opts: {
  subject: Observation;
  population: Observation[];
  specs: AttributeSpec[];
  settings: ComparableSettings;
  now?: number;
}): BaselineResult {
  const { subject, population, specs, settings } = opts;
  const now = opts.now ?? Date.now();
  const min = Math.max(2, settings.minComparables);
  const valueKey = valueAttributeKey(specs);
  const keys = comparabilityKeys(specs, valueKey);

  if (keys.length === 0 && !settings.allowBroadComparison) {
    return insufficient(
      "No comparability attributes are defined for this radar, so no market baseline can be calculated.",
      "not_applicable",
      min,
    );
  }

  const subjectValue = observedValue(subject, valueKey);
  if (!subjectValue) {
    return insufficient(
      "This item has no reliable normalized value, so it cannot be compared with anything.",
      "no_value",
      min,
    );
  }

  const limitations: string[] = [];
  const comparedOnCounts = new Map<string, number>();
  const points: { value: number; weight: number }[] = [];
  const sample: ComparableUsed[] = [];
  let similaritySum = 0;
  let completenessSum = 0;
  let statedCount = 0;
  let recencySum = 0;
  let skippedCurrency = 0;
  let skippedSimilarity = 0;
  let skippedStale = 0;

  for (const candidate of population) {
    if (candidate.fingerprint === subject.fingerprint) continue;
    const candidateValue = observedValue(candidate, valueKey);
    if (!candidateValue) continue;
    // Currencies are never silently converted.
    if ((candidateValue.currency ?? null) !== (subjectValue.currency ?? null)) {
      skippedCurrency += 1;
      continue;
    }
    const age = ageDays(candidate.observedAt, now);
    if (age !== null && age > settings.maxObservationAgeDays) {
      skippedStale += 1;
      continue;
    }
    const sim = similarity(subject, candidate, keys);
    if (sim.score < settings.minSimilarity || sim.matchedOn.length === 0) {
      skippedSimilarity += 1;
      continue;
    }
    // Time weighting: recent observations dominate, old ones decay away.
    const decay = age === null ? 0.5 : Math.pow(0.5, age / settings.halfLifeDays);
    const weight = Math.max(0.01, sim.score * decay);
    points.push({ value: candidateValue.value, weight });
    sample.push({
      fingerprint: candidate.fingerprint,
      title: candidate.title,
      url: candidate.url,
      value: candidateValue.value,
      similarity: Number(sim.score.toFixed(3)),
      weight: Number(weight.toFixed(3)),
      observedAt: candidate.observedAt,
    });
    similaritySum += sim.score;
    completenessSum += sim.matchedOn.length / Math.max(1, keys.length);
    recencySum += decay;
    if (candidateValue.stated) statedCount += 1;
    for (const k of sim.matchedOn) comparedOnCounts.set(k, (comparedOnCounts.get(k) ?? 0) + 1);
  }

  const comparedOn = [...comparedOnCounts.entries()]
    .filter(([, n]) => n >= Math.max(2, Math.floor(points.length / 2)))
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);

  if (points.length < min) {
    const detail = [
      `${points.length} comparable observation${points.length === 1 ? "" : "s"} found, ${min} required`,
      skippedCurrency ? `${skippedCurrency} skipped for a different currency` : "",
      skippedSimilarity ? `${skippedSimilarity} skipped as not comparable enough` : "",
      skippedStale ? `${skippedStale} skipped as too old` : "",
    ]
      .filter(Boolean)
      .join("; ");
    const result = insufficient(INSUFFICIENT_STATEMENT, "insufficient_comparables", min, comparedOn, [detail]);
    result.currency = subjectValue.currency;
    result.value = subjectValue.value;
    return result;
  }

  const stats = baselineStats(points);
  const difference = subjectValue.value - stats.median;
  const differencePct = stats.median === 0 ? null : (difference / stats.median) * 100;
  const percentile = percentileOf(points, subjectValue.value);

  const factors = {
    sample: Math.min(1, points.length / (min * 3)),
    completeness: completenessSum / points.length,
    similarity: similaritySum / points.length,
    sourceQuality: statedCount / points.length,
    recency: recencySum / points.length,
  };
  const confidence = Number(
    (
      factors.sample * 0.3 +
      factors.completeness * 0.2 +
      factors.similarity * 0.2 +
      factors.sourceQuality * 0.15 +
      factors.recency * 0.15
    ).toFixed(3),
  );
  const confidenceLabel = confidence >= 0.7 ? "high" : confidence >= 0.45 ? "moderate" : "low";

  // Deterministic signals — no model opinion involved.
  const anomalyScore = Number((Math.min(1, Math.abs(percentile - 50) / 50)).toFixed(3));
  const opportunityScore = Number(
    (Math.max(0, (50 - percentile) / 50) * (0.5 + 0.5 * confidence)).toFixed(3),
  );

  if (factors.sourceQuality < 0.5) {
    limitations.push("Fewer than half of the comparables come from item-level pages with a stated value.");
  }
  if (factors.completeness < 0.5) {
    limitations.push("Comparables share only part of the attributes that define comparability.");
  }
  if (skippedCurrency > 0) {
    limitations.push(`${skippedCurrency} observation(s) in another currency were excluded — no conversion is applied.`);
  }
  if (stats.stddev === null) {
    limitations.push("Sample too small for a meaningful standard deviation.");
  }

  const money = (n: number) =>
    `${Math.round(n).toLocaleString("en-US")}${subjectValue.currency ? ` ${subjectValue.currency}` : ""}`;
  const direction = difference < 0 ? "below" : difference > 0 ? "above" : "at";
  const statement =
    `Compared with ${points.length} comparable observation${points.length === 1 ? "" : "s"}` +
    `${comparedOn.length ? ` matching on ${comparedOn.join(", ")}` : ""}: ` +
    `median ${money(stats.median)}, this item ${money(subjectValue.value)} — ` +
    `${difference === 0 ? "at the median" : `${money(Math.abs(difference))} (${differencePct === null ? "n/a" : `${differencePct > 0 ? "+" : "-"}${Math.abs(differencePct).toFixed(1)}%`}) ${direction} the median`}, ` +
    `${Math.round(percentile)}th percentile. Baseline confidence: ${confidenceLabel}.`;

  return {
    status: "computed",
    statement,
    currency: subjectValue.currency,
    value: subjectValue.value,
    stats,
    difference,
    differencePct,
    percentile,
    confidence,
    confidenceLabel,
    confidenceFactors: {
      sample: Number(factors.sample.toFixed(3)),
      completeness: Number(factors.completeness.toFixed(3)),
      similarity: Number(factors.similarity.toFixed(3)),
      sourceQuality: Number(factors.sourceQuality.toFixed(3)),
      recency: Number(factors.recency.toFixed(3)),
    },
    anomalyScore,
    opportunityScore,
    comparedOn,
    limitations,
    // Keep the audit trail bounded but representative.
    sample: sample.sort((a, b) => b.weight - a.weight).slice(0, 40),
    minComparables: min,
  };
}

/** Safe phrasing for anything shown to the user when no baseline exists. */
export const NO_BASELINE_PHRASE =
  "Potentially interesting, but there is insufficient comparable data to determine whether it is under market value.";
