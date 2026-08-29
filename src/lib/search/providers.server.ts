/**
 * Search layer.
 *
 * Radar's research is provider-driven so new data sources (listing APIs,
 * market data, flight pricing, job boards) can be added without touching
 * the monitoring engine. A provider takes queries and returns normalized
 * documents with real, verifiable URLs.
 *
 * IMPORTANT: no provider may invent sources. If no provider is configured,
 * research reports `configured: false` and the UI tells the user exactly
 * which credential is missing. Mock/synthetic results are never produced.
 *
 * The Exa API key is read from the server-only environment inside the
 * request path — it is never sent to the browser, stored in the database,
 * or written to logs.
 */

export interface SearchDocument {
  title: string;
  url: string;
  snippet: string;
  publisher?: string | undefined;
  published_at?: string | undefined;
  /** Last-updated timestamp, when the provider reports one. */
  updated_at?: string | undefined;
  /** ISO timestamp of when this document was retrieved from the provider. */
  retrieved_at: string;
  /** The query that produced this document. */
  query: string;
  /** URLs the provider found on the page — real candidate detail links. */
  links?: string[] | undefined;
}

export interface SearchProvider {
  id: string;
  label: string;
  /** Name of the environment variable that unlocks this provider. */
  credential: string;
  /** Rough cost in USD per search request, used for admin cost estimates. */
  costPerRequest: number;
  isConfigured(): boolean;
  search(query: string, limit: number): Promise<SearchDocument[]>;
}

export class SearchProviderError extends Error {
  status: number;
  retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SearchProviderError";
    this.status = status;
    this.retryable = status === 429 || status === 408 || status >= 500 || status === 0;
  }
}

const SEARCH_TIMEOUT_MS = 30_000;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Exa — AI-native web search. Primary research provider. Set EXA_API_KEY. */
const exaProvider: SearchProvider = {
  id: "exa",
  label: "Exa web search",
  credential: "EXA_API_KEY",
  costPerRequest: 0.005,
  isConfigured: () => Boolean(process.env["EXA_API_KEY"]),
  async search(query, limit) {
    const retrieved_at = new Date().toISOString();
    let res: Response;
    try {
      res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env["EXA_API_KEY"]!,
        },
        body: JSON.stringify({
          query,
          numResults: limit,
          type: "auto",
          // Index/aggregator pages need width: a 1500-char snippet with 25
          // links hides most of the items such a page actually lists.
          contents: { text: { maxCharacters: 5000 }, extras: { links: 60 } },
        }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SearchProviderError(0, `Exa request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new SearchProviderError(res.status, `Exa search failed (${res.status}) ${detail}`);
    }
    const data = (await res.json()) as {
      results?: {
        title?: string;
        url: string;
        text?: string;
        summary?: string;
        publishedDate?: string;
        author?: string;
        extras?: { links?: string[] };
      }[];
    };
    return (data.results ?? [])
      .filter((r) => typeof r.url === "string" && r.url.startsWith("http"))
      .map((r) => ({
        title: r.title ?? r.url,
        url: r.url,
        snippet: (r.text ?? r.summary ?? "").slice(0, 5000),
        publisher: r.author ?? hostOf(r.url),
        published_at: r.publishedDate,
        retrieved_at,
        query,
        links: (r.extras?.links ?? []).filter((l) => typeof l === "string" && l.startsWith("http")),
      }));
  },
};

/** Brave Search API — optional fallback. Set BRAVE_SEARCH_API_KEY to enable. */
const braveProvider: SearchProvider = {
  id: "brave",
  label: "Brave Search (fallback)",
  credential: "BRAVE_SEARCH_API_KEY",
  costPerRequest: 0.003,
  isConfigured: () => Boolean(process.env["BRAVE_SEARCH_API_KEY"]),
  async search(query, limit) {
    const retrieved_at = new Date().toISOString();
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": process.env["BRAVE_SEARCH_API_KEY"]!,
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SearchProviderError(0, `Brave request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new SearchProviderError(res.status, `Brave search failed (${res.status})`);
    }
    const data = (await res.json()) as {
      web?: {
        results?: { title: string; url: string; description?: string; age?: string; profile?: { name?: string } }[];
      };
    };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? "",
      publisher: r.profile?.name ?? hostOf(r.url),
      published_at: r.age,
      retrieved_at,
      query,
    }));
  },
};

