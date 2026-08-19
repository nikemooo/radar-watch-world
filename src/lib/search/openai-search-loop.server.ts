/**
 * ISOLATED PROOF-OF-CONCEPT — server-driven multi-step OpenAI Web Search loop.
 *
 * NOT wired into the Radar monitoring engine, Exa, sweeps, checkpoints,
 * scheduler, reaper, findings, billing or any existing UI.
 *
 * The code (not the model) decides how many searches happen:
 *   1. market discovery      -> up to 8 marketplaces
 *   2. one search per marketplace (concurrency 3)
 *   3. detail verification   -> up to 20 candidate listing URLs
 *   4. deduplication
 *   5. criteria evaluation
 *
 * Nothing is fabricated: unverifiable values are null.
 */

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export const LOOP_MODEL = "gpt-4o";

/** Hard POC limits. */
export const LIMITS = {
  maxMarketplaces: 8,
  maxDetailVerifications: 20,
  maxTotalRequests: 28,
  marketplaceConcurrency: 3,
} as const;

/** Pricing used for the cost estimate (USD). */
const PRICE_INPUT_PER_TOKEN = 2.5 / 1_000_000;
const PRICE_OUTPUT_PER_TOKEN = 10 / 1_000_000;
const PRICE_PER_WEB_SEARCH_CALL = 10 / 1000;

export const LOOP_TEST_PROMPT = `Find Rolex Submariner Date 126610LN listings in Sweden.

Requirements:
- Rolex Submariner Date
- reference 126610LN
- Swedish market
- preferably 2018 or newer
- maximum 120,000 SEK
- currently available listings preferred

Find actual listings, not merely category pages.`;

export type UrlType = "listing" | "search_page" | "aggregator" | "unknown";
export type CriterionStatus = "verified" | "probable" | "unknown" | "conflicted" | "rejected";

export interface Marketplace {
  name: string;
  domain: string;
  country: string | null;
  relevance: number;
}

export interface RawHit {
  title: string | null;
  url: string | null;
  url_type: UrlType;
  source: string | null;
  price_hint: number | null;
  currency_hint: string | null;
  note: string | null;
}

export interface DetailRecord {
  title: string | null;
  url: string | null;
  url_type: UrlType;
  source: string | null;
  seller: string | null;
  country: string | null;
  location: string | null;
  price: number | null;
  currency: string | null;
  model: string | null;
  reference: string | null;
  year: number | null;
  condition: string | null;
  color: string | null;
  availability: "available" | "sold" | "reserved" | "unknown";
  image_url: string | null;
  evidence: Record<string, string | null>;
  missing_fields: string[];
}

export interface EvaluatedCandidate extends DetailRecord {
  sources: string[];
  criteria: { key: string; status: CriterionStatus; detail: string | null }[];
  overall: "match" | "partial" | "rejected";
}

export interface StepLog {
  step: string;
  label: string;
  ok: boolean;
  results: number;
  ms: number;
  detail: string | null;
}

export interface LoopTelemetry {
  model: string;
  execution_ms: number;
  api_calls: number;
  market_discovery_calls: number;
  marketplace_search_calls: number;
  detail_verification_calls: number;
  web_search_calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  stopped_early: string | null;
}

export interface LoopResponse {
  ok: boolean;
  configured: boolean;
  error: string | null;
  query: string;
  marketplaces: Marketplace[];
  candidates: EvaluatedCandidate[];
  counts: {
    marketplaces: number;
    raw_hits: number;
    listings: number;
    aggregators: number;
    search_pages: number;
    unique_candidates: number;
    verified_detail: number;
    with_price: number;
    with_image: number;
    with_listing_url: number;
    full_match: number;
    rejected: number;
  };
  sources: string[];
  log: StepLog[];
  telemetry: LoopTelemetry;
}

/* ------------------------------------------------------------------ */
/* Low-level single OpenAI Responses call (streaming SSE, web_search)  */
/* ------------------------------------------------------------------ */

interface CallOutcome<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
  webSearchCalls: number;
  queries: string[];
  inputTokens: number;
  outputTokens: number;
  ms: number;
  quotaError: boolean;
}

