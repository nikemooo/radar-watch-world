/**
 * Index-page expansion.
 *
 * Search providers return a short snippet and a handful of links per result.
 * For an aggregator / marketplace / listing page that is far too little: the
 * page may list dozens of concrete items, and the individual item URLs are
 * exactly what discovery needs.
 *
 * This layer re-reads index-like documents at full width (more text, many more
 * links), then clusters the links into structural families so the concrete
 * item URLs a page really contains become explicit. It is entirely generic:
 * families are derived from URL structure, never from a hardcoded site rule.
 */
import type { SearchDocument } from "./providers.server";
import { detectItemFamilies, pathSignature, type UrlFamily } from "./url-shape";
import {
  detectPaginationLinks,
  extractIndexRowPrices,
  nextPageByParam,
  type IndexPriceHint,
} from "./index-rows";

const EXPANSION_TIMEOUT_MS = 30_000;
const EXA_CONTENT_COST = 0.001;
/** Hard ceiling on how deep a single index is paginated. */
const MAX_PAGES_PER_INDEX = 5;

export interface ExpandedIndex {
  url: string;
  families: UrlFamily[];
  /** Concrete item URLs discovered on the page. */
  itemUrls: string[];
  linkCount: number;
  textLength: number;
  /** Pages read for this index, including pagination pages. */
  pagesRead: number;
  pageUrls: string[];
  pricesJoined: number;
  ambiguousPrices: number;
}

export interface ExpansionTelemetry {
  index_pages_fetched: number;
  index_pages_expanded: number;
  index_prices_joined: number;
  ambiguous_price_joins: number;
}

export interface ExpansionResult {
  /** Documents with index pages replaced by their enriched version. */
  documents: SearchDocument[];
  expanded: ExpandedIndex[];
  attempted: number;
  failures: { url: string; reason: string }[];
  costEstimate: number;
  /** Unambiguous item price read from the card it was discovered in. */
  priceHints: Map<string, IndexPriceHint>;
  ambiguousPrices: { itemUrl: string; values: string[]; sourceUrl: string }[];
  telemetry: ExpansionTelemetry;
}

function harvest(doc: SearchDocument): string[] {
  const found = new Set<string>(doc.links ?? []);
  for (const m of doc.snippet.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) {
    found.add(m[0].replace(/[.,;]+$/, ""));
  }
  return [...found];
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href.replace(/&amp;/g, "&"), base).toString().split("#")[0]!;
  } catch {
    return null;
  }
}

async function readViaExa(urls: string[]): Promise<Map<string, { text: string; links: string[]; title?: string }>> {
  const out = new Map<string, { text: string; links: string[]; title?: string }>();
  const res = await fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env["EXA_API_KEY"]! },
    body: JSON.stringify({
      urls,
      text: { maxCharacters: 12_000 },
      livecrawl: "always",
      extras: { links: 100 },
    }),
    signal: AbortSignal.timeout(EXPANSION_TIMEOUT_MS),
  });
  if (!res.ok) return out;
  const data = (await res.json()) as {
    results?: { url: string; title?: string; text?: string; extras?: { links?: string[] } }[];
  };
  for (const r of data.results ?? []) {
    const links = (r.extras?.links ?? [])
      .map((l) => absolutize(l, r.url))
      .filter((l): l is string => Boolean(l));
    out.set(r.url, { text: r.text ?? "", links, ...(r.title ? { title: r.title } : {}) });
  }
  return out;
}

async function readViaHttp(url: string): Promise<{ text: string; links: string[]; html: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "RadarBot/1.0 (+personal monitoring; respects robots and rate limits)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(EXPANSION_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 600_000);
    const links: string[] = [];
    for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      const abs = absolutize(m[1]!, res.url || url);
      if (abs && /^https?:/.test(abs)) links.push(abs);
    }
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { text, links, html };
  } catch {
    return null;
  }
}

/**
 * Documents that link to a repeating family of item URLs, most promising first.
 * Hosts are spread so a single site cannot consume the whole expansion budget —
 * different sources are what widen coverage.
 */
