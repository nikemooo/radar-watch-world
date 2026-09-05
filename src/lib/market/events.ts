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

import { classifyEvent, normalizeCategory, relatedCategories, type EventCategory } from "./taxonomy";

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
  /** Coarse event type, used for clustering and as a UI facet. */
  type: EventType;
  /** Distinctive tokens (names, numbers) shared by the cluster's reports. */
  entities: string[];
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
 * Event typing now lives in the V3 taxonomy (21 context-aware categories with
 * weighted evidence). These aliases keep the clustering code and every stored
 * `event_type` value working against one single vocabulary.
 */
export type EventType = EventCategory;

export function classifyEventType(text: string): EventType {
  return classifyEvent(text);
}


/**
 * Distinctive tokens: numbers, percentages and capitalised words. Two reports
 * of the same happening nearly always share these even when the headlines are
 * worded completely differently.
 */
export function strongTokens(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/[^\p{L}\p{N}%.,-]/gu, "");
    if (!word) continue;
    if (/\d/.test(word)) out.add(word.toLowerCase().replace(/[.,]$/, ""));
    else if (/^\p{Lu}[\p{L}-]{2,}$/u.test(word) && !STOPWORDS.has(word.toLowerCase())) {
      out.add(word.toLowerCase());
    }
  }
  return [...out];
}

function overlap(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / Math.min(A.size, B.size);
}

/**
 * Multi-signal similarity between two happenings: wording overlap, shared
 * entities/numbers and event type. Cross-source paraphrases score high; two
 * unrelated stories about the same asset do not.
 */
export function eventSimilarity(
  a: { title: string; entities?: string[]; type?: EventType },
  b: { title: string; entities?: string[]; type?: EventType },
): number {
  const words = titleSimilarity(a.title, b.title);
  const ents = overlap(a.entities ?? strongTokens(a.title), b.entities ?? strongTokens(b.title));
  const typeA = a.type ?? classifyEventType(a.title);
  const typeB = b.type ?? classifyEventType(b.title);
  const related = relatedCategories(normalizeCategory(typeA), normalizeCategory(typeB));
  const typeScore = typeA === typeB ? 1 : related ? 0.6 : 0;
  // Numeric anchor: two reports that name the SAME number about the SAME
  // subject are almost always the same happening, even when the headlines are
  // worded completely differently ("hits $77,000 wall" / "falls below $77,000").
  const numsA = new Set((a.entities ?? strongTokens(a.title)).filter((t) => /\d/.test(t)));
  const numsB = new Set((b.entities ?? strongTokens(b.title)).filter((t) => /\d/.test(t)));
  const wordsA = new Set((a.entities ?? strongTokens(a.title)).filter((t) => !/\d/.test(t)));
  const wordsB = new Set((b.entities ?? strongTokens(b.title)).filter((t) => !/\d/.test(t)));
  const sharedNumber = [...numsA].some((n) => numsB.has(n));
  const sharedSubject = [...wordsA].some((w) => wordsB.has(w));
  const anchor = sharedNumber && sharedSubject ? 1 : 0;

  const score = Math.min(1, words * 0.5 + ents * 0.35 + typeScore * 0.15 + anchor * 0.1);
  // Unrelated categories are a hard brake: never merge a rate decision into a
  // war — unless both reports name the same number about the same subject, in
  // which case they are one story the two classifiers merely labelled apart.
  const strongDuplicate = anchor === 1 && words >= 0.3;
  if (!related && !strongDuplicate && typeA !== "other" && typeB !== "other") {
    return Math.min(score, 0.35);
  }
  return score;
}

/**
 * Group documents that report the SAME happening. Similarity is multi-signal
 * and language-agnostic; a bounded time window keeps recurring headlines
 * ("Fed holds rates") from collapsing across months.
 */
