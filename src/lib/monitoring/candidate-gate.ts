/**
 * Candidate gating — cheap, deterministic, category-agnostic.
 *
 * Two classes of candidate must never reach the expensive part of the
 * pipeline (detail fetch, AI extraction, AI verification):
 *
 *   1. Pages that are not one item. A marketplace search page, category page
 *      or aggregator index is evidence about a market, never a listing, and
 *      presenting one as "the advert" is a correctness bug — not a cosmetic
 *      one. They are classified and dropped here.
 *   2. Items that provably belong to a market the radar did not ask for. A
 *      country-code TLD is structural proof of market; nothing else is used,
 *      so a generic .com is never rejected on suspicion.
 *
 * Nothing here knows about cars, watches or any specific site.
 */
import type { CandidateItem } from "./candidates.server";
import { marketOfHost, type Market } from "./geo";
import { looksLikeItemUrl } from "../search/url-shape";

export type CandidateKind = "listing" | "search_page" | "aggregator" | "unknown";

const SEARCH_PATH =
  /(^|\/)(search|sok|s%C3%B6k|soek|browse|category|categories|kategori|kategorier|listings|annonser|results|resultat|discover|filter|find|marketplace|shop|collection)(\/|$)/i;

const SEARCH_QUERY_KEYS = ["q", "query", "search", "keyword", "sok", "s"];

/**
 * What does this URL address? `indexUrls` are pages we ourselves read as
 * indexes this sweep — by definition they are not items.
 */
export function classifyCandidateUrl(
  url: string,
  indexUrls: Iterable<string> = [],
): CandidateKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "unknown";
  }
  const normalized = normalizeUrl(url);
  for (const index of indexUrls) {
    if (normalizeUrl(index) === normalized) return "search_page";
  }
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "aggregator"; // host root
  if (SEARCH_PATH.test(u.pathname)) {
    // A search path CAN still address one item (…/annonser/12345678).
    return looksLikeItemUrl(url) ? "listing" : "search_page";
  }
  for (const key of SEARCH_QUERY_KEYS) {
    if (u.searchParams.has(key)) return "search_page";
  }
  if (looksLikeItemUrl(url)) return "listing";
  return "unknown";
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * False only when the host's country-code TLD proves a market the radar did
 * not ask for. Unknown market ⇒ allowed (the evidence layer decides later).
 */
export function marketAllowed(url: string, markets: Market[]): boolean {
  if (markets.length === 0) return true;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  const market = marketOfHost(host);
  if (!market) return true;
  return markets.some((m) => m.code === market.code);
}

export interface GateResult {
  kept: CandidateItem[];
  rejected: Array<{ url: string; reason: string; kind: CandidateKind }>;
  searchPages: number;
  offMarket: number;
}

/** Apply both gates, keeping full provenance of what was dropped and why. */
export function gateCandidates(input: {
  candidates: CandidateItem[];
  indexUrls?: Iterable<string>;
  markets?: Market[];
}): GateResult {
  const indexUrls = [...(input.indexUrls ?? [])];
  const markets = input.markets ?? [];
  const kept: CandidateItem[] = [];
  const rejected: GateResult["rejected"] = [];
  let searchPages = 0;
  let offMarket = 0;

  for (const candidate of input.candidates) {
    const url = candidate.url;
    if (!url) {
      kept.push(candidate);
      continue;
    }
    const kind = classifyCandidateUrl(url, indexUrls);
    if (kind !== "listing") {
      searchPages += 1;
      rejected.push({ url, reason: `not a listing (${kind})`, kind });
      continue;
    }
    if (!marketAllowed(url, markets)) {
      offMarket += 1;
      rejected.push({
        url,
        reason: `source belongs to another market than ${markets.map((m) => m.name).join("/")}`,
        kind,
      });
      continue;
    }
    kept.push(candidate);
  }

  return { kept, rejected, searchPages, offMarket };
}