export function selectIndexPages(documents: SearchDocument[], max: number): SearchDocument[] {
  const hostOf = (url: string) => {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return url;
    }
  };
  // A snippet returned by a search provider can be too shallow to reveal a
  // page's item family, so a site already known to host item URLs elsewhere in
  // the result set stays eligible for a full re-read instead of being dropped.
  const itemHosts = new Set<string>();
  for (const doc of documents) {
    for (const family of detectItemFamilies(harvest(doc), doc.url)) {
      for (const u of family.urls.slice(0, 5)) itemHosts.add(hostOf(u));
    }
  }
  const looksLikeIndexPath = (url: string) => {
    try {
      const u = new URL(url);
      if (u.search.length > 1) return true;
      const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
      return u.pathname.split("/").filter(Boolean).length >= 2 && !/\d{5,}/.test(last);
    } catch {
      return false;
    }
  };
  const ranked = documents
    .map((doc) => {
      const families = detectItemFamilies(harvest(doc), doc.url);
      // Item families hosted by the page's own site indicate a real listing
      // index rather than an article linking out.
      const own = families.filter((f) => f.signature.startsWith(hostOf(doc.url)));
      const best = own[0] ?? families[0];
      let score = best ? best.urls.length * (own.length > 0 ? 2 : 1) * best.variableSegments : 0;
      if (score === 0 && itemHosts.has(hostOf(doc.url)) && looksLikeIndexPath(doc.url)) score = 4;
      return { doc, score };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked: SearchDocument[] = [];
  const perHost = new Map<string, number>();
  for (const pass of [1, 2]) {
    for (const r of ranked) {
      if (picked.length >= max) break;
      if (picked.includes(r.doc)) continue;
      const host = hostOf(r.doc.url);
      if ((perHost.get(host) ?? 0) >= pass) continue;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      picked.push(r.doc);
    }
  }
  return picked;
}

/** One read of an index page: text for context, links for discovery, HTML for rows. */
async function readIndexPage(
  url: string,
  allowExa: boolean,
): Promise<{ text: string; links: string[]; html: string | null; cost: number } | null> {
  let cost = 0;
  let text = "";
  let links: string[] = [];
  if (allowExa && process.env["EXA_API_KEY"]) {
    try {
      const read = await readViaExa([url]);
      const page = read.get(url);
      cost = EXA_CONTENT_COST;
      if (page) {
        text = page.text;
        links = page.links;
      }
    } catch (err) {
      console.warn(`[radar:index] contents read failed for ${url} — ${(err as Error).message}`);
    }
  }
  // The raw document is what carries item cards, so it is always attempted:
  // it is the only place an item URL and its price sit next to each other.
  const direct = await readViaHttp(url);
  if (direct) {
    links = Array.from(new Set([...links, ...direct.links]));
    if (direct.text.length > text.length) text = direct.text;
  }
  if (links.length === 0 && !direct) return null;
  return { text, links, html: direct?.html ?? null, cost };
}

/**
 * Re-read index-like documents at full width, paginate them while new item
 * URLs keep appearing, and expose both the concrete item URLs and the price
 * printed inside each item's own card.
 *
 * Nothing is invented: every URL and every price comes from the page itself,
 * and a card with more than one distinct price yields no price at all.
 */
export async function expandIndexPages(
  documents: SearchDocument[],
  maxPages = 6,
  maxTotalPageReads = maxPages * 3,
): Promise<ExpansionResult> {
  const emptyTelemetry: ExpansionTelemetry = {
    index_pages_fetched: 0,
    index_pages_expanded: 0,
    index_prices_joined: 0,
    ambiguous_price_joins: 0,
  };
  const targets = selectIndexPages(documents, maxPages);
  if (targets.length === 0) {
    return {
      documents,
      expanded: [],
      attempted: 0,
      failures: [],
      costEstimate: 0,
      priceHints: new Map(),
      ambiguousPrices: [],
      telemetry: emptyTelemetry,
    };
  }

  const expanded: ExpandedIndex[] = [];
  const failures: { url: string; reason: string }[] = [];
  const byUrl = new Map(documents.map((d) => [d.url, d]));
  const priceHints = new Map<string, IndexPriceHint>();
  const ambiguousPrices: ExpansionResult["ambiguousPrices"] = [];
  const telemetry: ExpansionTelemetry = { ...emptyTelemetry };
  let costEstimate = 0;
  let totalReads = 0;

  for (const doc of targets) {
    const ownSig = pathSignature(doc.url);
    const seenItems = new Set<string>();
    const allLinks = new Set<string>(doc.links ?? []);
    const pageUrls: string[] = [];
    let bestText = doc.snippet;
    let pricesJoined = 0;
    let ambiguousHere = 0;
    let queue: string[] = [doc.url];
    const visited = new Set<string>();

    while (queue.length > 0 && pageUrls.length < MAX_PAGES_PER_INDEX && totalReads < maxTotalPageReads) {
      const pageUrl = queue.shift()!;
      if (visited.has(pageUrl)) continue;
      visited.add(pageUrl);

      const page = await readIndexPage(pageUrl, pageUrls.length === 0);
      totalReads += 1;
      telemetry.index_pages_fetched += 1;
      costEstimate = Number((costEstimate + (page?.cost ?? 0)).toFixed(4));
      if (!page || page.links.length === 0) {
        failures.push({ url: pageUrl, reason: "index page could not be re-read" });
        continue;
      }
      pageUrls.push(pageUrl);
      for (const l of page.links) allLinks.add(l);
      if (page.text.length > bestText.length) bestText = page.text;

      const families = detectItemFamilies([...allLinks], doc.url);
      const pageItems = detectItemFamilies(page.links, pageUrl)
        .flatMap((f) => f.urls)
        .filter((u) => pathSignature(u) !== ownSig);
      const newItems = pageItems.filter((u) => !seenItems.has(u));
      for (const u of pageItems) seenItems.add(u);

      // Row-level prices: only from the page the item card is printed on.
      if (page.html) {
        const rows = extractIndexRowPrices(page.html, pageUrl, new Set(pageItems));
        for (const [itemUrl, hint] of rows.hints) {
          if (priceHints.has(itemUrl)) {
            const prev = priceHints.get(itemUrl)!;
            // The same item priced differently on two index pages is not a
            // safe join — drop it rather than pick one.
            if (prev.value !== hint.value || prev.currency !== hint.currency) {
              priceHints.delete(itemUrl);
              ambiguousPrices.push({ itemUrl, values: [prev.raw, hint.raw], sourceUrl: pageUrl });
              ambiguousHere += 1;
              telemetry.ambiguous_price_joins += 1;
            }
            continue;
          }
          priceHints.set(itemUrl, hint);
          pricesJoined += 1;
          telemetry.index_prices_joined += 1;
        }
        for (const a of rows.ambiguous) {
          ambiguousPrices.push(a);
          ambiguousHere += 1;
          telemetry.ambiguous_price_joins += 1;
        }
      }

      console.info(
        `[radar:index] read ${pageUrl} — links ${page.links.length}, items ${pageItems.length} (${newItems.length} new), ` +
          `prices ${pricesJoined}, ambiguous ${ambiguousHere}, families ${families.length}`,
      );

      // Paginate only while the previous page still produced unseen items.
      if (newItems.length > 0 && pageUrls.length < MAX_PAGES_PER_INDEX) {
        const nextLinks = detectPaginationLinks(page.links, pageUrl);
        const nextParam = nextPageByParam(pageUrl);
        const next = nextLinks.length > 0 ? nextLinks.slice(0, 2) : nextParam ? [nextParam] : [];
        queue = [...queue, ...next.filter((u) => !visited.has(u))];
      }
    }

    if (pageUrls.length === 0) continue;

    const families = detectItemFamilies([...allLinks], doc.url);
    const itemUrls = [...seenItems].slice(0, 400);
    byUrl.set(doc.url, {
      ...doc,
      snippet: bestText.length > doc.snippet.length ? bestText : doc.snippet,
      links: [...allLinks].slice(0, 400),
    });
    telemetry.index_pages_expanded += 1;
    expanded.push({
      url: doc.url,
      families: families.slice(0, 6),
      itemUrls,
      linkCount: allLinks.size,
      textLength: bestText.length,
      pagesRead: pageUrls.length,
      pageUrls,
      pricesJoined,
      ambiguousPrices: ambiguousHere,
    });
  }

  return {
    documents: documents.map((d) => byUrl.get(d.url) ?? d),
    expanded,
    attempted: targets.length,
    failures,
    costEstimate,
    priceHints,
    ambiguousPrices,
    telemetry,
  };
}
