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
          contents: { text: { maxCharacters: 1500 }, extras: { links: 25 } },
        }),
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
        snippet: (r.text ?? r.summary ?? "").slice(0, 1500),
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

/** Exa is primary; Brave is only used when Exa is not configured. */
const providers: SearchProvider[] = [exaProvider, braveProvider];

export function activeProvider(): SearchProvider | null {
  return providers.find((p) => p.isConfigured()) ?? null;
}

export function providerStatus() {
  return providers.map((p) => ({
    id: p.id,
    label: p.label,
    credential: p.credential,
    configured: p.isConfigured(),
    primary: p.id === "exa",
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
}

/** Runs every query through the active provider and deduplicates by URL. */
export async function researchQueries(queries: string[], perQuery = 8): Promise<ResearchResult> {
  const provider = activeProvider();
  if (!provider) {
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
  let requests = 0;
  let successes = 0;
  let failures = 0;
  let rawResults = 0;
  let duplicates = 0;

  for (const query of queries.slice(0, 5)) {
    requests += 1;
    try {
      const results = await searchWithRetry(provider, query, perQuery);
      successes += 1;
      rawResults += results.length;
      for (const doc of results) {
        const key = doc.url.split("#")[0]!;
        if (seen.has(key)) {
          duplicates += 1;
          continue;
        }
        seen.add(key);
        documents.push({ ...doc, url: key });
      }
    } catch (err) {
      failures += 1;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${query}: ${message}`);
      console.error(`[radar:search] ${provider.id} query failed — ${message}`);
    }
  }

  return {
    configured: true,
    provider: provider.id,
    documents,
    requests,
    successes,
    failures,
    costEstimate: Number((requests * provider.costPerRequest).toFixed(4)),
    rawResults,
    duplicatesRemoved: duplicates,
    errors,
  };
}
