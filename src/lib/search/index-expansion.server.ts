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
  const ranked = documents
    .map((doc) => {
      const families = detectItemFamilies(harvest(doc), doc.url);
      // Item families hosted by the page's own site indicate a real listing
      // index rather than an article linking out.
      const own = families.filter((f) => f.signature.startsWith(hostOf(doc.url)));
      const best = own[0] ?? families[0];
      const score = best ? best.urls.length * (own.length > 0 ? 2 : 1) * best.variableSegments : 0;
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

/**
 * Re-read index-like documents at full width and expose the concrete item URLs
 * they contain. Nothing is invented: every URL comes from the page itself.
 */
export async function expandIndexPages(
  documents: SearchDocument[],
  maxPages = 6,
): Promise<ExpansionResult> {
  const targets = selectIndexPages(documents, maxPages);
  if (targets.length === 0) {
    return { documents, expanded: [], attempted: 0, failures: [], costEstimate: 0 };
  }

  const urls = targets.map((d) => d.url);
  let read = new Map<string, { text: string; links: string[]; title?: string }>();
  let costEstimate = 0;
  if (process.env["EXA_API_KEY"]) {
    try {
      read = await readViaExa(urls);
      costEstimate = Number((urls.length * EXA_CONTENT_COST).toFixed(4));
    } catch (err) {
      console.warn(`[radar:index] expansion read failed — ${(err as Error).message}`);
    }
  }
  // Direct fallback for pages the contents provider could not return.
  const missing = urls.filter((u) => !read.get(u)?.links?.length);
  const fallbacks = await Promise.all(missing.map((u) => readViaHttp(u)));
  missing.forEach((u, i) => {
    const r = fallbacks[i];
    if (r && r.links.length > 0) read.set(u, r);
  });

  const expanded: ExpandedIndex[] = [];
  const failures: { url: string; reason: string }[] = [];
  const byUrl = new Map(documents.map((d) => [d.url, d]));

  for (const doc of targets) {
    const page = read.get(doc.url);
    if (!page || page.links.length === 0) {
      failures.push({ url: doc.url, reason: "index page could not be re-read" });
      continue;
    }
    const allLinks = Array.from(new Set([...(doc.links ?? []), ...page.links]));
    const families = detectItemFamilies(allLinks, doc.url);
    const ownSig = pathSignature(doc.url);
    const itemUrls = families
      .flatMap((f) => f.urls)
      .filter((u) => pathSignature(u) !== ownSig)
      .slice(0, 200);

    byUrl.set(doc.url, {
      ...doc,
      snippet: page.text.length > doc.snippet.length ? page.text : doc.snippet,
      links: allLinks.slice(0, 250),
    });
    expanded.push({
      url: doc.url,
      families: families.slice(0, 6),
      itemUrls,
      linkCount: allLinks.length,
      textLength: page.text.length,
    });
  }

  return {
    documents: documents.map((d) => byUrl.get(d.url) ?? d),
    expanded,
    attempted: targets.length,
    failures,
    costEstimate,
  };
}
