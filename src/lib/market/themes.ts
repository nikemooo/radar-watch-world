/**
 * Emerging themes — V3.
 *
 * Individual events are still too granular for a dashboard: eight reports of
 * an escalating conflict are eight timeline entries but ONE thing the user
 * needs to know about. A theme groups related events across radars and carries
 * the aggregate market picture.
 *
 * Pure functions. Input is whatever the UI already loaded; no I/O.
 */
import { normalizeCategory, relatedCategories, type EventCategory } from "./taxonomy";

export interface ThemeInputEvent {
  id: string;
  title: string;
  entities: string[];
  event_type: string | null;
  importance_score: number | null;
  published_at: string | null;
  last_updated_at?: string | null;
  affected_assets?: unknown;
  market_reactions?: unknown;
}

export interface ThemeMove {
  symbol: string;
  changePct: number;
  window: string | null;
}

export interface Theme {
  id: string;
  label: string;
  category: EventCategory;
  eventIds: string[];
  eventCount: number;
  importance: number;
  latestAt: string | null;
  entities: string[];
  moves: ThemeMove[];
}

function normalizedEntities(event: ThemeInputEvent): string[] {
  const list = (event.entities ?? [])
    .map((e) => e.toLowerCase().trim())
    .filter((e) => e.length > 2);
  if (list.length > 0) return [...new Set(list)];
  return [
    ...new Set(
      event.title
        .split(/\s+/)
        .filter((w) => /^\p{Lu}[\p{L}-]{2,}$/u.test(w))
        .map((w) => w.toLowerCase()),
    ),
  ];
}

function entityOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const B = new Set(b);
  let shared = 0;
  for (const e of a) if (B.has(e)) shared += 1;
  return shared / Math.min(a.length, b.length);
}

function readMoves(value: unknown): ThemeMove[] {
  if (!Array.isArray(value)) return [];
  const out: ThemeMove[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (raw["available"] !== true) continue;
    const symbol = typeof raw["symbol"] === "string" ? raw["symbol"] : "";
    const changePct = typeof raw["changePct"] === "number" ? raw["changePct"] : null;
    if (!symbol || changePct === null) continue;
    out.push({
      symbol,
      changePct,
      window: typeof raw["window"] === "string" ? raw["window"] : null,
    });
  }
  return out;
}

/** Shared entities plus a compatible category mean one running story. */
function belongsTogether(a: ThemeInputEvent, b: ThemeInputEvent): boolean {
  const catA = normalizeCategory(a.event_type);
  const catB = normalizeCategory(b.event_type);
  if (!relatedCategories(catA, catB)) return false;
  return entityOverlap(normalizedEntities(a), normalizedEntities(b)) >= 0.4;
}

/** Human label for a theme: the two dominant entities plus the category. */
function themeLabel(events: ThemeInputEvent[], category: EventCategory): string {
  const counts = new Map<string, { display: string; n: number }>();
  for (const event of events) {
    for (const raw of event.entities ?? []) {
      const key = raw.toLowerCase().trim();
      if (key.length < 3) continue;
      const prior = counts.get(key);
      counts.set(key, { display: prior?.display ?? raw.trim(), n: (prior?.n ?? 0) + 1 });
    }
  }
  const top = [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 2)
    .map((c) => c.display);
  if (top.length > 0) return top.join(" · ");
  const strongest = [...events].sort(
    (a, b) => (b.importance_score ?? 0) - (a.importance_score ?? 0),
  )[0];
  return strongest?.title.slice(0, 70) ?? category.replace(/_/g, " ");
}

/** Aggregate the observed moves across a theme — median per symbol. */
function aggregateMoves(events: ThemeInputEvent[]): ThemeMove[] {
  const bySymbol = new Map<string, { window: string | null; values: number[] }>();
  for (const event of events) {
    for (const move of readMoves(event.market_reactions)) {
      const entry = bySymbol.get(move.symbol) ?? { window: move.window, values: [] };
      entry.values.push(move.changePct);
      bySymbol.set(move.symbol, entry);
    }
  }
  const out: ThemeMove[] = [];
  for (const [symbol, entry] of bySymbol) {
    const sorted = [...entry.values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const value = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    out.push({ symbol, changePct: Math.round(value * 100) / 100, window: entry.window });
  }
  return out.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 4);
}

/**
 * Group events into themes. Only groups with more than one event, or a single
 * genuinely important one, are worth surfacing as "what's moving markets".
 */
export function buildThemes(
  events: ThemeInputEvent[],
  options: { minEvents?: number; max?: number } = {},
): Theme[] {
  const groups: ThemeInputEvent[][] = [];
  const ordered = [...events].sort((a, b) => (b.importance_score ?? 0) - (a.importance_score ?? 0));

  for (const event of ordered) {
    const target = groups.find((group) => group.some((member) => belongsTogether(member, event)));
    if (target) target.push(event);
    else groups.push([event]);
  }

  const minEvents = options.minEvents ?? 2;
  const themes: Theme[] = groups
    .filter((group) => group.length >= minEvents || (group[0]?.importance_score ?? 0) >= 70)
    .map((group) => {
      const category = normalizeCategory(group[0]?.event_type);
      const latest =
        group
          .map((e) => e.last_updated_at ?? e.published_at)
          .filter((t): t is string => Boolean(t))
          .sort()
          .at(-1) ?? null;
      const entities = [
        ...new Set(group.flatMap((e) => (e.entities ?? []).map((x) => x.trim())).filter(Boolean)),
      ].slice(0, 6);
      return {
        id: group.map((e) => e.id).sort()[0] ?? category,
        label: themeLabel(group, category),
        category,
        eventIds: group.map((e) => e.id),
        eventCount: group.length,
        importance: Math.max(...group.map((e) => e.importance_score ?? 0)),
        latestAt: latest,
        entities,
        moves: aggregateMoves(group),
      };
    });

  return themes
    .sort((a, b) => b.eventCount * 5 + b.importance - (a.eventCount * 5 + a.importance))
    .slice(0, options.max ?? 5);
}