/**
 * OpenAI hosted web search — discovery FALLBACK only.
 *
 * Never used while Exa answers, so it adds no cost to a normal sweep. It
 * returns only URLs the model actually cited from its web_search tool; nothing
 * is invented, and every result still goes through the candidate gate.
 */
const openAiProvider: SearchProvider = {
  id: "openai-web-search",
  label: "OpenAI web search (fallback)",
  credential: "OPENAI_API_KEY",
  costPerRequest: 0.03,
  isConfigured: () => Boolean(process.env["OPENAI_API_KEY"]),
  async search(query, limit) {
    const retrieved_at = new Date().toISOString();
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env["OPENAI_API_KEY"]!}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          tools: [{ type: "web_search" }],
          tool_choice: "required",
          input:
            `Search the live web for: ${query}\n` +
            `Return up to ${limit} concrete result pages. For each, give the exact page URL and its title. ` +
            `Do not invent URLs — only report pages the search tool actually returned.`,
        }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SearchProviderError(0, `OpenAI web search request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new SearchProviderError(res.status, `OpenAI web search failed (${res.status}) ${detail}`);
    }
    const data = (await res.json()) as {
      output?: {
        type?: string;
        content?: {
          type?: string;
          text?: string;
          annotations?: { type?: string; url?: string; title?: string; start_index?: number; end_index?: number }[];
        }[];
      }[];
    };

    const documents = new Map<string, SearchDocument>();
    for (const item of data.output ?? []) {
      for (const content of item.content ?? []) {
        const text = content.text ?? "";
        for (const annotation of content.annotations ?? []) {
          if (annotation.type !== "url_citation" || !annotation.url?.startsWith("http")) continue;
          const url = annotation.url.split("#")[0]!;
          if (documents.has(url)) continue;
          documents.set(url, {
            title: annotation.title ?? url,
            url,
            snippet: text.slice(0, 2000),
            publisher: hostOf(url),
            retrieved_at,
            query,
          });
        }
      }
    }
    return [...documents.values()].slice(0, limit);
  },
};

/**
 * DuckDuckGo HTML endpoint — keyless last-resort discovery. No credential is
 * required, so Radar keeps a working discovery path even when every paid
 * provider is exhausted. Results are plain organic web results.
 */
const duckDuckGoProvider: SearchProvider = {
  id: "duckduckgo",
  label: "DuckDuckGo (last-resort fallback)",
  credential: "(none)",
  costPerRequest: 0,
  isConfigured: () => true,
  async search(query, limit) {
    const retrieved_at = new Date().toISOString();
    let res: Response;
    try {
      res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (compatible; RadarBot/1.0)",
        },
        body: new URLSearchParams({ q: query }).toString(),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SearchProviderError(0, `DuckDuckGo request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new SearchProviderError(res.status, `DuckDuckGo search failed (${res.status})`);
    const html = await res.text();
    return parseDuckDuckGoHtml(html, query, limit, retrieved_at);
  },
};

const stripTags = (value: string) =>
  value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

/** Exported for tests: turn the DDG HTML result list into real documents. */
export function parseDuckDuckGoHtml(
  html: string,
  query: string,
  limit: number,
  retrieved_at = new Date().toISOString(),
): SearchDocument[] {
  const out: SearchDocument[] = [];
  const seen = new Set<string>();
  const anchor = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) && out.length < limit) {
    let href = match[1]!.replace(/&amp;/g, "&");
    if (href.startsWith("//")) href = `https:${href}`;
    try {
      const parsed = new URL(href, "https://duckduckgo.com");
      const redirected = parsed.searchParams.get("uddg");
      const url = (redirected ?? parsed.toString()).split("#")[0]!;
      if (!url.startsWith("http") || url.includes("duckduckgo.com")) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        title: stripTags(match[2]!) || url,
        url,
        snippet: "",
        publisher: hostOf(url),
        retrieved_at,
        query,
      });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Discovery chain, in priority order. Exa stays primary; the rest are only
 * reached when the one before it fails or is in cooldown.
 */
const providers: SearchProvider[] = [exaProvider, braveProvider, openAiProvider, duckDuckGoProvider];

export const discoveryCooldowns = new ProviderCooldowns();

export function activeProvider(): SearchProvider | null {
  return providers.find((p) => p.isConfigured()) ?? null;
}