export function clusterDocuments(docs: ClusterInput[], threshold = 0.4): EventCluster[] {
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
    const type = classifyEvent(title, doc.snippet ?? "");
    const entities = strongTokens(title);

    let best: { cluster: EventCluster; score: number } | null = null;
    for (const c of clusters) {
      if (c.published_at && published) {
        const days = Math.abs(Date.parse(c.published_at) - Date.parse(published)) / 864e5;
        if (days > 3) continue;
      }
      const score = eventSimilarity({ title, entities, type }, c);
      if (score >= threshold && (!best || score > best.score)) best = { cluster: c, score };
    }

    if (best) {
      const match = best.cluster;
      if (!match.sources.some((s) => s.url === doc.url)) match.sources.push(source);
      if ((doc.snippet ?? "").length > match.text.length) match.text = doc.snippet ?? "";
      match.entities = [...new Set([...match.entities, ...entities])].slice(0, 20);
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
      type,
      entities,
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

// ─────────────────────────────────────────────────────────────────────────────
// Market intelligence layer: source quality, importance, updates, alert policy
// ─────────────────────────────────────────────────────────────────────────────

/** How much weight a report deserves. Never category-specific. */
export type SourceTier = "primary" | "high" | "secondary" | "low";

const PRIMARY_PATTERNS = [
  /\.gov$/i, /\.gov\./i, /\.europa\.eu$/i, /\.riksbank\.se$/i, /federalreserve\.gov/i,
  /ecb\.europa\.eu/i, /imf\.org$/i, /worldbank\.org$/i, /opec\.org$/i, /bis\.org$/i,
  /sec\.gov/i, /eia\.gov/i, /scb\.se$/i, /eurostat/i, /oecd\.org$/i, /un\.org$/i,
];

const HIGH_PATTERNS = [
  /reuters\.com$/i, /bloomberg\.com$/i, /ft\.com$/i, /wsj\.com$/i, /apnews\.com$/i,
  /cnbc\.com$/i, /economist\.com$/i, /barrons\.com$/i, /nikkei\.com$/i, /bbc\.(co\.uk|com)$/i,
  /marketwatch\.com$/i, /di\.se$/i, /svd\.se$/i, /dn\.se$/i, /afp\.com$/i, /axios\.com$/i,
];

const LOW_PATTERNS = [
  /blogspot\./i, /wordpress\./i, /medium\.com$/i, /substack\.com$/i, /reddit\.com$/i,
  /x\.com$/i, /twitter\.com$/i, /facebook\.com$/i, /youtube\.com$/i, /tiktok\.com$/i,
  /coinspeaker|cryptopotato|newsbtc|ambcrypto|beincrypto|zerohedge/i,
];

export function sourceTier(urlOrHost: string): SourceTier {
  const host = hostOf(urlOrHost) ?? urlOrHost.toLowerCase();
  if (PRIMARY_PATTERNS.some((p) => p.test(host))) return "primary";
  if (HIGH_PATTERNS.some((p) => p.test(host))) return "high";
  if (LOW_PATTERNS.some((p) => p.test(host))) return "low";
  return "secondary";
}

const TIER_RANK: Record<SourceTier, number> = { low: 0, secondary: 1, high: 2, primary: 3 };

export function bestSourceTier(sources: { url: string }[]): SourceTier {
  let best: SourceTier = "low";
  for (const s of sources) {
    const tier = sourceTier(s.url);
    if (TIER_RANK[tier] > TIER_RANK[best]) best = tier;
  }
  return sources.length === 0 ? "low" : best;
}

/** Distinct publishers behind an event — the real corroboration signal. */
export function independentSourceCount(sources: { url: string }[]): number {
  const hosts = new Set<string>();
  for (const s of sources) {
    const host = hostOf(s.url);
    if (host) hosts.add(host);
  }
  return hosts.size;
}

/**
 * Confidence must be earned. A single low-tier blog can never produce a 95 %
 * fact confidence no matter how sure the model sounds.
 */
export function calibrateFactConfidence(input: {
  modelConfidence: number;
  tier: SourceTier;
  independentSources: number;
}): number {
  const tierCap: Record<SourceTier, number> = { primary: 0.95, high: 0.9, secondary: 0.8, low: 0.6 };
  const corroborationCap = input.independentSources >= 3 ? 1 : input.independentSources === 2 ? 0.85 : 0.7;
  const base = Math.max(0, Math.min(1, input.modelConfidence));
  return Math.round(Math.min(base, tierCap[input.tier], corroborationCap) * 100) / 100;
}

/** Interpretation is always less certain than the facts it rests on. */
export function calibrateInterpretationConfidence(input: {
  modelConfidence: number;
  factConfidence: number;
}): number {
  const base = Math.max(0, Math.min(1, input.modelConfidence));
  return Math.round(Math.min(base, input.factConfidence * 0.9, 0.85) * 100) / 100;
}

export type AssetRelation = "direct" | "possible" | "indirect";

export interface AffectedAsset {
  symbol: string;
  name: string;
  relation: AssetRelation;
  rationale: string;
}

export function asAffectedAssets(value: unknown): AffectedAsset[] {
  if (!Array.isArray(value)) return [];
  const out: AffectedAsset[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const symbol = typeof raw["symbol"] === "string" ? raw["symbol"].trim() : "";
    if (!symbol) continue;
    const relation = raw["relation"];
    out.push({
      symbol,
      name: typeof raw["name"] === "string" && raw["name"] ? raw["name"] : symbol,
      relation:
        relation === "direct" || relation === "possible" || relation === "indirect"
          ? relation
          : "possible",
      rationale: typeof raw["rationale"] === "string" ? raw["rationale"] : "",
    });
  }
  return out.slice(0, 8);
}

/** One development in the life of an event — events grow, they don't multiply. */
export interface TimelineEntry {
  at: string;
  note: string;
  sourceCount: number;
  importance: number;
}

export function asTimeline(value: unknown): TimelineEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw["at"] !== "string" || typeof raw["note"] !== "string") return [];
    return [{
      at: raw["at"],
      note: raw["note"],
      sourceCount: typeof raw["sourceCount"] === "number" ? raw["sourceCount"] : 0,
      importance: typeof raw["importance"] === "number" ? raw["importance"] : 0,
    }];
  });
}

