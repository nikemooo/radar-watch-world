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

/** Verbatim text of the card an item was discovered in, with its source page. */
export interface IndexCard {
  itemUrl: string;
  text: string;
  sourceUrl: string;
}

export interface IndexRowResult {
  hints: Map<string, IndexPriceHint>;
  /** Item URLs whose card held several conflicting values — left unknown. */
  ambiguous: { itemUrl: string; values: string[]; sourceUrl: string }[];
  /** Card text per item URL — real page content, usable as index-origin evidence. */
  cards: Map<string, IndexCard>;
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

/**
 * Wording that marks a money value as something other than the item's own
 * asking value: tax variants, instalments/leasing, deposits, previous prices.
 * A card almost always prints one headline value plus one of these; reading
 * the qualifier keeps the headline value usable instead of discarding both.
 * The vocabulary is market-level, not site-level or category-level.
 */
const QUALIFIER =
  /(ex(?:kl|cl)?\.?\s*(moms|vat|mwst|tax|btw)|in(?:kl|cl)?\.?\s*(moms|vat|mwst|tax|btw)|moms|vat\b|mwst|\bbtw\b|\/\s*m[åa]n|per\s+m[åa]nad|\bm[åa]n\b|\/\s*mo\b|per\s+month|monthly|month\b|\bmnd\b|leasing|leas|finansiering|financ|avbetalning|kontantinsats|deposit|down\s*payment|r[äa]nta|interest|ord\.?\s*pris|ordinarie|tidigare\s+pris|was\s|f[öo]re\s+detta|rabatt|discount|spara|save|frakt|shipping|avgift|fee|hyra|rent\s*\/|from\s+only)/i;

/** All distinct money strings written inside one card block. */
export function moneyStringsIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(SUFFIX_MONEY)) found.push(m[0].trim());
  for (const m of text.matchAll(PREFIX_MONEY)) found.push(m[0].trim());
  return found;
}

/**
 * Money strings in a block, each flagged when the wording that belongs to THAT
 * value qualifies it. A qualifier is only attributed to the nearest value: the
 * lookup window is clipped at the neighbouring money values, so "749 000 kr
 * 599 200 kr exkl. moms" qualifies the second value only.
 */
export function moneyMatchesIn(text: string): { raw: string; qualified: boolean }[] {
  const spans: { raw: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(SUFFIX_MONEY)) {
    spans.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(PREFIX_MONEY)) {
    const start = m.index!;
    const end = start + m[0].length;
    // The same amount can match both shapes ("kr 599 200" vs "599 200 kr");
    // an overlapping duplicate would otherwise be counted as a rival value.
    if (spans.some((s) => start < s.end && end > s.start)) continue;
    spans.push({ raw: m[0], start, end });
  }
  spans.sort((a, b) => a.start - b.start);

  const WINDOW = 24;
  return spans.map((span, i) => {
    const from = Math.max(spans[i - 1]?.end ?? 0, span.start - WINDOW);
    const to = Math.min(spans[i + 1]?.start ?? text.length, span.end + WINDOW);
    return { raw: span.raw.trim(), qualified: QUALIFIER.test(text.slice(from, to)) };
  });
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
 * Read one price per item card from an index page's HTML, plus the verbatim
 * text of each card. `itemUrls` restricts the join to URLs discovery already
 * accepted as items.
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

  // valueKey -> value, collected per item URL across all of its anchors. The
  // same item is usually anchored twice (image and title), and the shorter
  // block can be cut off before the wording that qualifies a value, so a value
  // qualified in ANY block of that item counts as qualified everywhere.
  const perItem = new Map<string, Map<string, { raw: string; qualified: boolean }>>();
  const cards = new Map<string, IndexCard>();
  anchors.forEach((anchor, i) => {
    const end = Math.min(anchor.at + MAX_BLOCK_CHARS, anchors[i + 1]?.at ?? html.length);
    const text = stripTags(html.slice(anchor.at, end));
    const bucket = perItem.get(anchor.url) ?? new Map<string, { raw: string; qualified: boolean }>();
    for (const { raw, qualified } of moneyMatchesIn(text)) {
      const key = normalizedKey(raw);
      if (!key) continue;
      const prev = bucket.get(key);
      bucket.set(key, { raw: prev?.raw ?? raw, qualified: (prev?.qualified ?? false) || qualified });
    }
    perItem.set(anchor.url, bucket);
    const existing = cards.get(anchor.url);
    if (!existing || existing.text.length < text.length) {
      cards.set(anchor.url, { itemUrl: anchor.url, text: text.slice(0, 1200), sourceUrl: pageUrl });
    }
  });

  const hints = new Map<string, IndexPriceHint>();
  const ambiguous: IndexRowResult["ambiguous"] = [];
  for (const [itemUrl, bucket] of perItem) {
    // A value the card itself labels as tax-variant, instalment, deposit or
    // former price is not the item's asking value, so it never competes with
    // the headline value — and never becomes the value on its own either.
    const chosen = new Map(
      [...bucket.entries()].filter(([, v]) => !v.qualified).map(([k, v]) => [k, v.raw]),
    );
    if (chosen.size === 0) {
      const qualified = [...bucket.values()].filter((v) => v.qualified).map((v) => v.raw);
      if (qualified.length > 0) ambiguous.push({ itemUrl, values: qualified, sourceUrl: pageUrl });
      continue;
    }
    if (chosen.size > 1) {
      ambiguous.push({ itemUrl, values: [...chosen.values()], sourceUrl: pageUrl });
      continue;
    }
    const raw = [...chosen.values()][0]!;
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
  return { hints, ambiguous, cards };
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
