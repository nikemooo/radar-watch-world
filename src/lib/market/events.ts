/**
 * World-event model for Market Impact monitoring — pure functions, no I/O.
 *
 * The event layer answers a different question from the numeric layer: not
 * "what is the value?" but "what happened in the world that could move it?".
 * Everything here is category-agnostic: it knows about documents, titles,
 * timestamps and a value series — never about gold, oil or a specific ticker.
 *
 * Two hard product rules are encoded here:
 *   1. FACT and INTERPRETATION are separate fields, never merged into prose.
 *   2. Duplicate coverage of the same happening is ONE event with many
 *      sources — clustering is done on the wire, before anything is stored.
 */

export type EventSeverity = "low" | "medium" | "high" | "critical";

export const SEVERITIES: EventSeverity[] = ["low", "medium", "high", "critical"];

export function asSeverity(value: unknown): EventSeverity {
  return typeof value === "string" && (SEVERITIES as string[]).includes(value)
    ? (value as EventSeverity)
    : "low";
}

export function severityRank(severity: EventSeverity): number {
  return SEVERITIES.indexOf(severity);
}

export interface EventSource {
  title: string;
  url: string;
  publisher: string | null;
  published_at: string | null;
}

/** A deduplicated happening: one real-world event, N reporting sources. */
export interface EventCluster {
  /** Stable id derived from the event's own wording — the dedup key. */
  key: string;
  title: string;
  /** Longest snippet across the cluster, used as extraction input. */
  text: string;
  sources: EventSource[];
  /** Earliest credible publication time across the cluster. */
  published_at: string | null;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "as", "at", "by", "with", "from",
  "after", "over", "amid", "says", "said", "new", "is", "are", "was", "were", "its", "it",
  "that", "this", "will", "has", "have", "be", "but", "up", "down",
  "och", "att", "som", "för", "med", "till", "från", "efter", "om", "det", "den", "en", "ett",
  "är", "var", "har", "kan", "på", "av", "inte",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s%]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Jaccard overlap of the significant words in two titles. */
export function titleSimilarity(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / (A.size + B.size - shared);
}

/** Deterministic, collision-resistant-enough key from the cluster's own words. */
export function clusterKey(title: string, publishedAt: string | null): string {
  const words = [...new Set(tokenize(title))].sort().slice(0, 8).join("-");
  const day = publishedAt ? publishedAt.slice(0, 10) : "undated";
  let hash = 2166136261;
  for (let i = 0; i < words.length; i++) {
    hash ^= words.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${day}:${(hash >>> 0).toString(36)}`;
}

export interface ClusterInput {
  title: string;
  url: string;
  snippet: string;
  publisher?: string | null | undefined;
  published_at?: string | null | undefined;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Group documents that report the SAME happening. Similarity is title-based
 * and language-agnostic; a same-day requirement keeps recurring headlines
 * ("Fed holds rates") from collapsing across months.
 */
export function clusterDocuments(docs: ClusterInput[], threshold = 0.45): EventCluster[] {
  const clusters: EventCluster[] = [];
  const seenUrls = new Set<string>();

  for (const doc of docs) {
    if (!doc.url || seenUrls.has(doc.url)) continue;
    seenUrls.add(doc.url);
    const title = (doc.title || "").trim();
    if (!title) continue;
    const published = isoOrNull(doc.published_at);
    const source: EventSource = {
      title,
      url: doc.url,
      publisher: doc.publisher ?? hostOf(doc.url),
      published_at: published,
    };

    const match = clusters.find((c) => {
      if (titleSimilarity(c.title, title) < threshold) return false;
      if (c.published_at && published) {
        const days = Math.abs(Date.parse(c.published_at) - Date.parse(published)) / 864e5;
        if (days > 3) return false;
      }
      return true;
    });

    if (match) {
      if (!match.sources.some((s) => s.url === doc.url)) match.sources.push(source);
      if ((doc.snippet ?? "").length > match.text.length) match.text = doc.snippet ?? "";
      if (published && (!match.published_at || published < match.published_at)) {
        match.published_at = published;
      }
      continue;
    }

    clusters.push({
      key: clusterKey(title, published),
      title,
      text: doc.snippet ?? "",
      sources: [source],
      published_at: published,
    });
  }

  // The key must reflect the final earliest date after merging.
  return clusters.map((c) => ({ ...c, key: clusterKey(c.title, c.published_at) }));
}

export interface CorrelationPoint {
  t: string;
  v: number;
}

export interface EventCorrelation {
  /** Value observed most recently BEFORE the event. */
  before: number | null;
  beforeAt: string | null;
  /** First value observed AFTER the event. */
  after: number | null;
  afterAt: string | null;
  changePct: number | null;
  /** Hours between the two observations — context for how tight the link is. */
  hoursBetween: number | null;
  /** True only when both sides exist; otherwise the UI must say "no data yet". */
  observed: boolean;
}

const EMPTY_CORRELATION: EventCorrelation = {
  before: null,
  beforeAt: null,
  after: null,
  afterAt: null,
  changePct: null,
  hoursBetween: null,
  observed: false,
};

/**
 * Line an event up against the value series: the last observation before it
 * and the first one after it. This is an OBSERVED coincidence in time, never
 * a causal claim — the UI labels it as such.
 */
export function correlateEvent(
  publishedAt: string | null,
  points: CorrelationPoint[],
): EventCorrelation {
  if (!publishedAt) return EMPTY_CORRELATION;
  const at = Date.parse(publishedAt);
  if (!Number.isFinite(at)) return EMPTY_CORRELATION;
  const clean = points
    .filter((p) => Number.isFinite(p.v) && Number.isFinite(Date.parse(p.t)))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

  let before: CorrelationPoint | null = null;
  let after: CorrelationPoint | null = null;
  for (const p of clean) {
    if (Date.parse(p.t) <= at) before = p;
    else {
      after = p;
      break;
    }
  }
  if (!before || !after) {
    return {
      ...EMPTY_CORRELATION,
      before: before?.v ?? null,
      beforeAt: before?.t ?? null,
      after: after?.v ?? null,
      afterAt: after?.t ?? null,
    };
  }
  const changePct = before.v === 0 ? null : ((after.v - before.v) / before.v) * 100;
  return {
    before: before.v,
    beforeAt: before.t,
    after: after.v,
    afterAt: after.t,
    changePct,
    hoursBetween: (Date.parse(after.t) - Date.parse(before.t)) / 36e5,
    observed: true,
  };
}

/**
 * Alert policy for events. Only genuinely significant AND relevant events
 * reach the user; everything else stays on the timeline.
 */
export function shouldAlertOnEvent(input: {
  severity: EventSeverity;
  relevance: number;
  isBaseline: boolean;
}): boolean {
  if (input.isBaseline) return false;
  if (input.relevance < 0.5) return false;
  return severityRank(input.severity) >= severityRank("high");
}

export function eventImportance(severity: EventSeverity): "critical" | "important" | "interesting" | "minor" {
  switch (severity) {
    case "critical":
      return "critical";
    case "high":
      return "important";
    case "medium":
      return "interesting";
    default:
      return "minor";
  }
}
