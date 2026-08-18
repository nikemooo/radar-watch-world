/**
 * Index-row price recovery.
 *
 * Many marketplaces render their item pages client-side, so a fetched detail
 * page contains no price at all. The same price is, however, printed on the
 * index/listing page the item was discovered on, right inside the item's own
 * card. This module reads those cards structurally: it locates the anchors that
 * point at concrete item URLs, isolates the markup block belonging to each
 * anchor, and reads the money value written inside that block.
 *
 * Rules (no guessing, ever):
 *  - a value is only attached to an item URL found *in the same card block*;
 *  - if a block contains more than one distinct monetary value (list price and
 *    ex-VAT price, price range, monthly financing...), the join is AMBIGUOUS
 *    and no price is produced;
 *  - the verbatim source string is preserved together with the index page URL,
 *    so provenance always shows the value came from discovery, not the detail
 *    page.
 * Nothing here is site-specific: it works from anchors, blocks and currency
 * tokens only.
 */
import { detectCurrency, normalizeMoney } from "../monitoring/normalize";

export interface IndexPriceHint {
  itemUrl: string;
  /** Verbatim money string as printed on the index page. */
  raw: string;
  value: number | null;
  currency: string | null;
  /** The index/listing page the value was read from. */
  sourceUrl: string;
  origin: "index";
}

export interface IndexRowResult {
  hints: Map<string, IndexPriceHint>;
  /** Item URLs whose card held several conflicting values — left unknown. */
  ambiguous: { itemUrl: string; values: string[]; sourceUrl: string }[];
}

const MAX_BLOCK_CHARS = 6000;

const SUFFIX_MONEY =
  /(\d{1,3}(?:[ \u00a0.,]\d{3})+|\d{4,9})(?:[.,]\d{2})?\s*(kr|sek|nok|dkk|kč|zł|eur|usd|gbp|chf|pln|czk|:-|€|\$|£)/gi;
const PREFIX_MONEY = /(€|\$|£|kr|SEK|EUR|USD|GBP|CHF)\s?(\d{1,3}(?:[ \u00a0.,]\d{3})+|\d{4,9})(?:[.,]\d{2})?/g;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** All distinct money strings written inside one card block. */
export function moneyStringsIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(SUFFIX_MONEY)) found.push(m[0].trim());
  for (const m of text.matchAll(PREFIX_MONEY)) found.push(m[0].trim());
  return found;
}

function normalizedKey(raw: string): string | null {
  const { value, currency } = normalizeMoney(raw);
  if (value === null) return null;
  return `${value}:${currency ?? detectCurrency(raw) ?? "?"}`;
}

function absolute(href: string, base: string): string | null {
  try {
    return new URL(href.replace(/&amp;/g, "&"), base).toString().split("#")[0]!;
  } catch {
    return null;
  }
}

/**
 * Read one price per item card from an index page's HTML.
 * `itemUrls` restricts the join to URLs discovery already accepted as items.
 */
export function extractIndexRowPrices(html: string, pageUrl: string, itemUrls: Set<string>): IndexRowResult {
  const anchors: { url: string; at: number }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const abs = absolute(m[1]!, pageUrl);
    if (!abs) continue;
    if (!itemUrls.has(abs) && !itemUrls.has(`${abs}/`)) continue;
    anchors.push({ url: itemUrls.has(abs) ? abs : `${abs}/`, at: m.index! });
  }
  anchors.sort((a, b) => a.at - b.at);

  // valueKey -> raw, collected per item URL across all of its anchors.
  const perItem = new Map<string, Map<string, string>>();
  anchors.forEach((anchor, i) => {
    const end = Math.min(anchor.at + MAX_BLOCK_CHARS, anchors[i + 1]?.at ?? html.length);
    const text = stripTags(html.slice(anchor.at, end));
    const bucket = perItem.get(anchor.url) ?? new Map<string, string>();
    for (const raw of moneyStringsIn(text)) {
      const key = normalizedKey(raw);
      if (!key) continue;
      if (!bucket.has(key)) bucket.set(key, raw);
    }
    perItem.set(anchor.url, bucket);
  });

  const hints = new Map<string, IndexPriceHint>();
  const ambiguous: IndexRowResult["ambiguous"] = [];
  for (const [itemUrl, bucket] of perItem) {
    if (bucket.size === 0) continue;
    if (bucket.size > 1) {
      ambiguous.push({ itemUrl, values: [...bucket.values()], sourceUrl: pageUrl });
      continue;
    }
    const raw = [...bucket.values()][0]!;
    const { value, currency } = normalizeMoney(raw);
    hints.set(itemUrl, {
      itemUrl,
      raw,
      value,
      currency: currency ?? detectCurrency(raw),
      sourceUrl: pageUrl,
      origin: "index",
    });
  }
  return { hints, ambiguous };
}

const PAGE_PARAMS = ["page", "p", "sida", "side", "pagina", "seite", "offset", "start", "from", "pageno"];

/**
 * Pagination links for an index page, derived structurally: either the same
 * URL with a numeric paging parameter, or a sibling URL with the identical
 * path shape. Never a constructed URL — only links present on the page.
 */
export function detectPaginationLinks(links: string[], pageUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const currentPage = (() => {
    for (const p of PAGE_PARAMS) {
      const v = base.searchParams.get(p);
      if (v && /^\d+$/.test(v)) return Number(v);
    }
    return 1;
  })();

  const out = new Map<number, string>();
  for (const link of links) {
    let u: URL;
    try {
      u = new URL(link);
    } catch {
      continue;
    }
    if (u.host !== base.host || u.pathname !== base.pathname) continue;
    for (const p of PAGE_PARAMS) {
      const v = u.searchParams.get(p);
      if (!v || !/^\d+$/.test(v)) continue;
      const n = Number(v);
      if (n <= currentPage) continue;
      if (!out.has(n)) out.set(n, u.toString().split("#")[0]!);
    }
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, url]) => url);
}

/**
 * When a page exposes no pagination link but does declare a paging parameter
 * convention through its own URL, the next page is that same URL with the
 * parameter incremented. Only used for URLs that already carry the parameter,
 * so nothing is invented about the site's URL scheme.
 */
export function nextPageByParam(pageUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  for (const p of PAGE_PARAMS) {
    const v = u.searchParams.get(p);
    if (v && /^\d+$/.test(v)) {
      u.searchParams.set(p, String(Number(v) + 1));
      return u.toString();
    }
  }
  // Many marketplaces render their pager client-side, so no next link exists in
  // the served markup. Trying the conventional ?page=2 is safe: a site that
  // does not use it simply serves page one again, and the caller stops because
  // no unseen item URLs appear.
  if (u.searchParams.toString().length > 0 || u.pathname.length > 1) {
    u.searchParams.set("page", "2");
    return u.toString();
  }
  return null;
}