export function providerStatus() {
  const cooling = new Map(discoveryCooldowns.snapshot().map((c) => [c.provider, c.secondsRemaining]));
  return providers.map((p) => ({
    id: p.id,
    label: p.label,
    credential: p.credential,
    configured: p.isConfigured(),
    primary: p.id === "exa",
    cooldownSeconds: cooling.get(p.id) ?? 0,
  }));
}


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One search with bounded retries for rate limits and transient failures. */
async function searchWithRetry(
  provider: SearchProvider,
  query: string,
  limit: number,
  attempts = 3,
): Promise<SearchDocument[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await provider.search(query, limit);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof SearchProviderError ? err.retryable : false;
      if (!retryable || attempt === attempts) break;
      const backoff = 500 * 2 ** (attempt - 1);
      console.warn(
        `[radar:search] ${provider.id} attempt ${attempt} failed (${
          err instanceof SearchProviderError ? err.status : "unknown"
        }), retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
  throw lastError;
}

export interface ResearchResult {
  configured: boolean;
  provider: string | null;
  documents: SearchDocument[];
  /** Telemetry for admin observability and cost estimates. */
  requests: number;
  successes: number;
  failures: number;
  costEstimate: number;
  /** Raw results returned by the provider before URL de-duplication. */
  rawResults: number;
  duplicatesRemoved: number;
  errors: string[];
  /** Every provider touched this call, with its outcome. */
  attempts?: ProviderAttempt[];
  /** True when the primary provider could not answer and another one did. */
  fallbackUsed?: boolean;
  /**
   * True when every configured discovery provider failed. Zero documents then
   * means "discovery could not run", never "the market is empty".
   */
  discoveryFailed?: boolean;
}

/**
 * Runs every query through the discovery chain and deduplicates by URL.
 *
 * The chain stops at the first provider that answers, so a healthy Exa means
 * exactly one paid request per query — identical to previous behaviour.
 */
export async function researchQueries(
  queries: string[],
  perQuery = 8,
  maxQueries = 8,
): Promise<ResearchResult> {
  const chain = providers.filter((p) => p.isConfigured());
  if (chain.length === 0) {
    return {
      configured: false,
      provider: null,
      documents: [],
      requests: 0,
      successes: 0,
      failures: 0,
      costEstimate: 0,
      rawResults: 0,
      duplicatesRemoved: 0,
      errors: [],
    };
  }

  const seen = new Set<string>();
  const documents: SearchDocument[] = [];
  const errors: string[] = [];
  const attempts: ProviderAttempt[] = [];
  let requests = 0;
  let successes = 0;
  let failures = 0;
  let rawResults = 0;
  let duplicates = 0;
  let cost = 0;
  let fallbackUsed = false;
  let answeringProvider: string | null = null;
  let allFailed = 0;

  for (const query of queries.slice(0, maxQueries)) {
    requests += 1;
    console.info(`[radar:search] query -> ${query}`);
    const outcome = await searchWithFailover<SearchDocument>({
      providers: chain,
      query,
      limit: perQuery,
      cooldowns: discoveryCooldowns,
      execute: (provider, q, limit) => searchWithRetry(provider as SearchProvider, q, limit),
    });
    attempts.push(...outcome.attempts);
    cost += outcome.cost;
    for (const attempt of outcome.attempts) {
      if (attempt.status === "failed") {
        errors.push(`${query}: [${attempt.errorClass}] ${attempt.provider}: ${attempt.message ?? ""}`.trim());
      }
    }

    if (!outcome.provider) {
      failures += 1;
      allFailed += 1;
      console.error(`[radar:discovery] all providers failed for query "${query.slice(0, 120)}"`);
      continue;
    }
    successes += 1;
    answeringProvider = outcome.provider;
    if (outcome.fallbackUsed) fallbackUsed = true;
    rawResults += outcome.documents.length;
    console.info(
      `[radar:discovery] results_before_gate=${outcome.documents.length} provider=${outcome.provider}`,
    );
    for (const doc of outcome.documents) {
      const key = doc.url.split("#")[0]!;
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      documents.push({ ...doc, url: key });
    }
  }

  console.info(
    `[radar:discovery] duplicates_removed=${duplicates} documents=${documents.length} fallback_triggered=${fallbackUsed} fallback_provider=${fallbackUsed ? answeringProvider : "none"}`,
  );

  return {
    configured: true,
    provider: answeringProvider ?? chain[0]!.id,
    documents,
    requests,
    successes,
    failures,
    costEstimate: Number(cost.toFixed(4)),
    rawResults,
    duplicatesRemoved: duplicates,
    errors,
    attempts,
    fallbackUsed,
    discoveryFailed: successes === 0 && allFailed > 0,
  };
}

