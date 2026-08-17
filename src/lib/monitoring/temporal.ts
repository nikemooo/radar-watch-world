/**
 * Temporal layer — category-agnostic.
 *
 * Radar must never present old information as newly occurring. These helpers
 * are pure so they can be unit-tested without a database or network.
 *
 * Core distinction:
 *  - first_seen_at  : when *Radar* first observed the item (not an event date)
 *  - published_at   : when the source published it (only if the source says so)
 *  - updated_at     : when the source was materially updated (if known)
 *  - event_date     : when the underlying event happened (if stated)
 *
 * A missing timestamp is never invented.
 */

export type MonitoringWindow = "realtime" | "rolling" | "evergreen";

export const monitoringWindowLabel: Record<MonitoringWindow, string> = {
  realtime: "Real-time (fast-moving)",
  rolling: "Rolling window",
  evergreen: "Evergreen research",
};

/** Sensible fallback when the interpreter gives us nothing usable. */
export const DEFAULT_RECENCY_DAYS = 30;

export function clampRecencyDays(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RECENCY_DAYS;
  return Math.min(Math.max(Math.round(n), 1), 3650);
}

export function asMonitoringWindow(value: unknown): MonitoringWindow {
  return value === "realtime" || value === "evergreen" ? value : "rolling";
}

/** Providers return loose date strings; only keep parsable, non-future-absurd ones. */
export function safeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  // Guard against nonsense far-future dates from scraped pages.
  if (t > Date.now() + 366 * 864e5) return null;
  if (t < Date.parse("1990-01-01")) return null;
  return new Date(t).toISOString();
}

export interface TemporalFacts {
  /** When the underlying event happened, if the source states it. */
  eventDate: string | null;
  /** When the source was published, if known. */
  publishedAt: string | null;
  /** When the source was last updated, if known. */
  updatedAt: string | null;
  /** When Radar retrieved the source (always known). */
  retrievedAt: string;
}

/**
 * The best available timestamp describing *when the information is from*.
 * Returns null when no reliable timestamp exists — callers must not substitute
 * the retrieval time, which only says when Radar looked.
 */
export function informationDate(facts: TemporalFacts): string | null {
  return facts.eventDate ?? facts.updatedAt ?? facts.publishedAt ?? null;
}

export type RecencyVerdict =
  | { withinWindow: true; reason: string; ageDays: number | null }
  | { withinWindow: false; reason: string; ageDays: number };

/**
 * Decide whether information falls inside the radar's temporal window.
 *
 * - Dated information older than `recencyDays` is stale, regardless of whether
 *   Radar has just seen it for the first time.
 * - Undated information cannot be proven stale, so it stays eligible, but the
 *   reason records that no reliable timestamp existed.
 */
export function evaluateRecency(
  facts: TemporalFacts,
  recencyDays: number,
  now = Date.now(),
): RecencyVerdict {
  const date = informationDate(facts);
  if (!date) {
    return {
      withinWindow: true,
      reason: "no reliable publication/update timestamp — treated as undated, not as new",
      ageDays: null,
    };
  }
  const ageDays = Math.floor((now - Date.parse(date)) / 864e5);
  if (ageDays > recencyDays) {
    return {
      withinWindow: false,
      reason: `information dated ${date.slice(0, 10)} is ${ageDays}d old, outside the ${recencyDays}d window`,
      ageDays,
    };
  }
  return {
    withinWindow: true,
    reason: `information dated ${date.slice(0, 10)} (${Math.max(ageDays, 0)}d old) is inside the ${recencyDays}d window`,
    ageDays,
  };
}

export function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/** Host + path of a source URL — the stable part of an item's location. */
export function sourceLocation(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return normalizeSlug(url);
  }
}

/**
 * Stable identity for extracted items.
 *
 * The language model's own slug and entity wording drift between runs
 * ("NVIDIA" vs "NVIDIA Corporation"), which would make unchanged items look
 * brand new on every sweep. Identity is therefore derived from the source
 * location, and only pages that carry several items (listing/aggregator pages)
 * get a title-based discriminator. Values are deliberately excluded so a price
 * change is a *change* to a known item, not a new item.
 */
export function assignFingerprints<T extends { url: string; title?: string | null }>(
  items: T[],
): (T & { fingerprint: string })[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const loc = sourceLocation(item.url);
    counts.set(loc, (counts.get(loc) ?? 0) + 1);
  }
  return items.map((item) => {
    const loc = sourceLocation(item.url);
    const multiple = (counts.get(loc) ?? 0) > 1;
    const discriminator = multiple
      ? normalizeSlug(item.title ?? "").split("-").slice(0, 6).join("-")
      : "";
    return { ...item, fingerprint: `${loc}${discriminator ? `|${discriminator}` : ""}`.slice(0, 240) };
  });
}