async function callResponses<T>(opts: {
  apiKey: string;
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  useWebSearch: boolean;
  signal?: AbortSignal;
}): Promise<CallOutcome<T>> {
  const started = Date.now();
  const base: CallOutcome<T> = {
    ok: false,
    data: null,
    error: null,
    webSearchCalls: 0,
    queries: [],
    inputTokens: 0,
    outputTokens: 0,
    ms: 0,
    quotaError: false,
  };

  let res: Response;
  try {
    res = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: LOOP_MODEL,
        stream: true,
        instructions: opts.instructions,
        input: opts.input,
        ...(opts.useWebSearch ? { tools: [{ type: "web_search" }], tool_choice: "auto" } : {}),
        text: {
          format: { type: "json_schema", name: opts.schemaName, strict: true, schema: opts.schema },
        },
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    return { ...base, error: (err as Error).message, ms: Date.now() - started };
  }

  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    return {
      ...base,
      error: `HTTP ${res.status}: ${detail}`,
      quotaError: res.status === 429 || detail.includes("insufficient_quota"),
      ms: Date.now() - started,
    };
  }

  let text = "";
  let apiError: string | null = null;
  let quota = false;
  let webSearchCalls = 0;
  const queries: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = String(event["type"] ?? "");
        if (type === "response.output_text.delta" && typeof event["delta"] === "string") {
          text += event["delta"];
        } else if (type === "error") {
          const err = event["error"] as Record<string, unknown> | undefined;
          const code = String(err?.["code"] ?? err?.["type"] ?? "unknown");
          apiError = `${code}: ${String(err?.["message"] ?? "")}`;
          if (code.includes("quota") || code.includes("rate_limit")) quota = true;
        } else if (type === "response.output_item.done") {
          const item = event["item"] as Record<string, unknown> | undefined;
          if (item?.["type"] === "web_search_call") {
            webSearchCalls += 1;
            const q = (item["action"] as Record<string, unknown> | undefined)?.["query"];
            if (typeof q === "string" && !queries.includes(q)) queries.push(q);
          }
        } else if (type === "response.completed") {
          const usage = (event["response"] as Record<string, unknown> | undefined)?.["usage"] as
            | Record<string, unknown>
            | undefined;
          if (usage) {
            inputTokens = Number(usage["input_tokens"] ?? 0);
            outputTokens = Number(usage["output_tokens"] ?? 0);
          }
        }
      }
    }
  }

  const out: CallOutcome<T> = {
    ...base,
    webSearchCalls,
    queries,
    inputTokens,
    outputTokens,
    ms: Date.now() - started,
    quotaError: quota,
  };

  if (apiError) return { ...out, error: apiError };

  try {
    return { ...out, ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return { ...out, error: `Invalid JSON from model: ${(err as Error).message}` };
  }
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const marketplaceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    marketplaces: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          domain: { type: "string" },
          country: { type: ["string", "null"] },
          relevance: { type: "number" },
        },
        required: ["name", "domain", "country", "relevance"],
      },
    },
  },
  required: ["marketplaces"],
} as const;

const hitsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    hits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: ["string", "null"] },
          url: { type: ["string", "null"] },
          url_type: { type: "string", enum: ["listing", "search_page", "aggregator", "unknown"] },
          source: { type: ["string", "null"] },
          price_hint: { type: ["number", "null"] },
          currency_hint: { type: ["string", "null"] },
          note: { type: ["string", "null"] },
        },
        required: ["title", "url", "url_type", "source", "price_hint", "currency_hint", "note"],
      },
    },
  },
  required: ["hits"],
} as const;

const detailSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: ["string", "null"] },
    url: { type: ["string", "null"] },
    url_type: { type: "string", enum: ["listing", "search_page", "aggregator", "unknown"] },
    source: { type: ["string", "null"] },
    seller: { type: ["string", "null"] },
    country: { type: ["string", "null"] },
    location: { type: ["string", "null"] },
    price: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    reference: { type: ["string", "null"] },
    year: { type: ["integer", "null"] },
    condition: { type: ["string", "null"] },
    color: { type: ["string", "null"] },
    availability: { type: "string", enum: ["available", "sold", "reserved", "unknown"] },
    image_url: { type: ["string", "null"] },
    evidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        price: { type: ["string", "null"] },
        reference: { type: ["string", "null"] },
        year: { type: ["string", "null"] },
        country: { type: ["string", "null"] },
        availability: { type: ["string", "null"] },
        image: { type: ["string", "null"] },
      },
      required: ["price", "reference", "year", "country", "availability", "image"],
    },
    missing_fields: { type: "array", items: { type: "string" } },
  },
  required: [
    "title",
    "url",
    "url_type",
    "source",
    "seller",
    "country",
    "location",
    "price",
    "currency",
    "model",
    "reference",
    "year",
    "condition",
    "color",
    "availability",
    "image_url",
    "evidence",
    "missing_fields",
  ],
} as const;

