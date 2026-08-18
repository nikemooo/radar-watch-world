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
  type IndexCard,
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
  /** Item URLs seen again on a later page of the same index. */
  duplicateItemUrls: number;
  /** Why pagination stopped: exhausted, no-new-items, page cap, read failure. */
  stopReason: string;
}

export interface ExpansionTelemetry {
  index_pages_fetched: number;
  index_pages_expanded: number;
  index_prices_joined: number;
  ambiguous_price_joins: number;
  pages_attempted: number;
  pages_succeeded: number;
  pages_blocked: number;
  pages_skipped: number;
  indexes_exhausted: number;
}

/** Deterministic explanation of why one document was expanded or skipped. */
export interface SelectionTelemetryRow {
  host: string;
  url: string;
  /** Structural signature of the best item family found on the page. */
  signature: string | null;
  itemUrls: number;
  /** Family lives on the page's own host — a real listing index, not an outlink. */
  ownHost: boolean;
  /** Characters of readable text the provider returned (shallow vs deep). */
  textLength: number;
  textSignal: "shallow" | "deep";
  score: number;
  probe: number;
  probeEligible: boolean;
  selected: boolean;
  reason: string;
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
  /**
   * Verbatim text of the card each item was discovered in. Detail pages that
   * render their facts client-side leave the index card as the only readable
   * evidence for that item, so it is carried forward as index-origin context.
   */
  indexCards: Map<string, IndexCard>;
  telemetry: ExpansionTelemetry;
  /** Per-candidate explanation of expansion selection. */
  selection: SelectionTelemetryRow[];
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

/** Static asset / media URLs are never monitorable items. */
const ASSET_URL = /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|json|xml|pdf|mp4|webm|woff2?|ttf)(\?|$)/i;

/** A family whose links are mostly static assets is page furniture, not inventory. */
function isAssetFamily(family: UrlFamily): boolean {
  const assets = family.urls.filter((u) => ASSET_URL.test(u)).length;
  return assets * 2 > family.urls.length;
}

/**
 * Quality of an item family as evidence of real inventory.
 *
 * The dominant signal is HOW MANY sibling item URLs repeat on the page, not how
 * deep their paths are: depth rewards CDN/media trees and navigation junk, which
 * is exactly how a real marketplace index loses to a spec/catalog page. A family
 * ending in a variable id segment is the canonical shape of a detail URL and is
 * given a modest, bounded boost.
 */
function familyScore(family: UrlFamily, ownHost: boolean): number {
  const segments = family.signature.split("/");
  const last = segments[segments.length - 1] ?? "";
  // A trailing numeric id is the canonical shape of a detail/item URL; an
  // opaque slug is weaker evidence; a static word is a site section.
  const trailingId = last === "#" ? 2 : last === "*" ? 1.25 : 1;
  return family.urls.length * (ownHost ? 2 : 1) * trailingId;
}

export interface SelectionResult {
  picked: SearchDocument[];
  telemetry: SelectionTelemetryRow[];
}

/**
 * Documents that link to a repeating family of item URLs, most promising first.
 * Hosts are spread so a single site cannot consume the whole expansion budget —
 * different sources are what widen coverage.
 */
