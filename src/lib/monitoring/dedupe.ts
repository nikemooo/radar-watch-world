/**
 * Listing-level deduplication — pure and category-agnostic.
 *
 * Two rows are the same LISTING (not merely the same product) when they point
 * at the same advert. Marketplaces make that hard: the same advert is reachable
 * through a slugged URL, an id-only URL, an AMP variant, a tracking link and an
 * aggregator mirror. Product identity is not enough either — two different
 * sellers may advertise the exact same product and both are legitimate results.
 *
 * The rules, strongest first:
 *   1. same normalized URL                       → same listing
 *   2. same host + same listing id in the path   → same listing
 *   3. same strong identifier (VIN, serial…)     → same physical item
 *   4. same host + same price + same title stem  → same listing, re-slugged
 */
import { cleanListingUrl } from "@/lib/search/listing-url";
import { sameItem, type Identifier } from "./identifiers";
import { fold } from "./identity";

export interface DedupableListing {
  url: string;
  title: string;
  numeric_value: number | null;
  currency: string | null;
  identifiers?: Identifier[];
}

/** Protocol-, host- and tracking-insensitive URL form. */
export function normalizedUrl(url: string): string {
  try {
    const u = new URL(cleanListingUrl(url));
    const host = u.host.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").replace(/\/amp$/i, "").toLowerCase();
    const query = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const search = query.length > 0 ? `?${query.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
    return `${host}${path}${search}`;
  } catch {
    return fold(url.trim());
  }
}

/** The numeric advert id most marketplaces put in the path. */
export function listingId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./i, "").toLowerCase();
    const ids = u.pathname.match(/\d{5,}/g);
    if (!ids || ids.length === 0) return null;
    return `${host}#${ids[ids.length - 1]}`;
  } catch {
    return null;
  }
}

function titleStem(title: string): string {
  return fold(title)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2)
    .slice(0, 6)
    .sort()
    .join("-");
}

function priceKey(item: DedupableListing): string | null {
  if (item.numeric_value === null) return null;
  try {
    const host = new URL(item.url).host.replace(/^www\./i, "").toLowerCase();
    return `${host}#${item.numeric_value}${item.currency ?? ""}#${titleStem(item.title)}`;
  } catch {
    return null;
  }
}

export interface DedupeResult<T> {
  kept: T[];
  removed: { url: string; duplicateOf: string; rule: string }[];
}

/**
 * Collapse duplicate listings, keeping the first occurrence. Callers should
 * pass items in preference order (direct links and richer rows first).
 */
export function dedupeListings<T extends DedupableListing>(items: T[]): DedupeResult<T> {
  const kept: T[] = [];
  const removed: DedupeResult<T>["removed"] = [];
  const byUrl = new Map<string, T>();
  const byId = new Map<string, T>();
  const byPrice = new Map<string, T>();

  for (const item of items) {
    const url = normalizedUrl(item.url);
    const id = listingId(item.url);
    const price = priceKey(item);

    const urlHit = byUrl.get(url);
    const idHit = id ? byId.get(id) : undefined;
    const identifierHit =
      item.identifiers && item.identifiers.length > 0
        ? kept.find((k) => k.identifiers && sameItem(k.identifiers, item.identifiers!))
        : undefined;
    const priceHit = price ? byPrice.get(price) : undefined;

    const hit = urlHit ?? idHit ?? identifierHit ?? priceHit;
    if (hit) {
      removed.push({
        url: item.url,
        duplicateOf: hit.url,
        rule: urlHit ? "same-url" : idHit ? "same-listing-id" : identifierHit ? "same-identifier" : "same-seller-price",
      });
      continue;
    }

    kept.push(item);
    byUrl.set(url, item);
    if (id) byId.set(id, item);
    if (price) byPrice.set(price, item);
  }

  return { kept, removed };
}
