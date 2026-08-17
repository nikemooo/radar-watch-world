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
 * which credential is missing.
 */

export interface SearchDocument {
  title: string;
  url: string;
  snippet: string;
  publisher?: string;
  published_at?: string;
}

export interface SearchProvider {
  id: string;
  label: string;
  /** Name of the environment variable that unlocks this provider. */
  credential: string;
  isConfigured(): boolean;
  search(query: string, limit: number): Promise<SearchDocument[]>;
}

/** Exa — AI-native web search. Set EXA_API_KEY to enable. */
const exaProvider: SearchProvider = {
  id: "exa",
  label: "Exa web search",
  credential: "EXA_API_KEY",
  isConfigured: () => Boolean(process.env["EXA_API_KEY"]),
  async search(query, limit) {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env["EXA_API_KEY"]!,
      },
      body: JSON.stringify({
        query,
        numResults: limit,
        type: "auto",
        contents: { text: { maxCharacters: 1200 } },
      }),
    });
    if (!res.ok) throw new Error(`Exa search failed (${res.status})`);
    const data = (await res.json()) as {
      results?: { title?: string; url: string; text?: string; publishedDate?: string }[];
    };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? r.url,
      url: r.url,
      snippet: (r.text ?? "").slice(0, 1200),
      published_at: r.publishedDate,
    }));
  },
};

/** Brave Search API. Set BRAVE_SEARCH_API_KEY to enable. */
const braveProvider: SearchProvider = {
  id: "brave",
  label: "Brave Search",
  credential: "BRAVE_SEARCH_API_KEY",
  isConfigured: () => Boolean(process.env["BRAVE_SEARCH_API_KEY"]),
  async search(query, limit) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env["BRAVE_SEARCH_API_KEY"]!,
      },
    });
    if (!res.ok) throw new Error(`Brave search failed (${res.status})`);
    const data = (await res.json()) as {
      web?: { results?: { title: string; url: string; description?: string; age?: string }[] };
    };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? "",
      published_at: r.age,
    }));
  },
};

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
  }));
}

/** Runs every query through the active provider and deduplicates by URL. */
export async function researchQueries(
  queries: string[],
  perQuery = 6,
): Promise<{ configured: boolean; provider: string | null; documents: SearchDocument[] }> {
  const provider = activeProvider();
  if (!provider) return { configured: false, provider: null, documents: [] };

  const seen = new Set<string>();
  const documents: SearchDocument[] = [];
  for (const query of queries.slice(0, 5)) {
    const results = await provider.search(query, perQuery);
    for (const doc of results) {
      const key = doc.url.split("#")[0]!;
      if (seen.has(key)) continue;
      seen.add(key);
      documents.push({ ...doc, url: key });
    }
  }
  return { configured: true, provider: provider.id, documents };
}
