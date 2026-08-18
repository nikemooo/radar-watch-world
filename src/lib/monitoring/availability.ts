/**
 * Availability of a previously known listing.
 *
 * A listing is only declared gone when the source itself says so — an HTTP
 * 404/410 on the exact listing URL, or structured availability data marking it
 * sold/out of stock. A listing that merely stopped appearing in search results
 * is NOT evidence of removal (search coverage varies between sweeps), so it is
 * never marked removed here.
 */

export type Availability = "available" | "removed" | "unknown";

export interface FetchFailure {
  url: string;
  reason: string;
}

const GONE = /\b(404|410)\b|not[_\s-]?found|\bgone\b/i;

/** True when the failure reason proves the page no longer exists. */
export function reasonProvesRemoved(reason: string): boolean {
  return GONE.test(reason);
}

/** Structured availability strings (schema.org and common variants). */
export function availabilityFromStructured(value: string | null | undefined): Availability {
  if (!value) return "unknown";
  const v = value.toLowerCase();
  if (/soldout|sold_out|sold\b|outofstock|out_of_stock|discontinued|expired/.test(v)) return "removed";
  if (/instock|in_stock|available|forsale|for_sale|preorder/.test(v)) return "available";
  return "unknown";
}

/**
 * Which of the known listing URLs are proven gone by this sweep's failures.
 * Returns the subset of `knownUrls` (exact match) with a human-readable reason.
 */
export function removedListings(
  failures: FetchFailure[],
  knownUrls: Iterable<string>,
): { url: string; reason: string }[] {
  const known = new Set(knownUrls);
  const out: { url: string; reason: string }[] = [];
  for (const f of failures) {
    if (!known.has(f.url)) continue;
    if (!reasonProvesRemoved(f.reason)) continue;
    out.push({ url: f.url, reason: f.reason });
  }
  return out;
}
