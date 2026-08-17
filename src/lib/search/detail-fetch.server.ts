/**
 * Detail-page fetching layer.
 *
 * Index/aggregator pages rarely carry item-level facts. This layer fetches the
 * *individual* page for a candidate so attributes can be read from a primary
 * source. It is category-agnostic: it knows nothing about cars, watches or
 * apartments — only about URLs and page text.
 *
 * Legality/technical limits: fetching goes through Exa's contents API when
 * configured (which respects publisher access rules) and falls back to a plain
 * GET with a descriptive user agent. Anything that blocks us is recorded as a
 * failure — never as invented content.
 */

export interface FetchedPage {
  url: string;
  /** URL the server ultimately served, when it differs (redirects). */
  final_url: string;
  title: string | null;
  text: string;
  published_at?: string | undefined;
  updated_at?: string | undefined;
  fetched_at: string;
  via: "exa" | "http";
}

export interface DetailFetchResult {
  pages: FetchedPage[];
  failures: { url: string; reason: string }[];
  costEstimate: number;
}

/** Rough per-URL content cost, used for admin cost estimates. */
const EXA_CONTENT_COST = 0.001;
const CONTENT_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 20_000;

function isFetchableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (/\.(pdf|zip|jpg|jpeg|png|gif|mp4|webp)$/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchViaExa(urls: string[], maxChars: number): Promise<DetailFetchResult> {
  const fetched_at = new Date().toISOString();
  const res = await fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env["EXA_API_KEY"]!,
    },
    body: JSON.stringify({ urls, text: { maxCharacters: maxChars }, livecrawl: "fallback" }),
    signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return {
      pages: [],
      failures: urls.map((url) => ({ url, reason: `Exa contents failed (${res.status}) ${detail}` })),
      costEstimate: 0,
    };
  }
  const data = (await res.json()) as {
    results?: { url: string; title?: string; text?: string; publishedDate?: string }[];
    statuses?: { id: string; status: string; error?: { tag?: string } }[];
  };
  const pages: FetchedPage[] = [];
  const seen = new Set<string>();
  for (const r of data.results ?? []) {
    if (!r.text || r.text.trim().length < 80) continue;
    seen.add(r.url);
    pages.push({
      url: r.url,
      final_url: r.url,
      title: r.title ?? null,
      text: r.text.slice(0, maxChars),
      published_at: r.publishedDate,
      fetched_at,
      via: "exa",
    });
  }
  const failures = urls
    .filter((u) => !pages.some((p) => p.url === u))
    .map((url) => {
      const status = (data.statuses ?? []).find((s) => s.id === url);
      return { url, reason: status?.error?.tag ?? status?.status ?? "no readable content returned" };
    });
  return { pages, failures, costEstimate: Number((urls.length * EXA_CONTENT_COST).toFixed(4)) };
}

function stripHtml(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return { title: titleMatch ? titleMatch[1]!.trim().slice(0, 300) : null, text };
}

async function fetchViaHttp(url: string, maxChars: number): Promise<FetchedPage | { url: string; reason: string }> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "RadarBot/1.0 (+personal monitoring; respects robots and rate limits)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return { url, reason: `HTTP ${res.status}` };
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html") && !contentType.includes("text")) {
      return { url, reason: `unsupported content type ${contentType}` };
    }
    const html = (await res.text()).slice(0, 400_000);
    const { title, text } = stripHtml(html);
    if (text.length < 200) return { url, reason: "page returned no readable text (likely JS-rendered or blocked)" };
    return {
      url,
      final_url: res.url || url,
      title,
      text: text.slice(0, maxChars),
      fetched_at: new Date().toISOString(),
      via: "http",
    };
  } catch (err) {
    return { url, reason: (err as Error).message.slice(0, 200) };
  }
}

/**
 * Fetch detail pages for a bounded set of URLs.
 * Never invents content: a URL that cannot be read appears in `failures`.
 */
export async function fetchDetailPages(urls: string[], maxChars = 6000): Promise<DetailFetchResult> {
  const targets = Array.from(new Set(urls.filter(isFetchableUrl)));
  const rejected = urls.filter((u) => !isFetchableUrl(u)).map((url) => ({ url, reason: "URL not fetchable" }));
  if (targets.length === 0) return { pages: [], failures: rejected, costEstimate: 0 };

  let pages: FetchedPage[] = [];
  let failures: { url: string; reason: string }[] = [];
  let costEstimate = 0;

  if (process.env["EXA_API_KEY"]) {
    const viaExa = await fetchViaExa(targets, maxChars);
    pages = viaExa.pages;
    failures = viaExa.failures;
    costEstimate = viaExa.costEstimate;
  } else {
    failures = targets.map((url) => ({ url, reason: "no contents provider configured" }));
  }

  // Direct HTTP fallback for whatever the contents provider could not read.
  const retry = failures.map((f) => f.url);
  if (retry.length > 0) {
    const settled = await Promise.all(retry.map((url) => fetchViaHttp(url, maxChars)));
    const stillFailed: { url: string; reason: string }[] = [];
    settled.forEach((result, i) => {
      if ("text" in result) pages.push(result);
      else stillFailed.push({ url: retry[i]!, reason: result.reason });
    });
    failures = stillFailed;
  }

  return { pages, failures: [...failures, ...rejected], costEstimate };
}