/* ------------------------------------------------------------------ */
/* Criteria engine (generic, config-driven)                            */
/* ------------------------------------------------------------------ */

export interface LoopCriteria {
  model?: string;
  reference?: string;
  country?: string;
  minYear?: number;
  maxPrice?: number;
  currency?: string;
  requireAvailable?: boolean;
}

export const ROLEX_CRITERIA: LoopCriteria = {
  model: "Submariner",
  reference: "126610LN",
  country: "Sweden",
  minYear: 2018,
  maxPrice: 120000,
  currency: "SEK",
  requireAvailable: true,
};

function evaluate(d: DetailRecord, c: LoopCriteria): EvaluatedCandidate["criteria"] {
  const out: EvaluatedCandidate["criteria"] = [];
  const norm = (s: string | null) => (s ?? "").toLowerCase();

  if (c.model) {
    const hit = norm(d.model).includes(c.model.toLowerCase()) || norm(d.title).includes(c.model.toLowerCase());
    out.push({ key: `model=${c.model}`, status: hit ? "verified" : d.model ? "rejected" : "unknown", detail: d.model });
  }
  if (c.reference) {
    const ref = c.reference.toLowerCase();
    const hit = norm(d.reference).includes(ref) || norm(d.title).includes(ref);
    out.push({
      key: `reference=${c.reference}`,
      status: hit ? "verified" : d.reference ? "rejected" : "unknown",
      detail: d.reference,
    });
  }
  if (c.country) {
    const hit = norm(d.country).includes(c.country.toLowerCase()) || norm(d.country) === "se";
    out.push({
      key: `country=${c.country}`,
      status: hit ? "verified" : d.country ? "rejected" : "unknown",
      detail: d.country,
    });
  }
  if (c.minYear !== undefined) {
    out.push({
      key: `year>=${c.minYear}`,
      status: d.year === null ? "unknown" : d.year >= c.minYear ? "verified" : "rejected",
      detail: d.year === null ? null : String(d.year),
    });
  }
  if (c.maxPrice !== undefined) {
    const wrongCurrency = d.price !== null && c.currency && d.currency && d.currency !== c.currency;
    out.push({
      key: `price<=${c.maxPrice} ${c.currency ?? ""}`.trim(),
      status:
        d.price === null
          ? "unknown"
          : wrongCurrency
            ? "conflicted"
            : d.price <= c.maxPrice
              ? "verified"
              : "rejected",
      detail: d.price === null ? null : `${d.price} ${d.currency ?? "?"}`,
    });
  }
  if (c.requireAvailable) {
    out.push({
      key: "availability=available",
      status:
        d.availability === "available"
          ? "verified"
          : d.availability === "unknown"
            ? "unknown"
            : "rejected",
      detail: d.availability,
    });
  }
  out.push({
    key: "url_type=listing",
    status: d.url_type === "listing" ? "verified" : "rejected",
    detail: d.url_type,
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function canonical(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

export async function runOpenAiSearchLoop(
  query: string,
  criteria: LoopCriteria = ROLEX_CRITERIA,
  signal?: AbortSignal,
): Promise<LoopResponse> {
  const started = Date.now();
  const log: StepLog[] = [];
  const tel: LoopTelemetry = {
    model: LOOP_MODEL,
    execution_ms: 0,
    api_calls: 0,
    market_discovery_calls: 0,
    marketplace_search_calls: 0,
    detail_verification_calls: 0,
    web_search_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
    stopped_early: null,
  };

  const finish = (partial: Partial<LoopResponse>): LoopResponse => {
    tel.execution_ms = Date.now() - started;
    tel.total_tokens = tel.input_tokens + tel.output_tokens;
    tel.estimated_cost_usd =
      tel.input_tokens * PRICE_INPUT_PER_TOKEN +
      tel.output_tokens * PRICE_OUTPUT_PER_TOKEN +
      tel.web_search_calls * PRICE_PER_WEB_SEARCH_CALL;
    return {
      ok: true,
      configured: true,
      error: null,
      query,
      marketplaces: [],
      candidates: [],
      counts: {
        marketplaces: 0,
        raw_hits: 0,
        listings: 0,
        aggregators: 0,
        search_pages: 0,
        unique_candidates: 0,
        verified_detail: 0,
        with_price: 0,
        with_image: 0,
        with_listing_url: 0,
        full_match: 0,
        rejected: 0,
      },
      sources: [],
      log,
      telemetry: tel,
      ...partial,
    };
  };

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    return { ...finish({}), ok: false, configured: false, error: "OPENAI_API_KEY is not configured." };
  }

  const account = (o: CallOutcome<unknown>) => {
    tel.api_calls += 1;
    tel.web_search_calls += o.webSearchCalls;
    tel.input_tokens += o.inputTokens;
    tel.output_tokens += o.outputTokens;
  };

  /* ---------------- STEP 1: market discovery ---------------- */
  const discovery = await callResponses<{ marketplaces: Marketplace[] }>({
    apiKey,
    instructions:
      "You identify real online marketplaces, dealers and auction houses where the requested item category is sold in the requested geographic market. Use web_search to confirm the sites exist. Return only real domains you verified. No invented sites.",
    input: `${query}\n\nList up to ${LIMITS.maxMarketplaces} real marketplaces/dealers/auction sites where this item is sold in this market, ordered by relevance (1 = best). Include marketplaces, specialised dealers and auction houses.`,
    schemaName: "marketplace_discovery",
    schema: marketplaceSchema,
    useWebSearch: true,
    ...(signal ? { signal } : {}),
  });
  account(discovery);
  tel.market_discovery_calls += 1;
  log.push({
    step: "discovery",
    label: "Market discovery",
    ok: discovery.ok,
    results: discovery.data?.marketplaces.length ?? 0,
    ms: discovery.ms,
    detail: discovery.error,
  });

  if (!discovery.ok || !discovery.data) {
    tel.stopped_early = discovery.quotaError ? "quota/rate limit" : "market discovery failed";
    return { ...finish({}), ok: false, error: discovery.error ?? "Market discovery failed." };
  }

  const marketplaces = discovery.data.marketplaces
    .filter((m) => m.domain)
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
    .slice(0, LIMITS.maxMarketplaces);

  /* ---------------- STEP 2: search each marketplace ---------------- */
  const budgetForSearches = Math.min(
    marketplaces.length,
    LIMITS.maxTotalRequests - tel.api_calls - 1,
  );
  const searchTargets = marketplaces.slice(0, Math.max(0, budgetForSearches));

  const hitLists = await mapWithConcurrency(searchTargets, LIMITS.marketplaceConcurrency, async (m) => {
    const out = await callResponses<{ hits: RawHit[] }>({
      apiKey,
      instructions:
        "You run ONE targeted web search on a single website and report the individual item/listing pages you actually saw. Classify each URL honestly: 'listing' only for a single item/product/advert page; 'search_page' for search or category results; 'aggregator' for a hub/index page. Never turn a category URL into a listing. Return full absolute https URLs, never citation ids. Never invent URLs or prices.",
      input: `Search the site ${m.domain} for: ${query}\n\nUse queries like "site:${m.domain} <model> <reference>" and the local-language equivalent. Return every individual listing page you found (up to 10), plus any category/search pages you had to go through.`,
      schemaName: "marketplace_hits",
      schema: hitsSchema,
      useWebSearch: true,
      ...(signal ? { signal } : {}),
    });
    account(out);
    tel.marketplace_search_calls += 1;
    log.push({
      step: "search",
      label: m.name || m.domain,
      ok: out.ok,
      results: out.data?.hits.length ?? 0,
      ms: out.ms,
      detail: out.error,
    });
    return out;
  });

  const rawHits: RawHit[] = [];
  for (const r of hitLists) if (r?.data) rawHits.push(...r.data.hits);
  const quotaHit = hitLists.some((r) => r?.quotaError);
  if (quotaHit) tel.stopped_early = "quota/rate limit during marketplace searches";

  const withUrl = rawHits.filter((h) => typeof h.url === "string" && /^https?:\/\//i.test(h.url));
  const listings = withUrl.filter((h) => h.url_type === "listing");
  const aggregators = withUrl.filter((h) => h.url_type === "aggregator");
  const searchPages = withUrl.filter((h) => h.url_type === "search_page");

  /* ---------------- STEP 3: detail verification ---------------- */
  const seenUrls = new Set<string>();
  const uniqueListingUrls: RawHit[] = [];
  for (const h of listings) {
    const key = canonical(h.url as string);
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    uniqueListingUrls.push(h);
  }

  const detailBudget = Math.min(
    LIMITS.maxDetailVerifications,
    Math.max(0, LIMITS.maxTotalRequests - tel.api_calls),
    uniqueListingUrls.length,
  );
  if (detailBudget < uniqueListingUrls.length && !tel.stopped_early) {
    tel.stopped_early = `detail verification capped at ${detailBudget} of ${uniqueListingUrls.length} listings`;
  }

  const details = await mapWithConcurrency(
    uniqueListingUrls.slice(0, detailBudget),
    LIMITS.marketplaceConcurrency,
    async (h) => {
      if (tel.stopped_early?.startsWith("quota")) return null;
      const out = await callResponses<DetailRecord>({
        apiKey,
        instructions:
          "You verify ONE listing page. Use web_search to open and read the page. Report only values visible on that page. Unknown values are null and listed in missing_fields. image_url must be a real image URL observed on the page, otherwise null. availability reflects whether the item is still for sale. Never invent values.",
        input: `Open and verify this listing: ${h.url}\n\nExtract: exact title, price, currency, model, reference number, year, condition, colour, country, city, seller, availability (available/sold/reserved), image URL, and the canonical listing URL.`,
        schemaName: "listing_detail",
        schema: detailSchema,
        useWebSearch: true,
        ...(signal ? { signal } : {}),
      });
      account(out);
      tel.detail_verification_calls += 1;
      log.push({
        step: "detail",
        label: h.title ?? (h.url as string),
        ok: out.ok,
        results: out.ok ? 1 : 0,
        ms: out.ms,
        detail: out.error,
      });
      if (out.quotaError) tel.stopped_early = "quota/rate limit during detail verification";
      if (!out.data) return null;
      return { ...out.data, url: out.data.url ?? h.url, source: out.data.source ?? h.source };
    },
  );

  /* ---------------- STEP 4: deduplication ---------------- */
  const byKey = new Map<string, EvaluatedCandidate>();
  for (const d of details) {
    if (!d) continue;
    const key = d.url
      ? canonical(d.url)
      : `${(d.reference ?? "").toLowerCase()}|${(d.title ?? "").toLowerCase()}|${d.source ?? ""}|${d.price ?? ""}`;
    const existing = byKey.get(key);
    if (existing) {
      if (d.url && !existing.sources.includes(d.url)) existing.sources.push(d.url);
      continue;
    }
    const criteriaResult = evaluate(d, criteria);
    const overall: EvaluatedCandidate["overall"] = criteriaResult.some((c) => c.status === "rejected")
      ? "rejected"
      : criteriaResult.every((c) => c.status === "verified")
        ? "match"
        : "partial";
    byKey.set(key, {
      ...d,
      sources: d.url ? [d.url] : [],
      criteria: criteriaResult,
      overall: d.price === null && overall === "match" ? "partial" : overall,
    });
  }

  const candidates = [...byKey.values()];
  const sources = [
    ...new Set(
      withUrl
        .map((h) => h.url as string)
        .concat(candidates.flatMap((c) => c.sources)),
    ),
  ];

  return finish({
    marketplaces,
    candidates,
    sources,
    counts: {
      marketplaces: marketplaces.length,
      raw_hits: rawHits.length,
      listings: listings.length,
      aggregators: aggregators.length,
      search_pages: searchPages.length,
      unique_candidates: candidates.length,
      verified_detail: candidates.filter((c) => c.criteria.some((k) => k.status === "verified")).length,
      with_price: candidates.filter((c) => c.price !== null).length,
      with_image: candidates.filter((c) => c.image_url !== null).length,
      with_listing_url: candidates.filter((c) => c.url_type === "listing" && !!c.url).length,
      full_match: candidates.filter((c) => c.overall === "match").length,
      rejected: candidates.filter((c) => c.overall === "rejected").length,
    },
  });
}