export function selectIndexPages(
  documents: SearchDocument[],
  max: number,
  /** Learned/structural host priority (1 = no information). Ordering only. */
  priorityOf: (host: string) => number = () => 1,
): SelectionResult {
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
  const hostHits = new Map<string, number>();
  for (const doc of documents) {
    hostHits.set(hostOf(doc.url), (hostHits.get(hostOf(doc.url)) ?? 0) + 1);
    for (const family of detectItemFamilies(harvest(doc), doc.url)) {
      if (isAssetFamily(family)) continue;
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

  const rows: (SelectionTelemetryRow & { doc: SearchDocument })[] = documents.map((doc) => {
    const host = hostOf(doc.url);
    const families = detectItemFamilies(harvest(doc), doc.url).filter((f) => !isAssetFamily(f));
    const own = families.filter((f) => f.signature.startsWith(host));
    // Rank each family on its own merit, then keep the strongest — the first
    // family by raw link count is not necessarily the item family.
    const ranked = [...own.map((f) => ({ f, own: true })), ...families.filter((f) => !own.includes(f)).map((f) => ({ f, own: false }))]
      .map((e) => ({ ...e, s: familyScore(e.f, e.own) }))
      .sort((a, b) => b.s - a.s);
    const best = ranked[0];
    // Learned source priority re-orders equally structural candidates; it can
    // never create evidence where the page shows none (0 stays 0).
    const priority = priorityOf(host);
    const score = (best?.s ?? 0) * priority;
    let probe = 0;
    if (score === 0 && looksLikeIndexPath(doc.url)) {
      // Shallow snippets hide item families entirely. Two independent signals
      // still justify one probe read: the site is known to host item URLs, or
      // the search returned this same site repeatedly for the request — which
      // is what a dominant marketplace for the request looks like.
      if (itemHosts.has(host)) probe = 2 * priority;
      else if ((hostHits.get(host) ?? 0) >= 2) probe = 1 * priority;
      probe = Number(probe.toFixed(3));
    }
    return {
      doc,
      host,
      url: doc.url,
      signature: best?.f.signature ?? null,
      itemUrls: best?.f.urls.length ?? 0,
      ownHost: Boolean(best?.own),
      textLength: doc.snippet.length,
      textSignal: doc.snippet.length < 1500 ? ("shallow" as const) : ("deep" as const),
      score: Number(score.toFixed(2)),
      probe,
      probeEligible: probe > 0,
      selected: false,
      reason: "",
    };
  });

  const eligible = rows.filter((d) => d.score > 0 || d.probe > 0);
  for (const r of rows) {
    if (!eligible.includes(r)) r.reason = "no repeating item family and not probe-eligible";
  }

  const strong = eligible.filter((d) => d.score > 0).sort((a, b) => b.score - a.score);
  // Probes are reserved a slice of the budget. Without it a marketplace whose
  // search snippet is shallow always loses to catalog/spec pages that merely
  // *look* deep, which is exactly how real inventory gets missed.
  const probes = eligible.filter((d) => d.score === 0).sort((a, b) => b.probe - a.probe);
  const probeSlots = probes.length === 0 ? 0 : Math.max(1, Math.floor(max / 3));

  const picked: SearchDocument[] = [];
  const perHost = new Map<string, number>();
  const take = (list: typeof strong, limit: number, label: string) => {
    for (const pass of [1, 2]) {
      for (const r of list) {
        if (picked.length >= limit) break;
        if (r.selected) continue;
        if ((perHost.get(r.host) ?? 0) >= pass) continue;
        perHost.set(r.host, (perHost.get(r.host) ?? 0) + 1);
        r.selected = true;
        r.reason = `${label}: ${r.itemUrls} item URLs (${r.signature ?? "no family"}), score ${r.score}, probe ${r.probe}`;
        picked.push(r.doc);
      }
    }
  };
  take(probes, probeSlots, "selected as reserved probe");
  take(strong, max, "selected on item-family evidence");
  take(probes, max, "selected as spare-budget probe");

  for (const r of eligible) {
    if (!r.selected) {
      r.reason =
        picked.length >= max
          ? `rejected — expansion budget (${max}) exhausted by higher-scoring pages`
          : "rejected — host already used both expansion slots";
    }
  }

  const telemetry = rows.map(({ doc: _doc, ...row }) => row).sort((a, b) => b.score - a.score || b.probe - a.probe);
  return { picked, telemetry };
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
    pages_attempted: 0,
    pages_succeeded: 0,
    pages_blocked: 0,
    pages_skipped: 0,
    indexes_exhausted: 0,
  };
  const selection = selectIndexPages(documents, maxPages);
  const targets = selection.picked;
  for (const row of selection.telemetry) {
    console.info(
      `[radar:index:select] ${row.selected ? "SELECTED" : "rejected"} ${row.host} ${row.url} — ` +
        `family ${row.signature ?? "none"}, items ${row.itemUrls}, ownHost ${row.ownHost}, ` +
        `text ${row.textSignal}(${row.textLength}), score ${row.score}, probe ${row.probe}` +
        `${row.probeEligible ? " (probe-eligible)" : ""} :: ${row.reason}`,
    );
  }
  if (targets.length === 0) {
    return {
      documents,
      expanded: [],
      attempted: 0,
      failures: [],
      costEstimate: 0,
      priceHints: new Map(),
      ambiguousPrices: [],
      indexCards: new Map(),
      telemetry: emptyTelemetry,
      selection: selection.telemetry,
    };
  }

  const expanded: ExpandedIndex[] = [];
  const failures: { url: string; reason: string }[] = [];
  const byUrl = new Map(documents.map((d) => [d.url, d]));
  const priceHints = new Map<string, IndexPriceHint>();
  const ambiguousPrices: ExpansionResult["ambiguousPrices"] = [];
  const indexCards = new Map<string, IndexCard>();
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
    let duplicateItemUrls = 0;
    let stopReason = "no pagination signal on the page";

    while (queue.length > 0 && pageUrls.length < MAX_PAGES_PER_INDEX && totalReads < maxTotalPageReads) {
      const pageUrl = queue.shift()!;
      if (visited.has(pageUrl)) {
        telemetry.pages_skipped += 1;
        continue;
      }
      visited.add(pageUrl);

      const page = await readIndexPage(pageUrl, pageUrls.length === 0);
      totalReads += 1;
      telemetry.index_pages_fetched += 1;
      telemetry.pages_attempted += 1;
      costEstimate = Number((costEstimate + (page?.cost ?? 0)).toFixed(4));
      if (!page || page.links.length === 0) {
        failures.push({ url: pageUrl, reason: "index page could not be re-read" });
        telemetry.pages_blocked += 1;
        stopReason = "page could not be read";
        continue;
      }
      telemetry.pages_succeeded += 1;
      pageUrls.push(pageUrl);
      for (const l of page.links) allLinks.add(l);
      if (page.text.length > bestText.length) bestText = page.text;

      const families = detectItemFamilies([...allLinks], doc.url);
      const pageItems = detectItemFamilies(page.links, pageUrl)
        .flatMap((f) => f.urls)
        .filter((u) => pathSignature(u) !== ownSig);
      const newItems = pageItems.filter((u) => !seenItems.has(u));
      duplicateItemUrls += pageItems.length - newItems.length;
      for (const u of pageItems) seenItems.add(u);

      // Row-level prices: only from the page the item card is printed on.
      if (page.html) {
        const rows = extractIndexRowPrices(page.html, pageUrl, new Set(pageItems));
        for (const [itemUrl, card] of rows.cards) {
          const prev = indexCards.get(itemUrl);
          if (!prev || prev.text.length < card.text.length) indexCards.set(itemUrl, card);
        }
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
          `prices ${pricesJoined}, ambiguous ${ambiguousHere}, families ${families.length}, ` +
          `duplicates ${pageItems.length - newItems.length}`,
      );

      // Paginate only while the previous page still produced unseen items.
      if (newItems.length === 0) {
        stopReason = "no unseen item URLs on the last page — index exhausted";
        telemetry.indexes_exhausted += 1;
      } else if (pageUrls.length >= MAX_PAGES_PER_INDEX) {
        stopReason = `hard page ceiling (${MAX_PAGES_PER_INDEX}) reached`;
      } else {
        const nextLinks = detectPaginationLinks(page.links, pageUrl);
        const nextParam = nextPageByParam(pageUrl);
        const next = nextLinks.length > 0 ? nextLinks.slice(0, 2) : nextParam ? [nextParam] : [];
        const queued = next.filter((u) => !visited.has(u));
        if (queued.length === 0) stopReason = "no further pagination link could be identified";
        else stopReason = nextLinks.length > 0 ? "paginating via links found on the page" : "paginating via the page's own paging parameter";
        queue = [...queue, ...queued];
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
      duplicateItemUrls,
      stopReason,
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
    indexCards,
    telemetry,
    selection: selection.telemetry,
  };
}