/**
 * Importance 0–100. Severity sets the band; relevance to THIS radar, source
 * quality, corroboration, the observed market reaction and novelty move it.
 */
export function computeImportance(input: {
  severity: EventSeverity;
  relevance: number;
  tier: SourceTier;
  independentSources: number;
  marketMovePct?: number | null;
  novelty?: number;
  isUpdate?: boolean;
}): number {
  const base = { low: 20, medium: 42, high: 66, critical: 84 }[input.severity];
  const relevance = (Math.max(0, Math.min(1, input.relevance)) - 0.5) * 30; // ±15
  const tierBonus = { primary: 8, high: 5, secondary: 0, low: -8 }[input.tier];
  const corroboration = Math.min(input.independentSources, 5) * 2 - 2; // -2 … +8
  const move = Math.min(Math.abs(input.marketMovePct ?? 0), 5) * 2; // 0 … 10
  const novelty = (input.novelty ?? 1) * 8 - 4; // -4 … +4
  const updatePenalty = input.isUpdate ? -8 : 0;
  const score = base + relevance + tierBonus + corroboration + move + novelty + updatePenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function importanceBand(score: number): "critical" | "important" | "interesting" | "minor" {
  if (score >= 85) return "critical";
  if (score >= 70) return "important";
  if (score >= 45) return "interesting";
  return "minor";
}

export type AlertSensitivity = "low" | "balanced" | "high";

export const SENSITIVITY_THRESHOLD: Record<AlertSensitivity, number> = {
  low: 82,
  balanced: 70,
  high: 55,
};

/** Importance a first-sweep event must reach before it is allowed to alert. */
export const BASELINE_ALERT_FLOOR = 80;

export interface AlertDecision {
  alert: boolean;
  reason:
    | "new_significant_event"
    | "material_update"
    | "baseline"
    | "baseline_significant"
    | "below_threshold"
    | "no_material_change"
    | "cooldown";
}

/**
 * One event → at most one alert per cooldown window. Follow-up coverage of a
 * story the user already heard about must clear a materiality bar first.
 */
export function alertDecision(input: {
  importance: number;
  isBaseline: boolean;
  isNewEvent: boolean;
  isMaterialUpdate?: boolean;
  lastAlertedAt?: string | null;
  nowIso?: string;
  sensitivity?: AlertSensitivity;
  cooldownHours?: number;
}): AlertDecision {
  const threshold = SENSITIVITY_THRESHOLD[input.sensitivity ?? "balanced"];
  // A first sweep does not alert on ordinary news — it is establishing the
  // timeline. But genuinely major breaking news found on that first sweep must
  // still reach the user; otherwise a radar's most important event is silently
  // swallowed and can never alert again, because later sweeps see it as known.
  if (input.isBaseline) {
    return input.importance >= BASELINE_ALERT_FLOOR
      ? { alert: true, reason: "baseline_significant" }
      : { alert: false, reason: "baseline" };
  }
  if (input.importance < threshold) return { alert: false, reason: "below_threshold" };
  if (input.isNewEvent) return { alert: true, reason: "new_significant_event" };
  if (!input.isMaterialUpdate) return { alert: false, reason: "no_material_change" };

  const cooldownHours = input.cooldownHours ?? 12;
  const now = Date.parse(input.nowIso ?? new Date().toISOString());
  const last = input.lastAlertedAt ? Date.parse(input.lastAlertedAt) : NaN;
  if (Number.isFinite(last) && now - last < cooldownHours * 36e5 && input.importance < 90) {
    return { alert: false, reason: "cooldown" };
  }
  return { alert: true, reason: "material_update" };
}

/**
 * An update is material when the story genuinely moved on: fresh independent
 * corroboration, a higher severity, or a real jump in importance.
 */
export function isMaterialUpdate(input: {
  newIndependentSources: number;
  previousImportance: number;
  importance: number;
  previousSeverity: EventSeverity;
  severity: EventSeverity;
}): boolean {
  if (severityRank(input.severity) > severityRank(input.previousSeverity)) return true;
  if (input.importance - input.previousImportance >= 10) return true;
  return input.newIndependentSources >= 2;
}

/**
 * Novelty 0–1: how unlike everything the radar already knows this story is.
 * Recurring coverage of a known theme scores low and rarely alerts.
 */
export function noveltyScore(
  candidate: { title: string; entities?: string[]; type?: EventType },
  known: { title: string; entities?: string[]; type?: EventType }[],
): number {
  let maxSim = 0;
  for (const k of known) maxSim = Math.max(maxSim, eventSimilarity(candidate, k));
  return Math.round((1 - Math.min(1, maxSim)) * 100) / 100;
}

/** Find the stored event a fresh cluster is a continuation of, if any. */
export function matchExistingEvent<T extends { title: string; entities?: string[]; type?: EventType; published_at?: string | null }>(
  candidate: { title: string; entities?: string[]; type?: EventType; published_at?: string | null },
  existing: T[],
  threshold = 0.4,
): T | null {
  let best: { row: T; score: number } | null = null;
  for (const row of existing) {
    if (candidate.published_at && row.published_at) {
      const days = Math.abs(Date.parse(candidate.published_at) - Date.parse(row.published_at)) / 864e5;
      if (!Number.isNaN(days) && days > 5) continue;
    }
    const score = eventSimilarity(candidate, row);
    if (score >= threshold && (!best || score > best.score)) best = { row, score };
  }
  return best?.row ?? null;
}

const CAUSAL_PATTERNS: [RegExp, string][] = [
  [/\bcaused by\b/gi, "coincided with"],
  [/\bcaused\b/gi, "coincided with"],
  [/\bdue to\b/gi, "amid"],
  [/\bbecause of\b/gi, "amid"],
  [/\bdrove\b/gi, "coincided with"],
  [/\borsakade\b/gi, "sammanföll med"],
  [/\bpå grund av\b/gi, "i samband med"],
  [/\bledde till\b/gi, "sammanföll med"],
];

export function containsCausalClaim(text: string): boolean {
  return CAUSAL_PATTERNS.some(([pattern]) => new RegExp(pattern.source, "i").test(text));
}

/**
 * Radar never asserts causation between an event and a price move. Any causal
 * phrasing that slips out of the model is rewritten into coincidence language.
 */
export function softenCausality(text: string): string {
  let out = text;
  for (const [pattern, replacement] of CAUSAL_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, "gi"), replacement);
  }
  return out;
}

/**
 * Two events belong to the SAME running story (an escalation, a policy cycle)
 * even when they are separate happenings. The timeline keeps them apart; the
 * alert layer uses this to avoid eight notifications about one situation.
 */
export function sameStory(
  a: { title: string; entities?: string[]; type?: EventType },
  b: { title: string; entities?: string[]; type?: EventType },
): boolean {
  const entsA = (a.entities ?? strongTokens(a.title)).map((e) => e.toLowerCase());
  const entsB = (b.entities ?? strongTokens(b.title)).map((e) => e.toLowerCase());
  if (overlap(entsA, entsB) >= 0.5) return true;
  return eventSimilarity(a, b) >= 0.35;
}

/** Hard ceiling on event alerts per sweep — intelligence, not a news ticker. */
export const MAX_EVENT_ALERTS_PER_RUN = 3;
