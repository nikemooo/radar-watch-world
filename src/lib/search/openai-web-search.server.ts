/**
 * ISOLATED PROOF-OF-CONCEPT — OpenAI Responses API + built-in Web Search.
 *
 * This module is NOT wired into the Radar monitoring engine, scheduler,
 * checkpoints, reaper or any existing sweep. It exists only so we can measure
 * whether OpenAI's hosted web_search tool could replace/complement the current
 * Exa-based discovery layer.
 *
 * Nothing here fabricates data: if OPENAI_API_KEY is missing we report that
 * explicitly instead of returning mock results.
 */

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

/** Current OpenAI model exposing the hosted `web_search` tool. */
export const WEB_SEARCH_MODEL = "gpt-4o";

export interface PocCandidate {
  title: string | null;
  url: string | null;
  url_type: "listing" | "search_page" | "aggregator" | "unknown";
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
  image_url: string | null;
  evidence: {
    model: string | null;
    reference: string | null;
    country: string | null;
    price: string | null;
    year: string | null;
    image: string | null;
  };
  missing_fields: string[];
  confidence: "verified" | "probable" | "unknown";
}

export interface PocResult {
  query: string;
  search_completed: boolean;
  candidates: PocCandidate[];
  sources: string[];
  notes: string | null;
}

export interface PocTelemetry {
  model: string;
  response_id: string | null;
  web_search_calls: number;
  web_search_queries: string[];
  execution_ms: number;
  usage: Record<string, unknown> | null;
  /** Raw text the model emitted, kept for transparency when parsing fails. */
  raw_text_length: number;
  parse_error: string | null;
}

export interface PocRunResponse {
  ok: boolean;
  configured: boolean;
  error: string | null;
  result: PocResult | null;
  telemetry: PocTelemetry;
}

const candidateSchema = {
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
    image_url: { type: ["string", "null"] },
    evidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        model: { type: ["string", "null"] },
        reference: { type: ["string", "null"] },
        country: { type: ["string", "null"] },
        price: { type: ["string", "null"] },
        year: { type: ["string", "null"] },
        image: { type: ["string", "null"] },
      },
      required: ["model", "reference", "country", "price", "year", "image"],
    },
    missing_fields: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["verified", "probable", "unknown"] },
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
    "image_url",
    "evidence",
    "missing_fields",
    "confidence",
  ],
} as const;

const resultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string" },
    search_completed: { type: "boolean" },
    candidates: { type: "array", items: candidateSchema },
    sources: { type: "array", items: { type: "string" } },
    notes: { type: ["string", "null"] },
  },
  required: ["query", "search_completed", "candidates", "sources", "notes"],
} as const;

const SYSTEM_PROMPT = [
  "You are Radar's discovery engine under evaluation.",
  "You MUST use the web_search tool extensively before answering — never answer from memory.",
  "Run several distinct searches, including searches targeted at local-market sources and local language.",
  "Only report items you actually opened or saw in search results. Never invent a value.",
  "If a value cannot be verified from a real source, set it to null, list it in missing_fields and explain in evidence why it is unknown.",
  "country must be the market of the listing itself. If the market cannot be verified, use null (unknown) — never guess a country.",
  "url must be the exact item/listing page when one was identified; set url_type accordingly ('listing', 'aggregator', or 'search_page').",
  "Never present a generic search/category page as a listing URL.",
  "image_url must be a real image URL observed on the source page or in search results — never a placeholder or invented URL. Otherwise null.",
  "sources must list every URL you actually used.",
].join(" ");

export const ROLEX_TEST_PROMPT = `Find Rolex Submariner Date 126610LN listings in Sweden.

Requirements:
- Rolex Submariner Date
- Reference 126610LN
- Sweden / Swedish market
- Prefer listings from Sweden
- Prefer model year 2018 or newer
- Maximum price 120,000 SEK

Search the web extensively enough to find multiple real listings.
For every candidate return: title, exact listing URL, source/domain, seller if available, country, location if available, price, currency, model/reference, year if available, condition if available, image URL if available.
Do not invent missing values. If a value cannot be verified, return null and explain why.
Prefer the original listing page over aggregators. Return the sources used for each result.`;

interface SseAccumulator {
  text: string;
  responseId: string | null;
  usage: Record<string, unknown> | null;
  webSearchCalls: number;
  webSearchQueries: string[];
  error: { type: string; message: string; code: string | null } | null;
}

function handleEvent(acc: SseAccumulator, event: Record<string, unknown>) {
  const type = String(event["type"] ?? "");
  if (type === "response.output_text.delta" && typeof event["delta"] === "string") {
    acc.text += event["delta"];
  }
  if (type === "error") {
    const err = event["error"] as Record<string, unknown> | undefined;
    if (err) {
      acc.error = {
        type: String(err["type"] ?? "unknown"),
        message: String(err["message"] ?? ""),
        code: err["code"] ? String(err["code"]) : null,
      };
    }
  }
  if (type === "response.created" || type === "response.completed") {
    const response = event["response"] as Record<string, unknown> | undefined;
    if (response) {
      if (typeof response["id"] === "string") acc.responseId = response["id"];
      if (response["usage"]) acc.usage = response["usage"] as Record<string, unknown>;
      const output = response["output"] as Record<string, unknown>[] | undefined;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item["type"] === "web_search_call") {
            const action = item["action"] as Record<string, unknown> | undefined;
            const q = action?.["query"];
            if (typeof q === "string" && !acc.webSearchQueries.includes(q)) acc.webSearchQueries.push(q);
          }
        }
      }
    }
  }
  if (type === "response.output_item.done") {
    const item = event["item"] as Record<string, unknown> | undefined;
    if (item?.["type"] === "web_search_call") {
      acc.webSearchCalls += 1;
      const action = item["action"] as Record<string, unknown> | undefined;
      const q = action?.["query"];
      if (typeof q === "string" && !acc.webSearchQueries.includes(q)) acc.webSearchQueries.push(q);
    }
  }
}

export async function runOpenAiWebSearchPoc(
  prompt: string,
  signal?: AbortSignal,
): Promise<PocRunResponse> {
  const started = Date.now();
  const apiKey = process.env["OPENAI_API_KEY"];
  const emptyTelemetry: PocTelemetry = {
    model: WEB_SEARCH_MODEL,
    response_id: null,
    web_search_calls: 0,
    web_search_queries: [],
    execution_ms: 0,
    usage: null,
    raw_text_length: 0,
    parse_error: null,
  };

  if (!apiKey) {
    return {
      ok: false,
      configured: false,
      error: "OPENAI_API_KEY is not configured on the server. No fallback or mock data is produced.",
      result: null,
      telemetry: emptyTelemetry,
    };
  }

  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: WEB_SEARCH_MODEL,
      stream: true,
      instructions: SYSTEM_PROMPT,
      input: prompt,
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      text: {
        format: {
          type: "json_schema",
          name: "radar_web_search_poc",
          strict: true,
          schema: resultSchema,
        },
      },
    }),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 800);
    return {
      ok: false,
      configured: true,
      error: `OpenAI Responses API failed (${res.status}): ${detail}`,
      result: null,
      telemetry: { ...emptyTelemetry, execution_ms: Date.now() - started },
    };
  }

  const acc: SseAccumulator = {
    text: "",
    responseId: null,
    usage: null,
    webSearchCalls: 0,
    webSearchQueries: [],
  };

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
        try {
          handleEvent(acc, JSON.parse(payload) as Record<string, unknown>);
        } catch {
          /* ignore non-JSON keepalives */
        }
      }
    }
  }

  const telemetry: PocTelemetry = {
    model: WEB_SEARCH_MODEL,
    response_id: acc.responseId,
    web_search_calls: acc.webSearchCalls,
    web_search_queries: acc.webSearchQueries,
    execution_ms: Date.now() - started,
    usage: acc.usage,
    raw_text_length: acc.text.length,
    parse_error: null,
  };

  console.info(
    `[poc:openai-web-search] model=${WEB_SEARCH_MODEL} searches=${acc.webSearchCalls} ms=${telemetry.execution_ms} queries=${JSON.stringify(acc.webSearchQueries)}`,
  );

  let parsed: PocResult | null = null;
  try {
    parsed = JSON.parse(acc.text) as PocResult;
  } catch (err) {
    telemetry.parse_error = `Model output was not valid JSON: ${(err as Error).message}`;
  }

  return {
    ok: parsed !== null,
    configured: true,
    error: parsed ? null : (telemetry.parse_error ?? "Empty response from OpenAI."),
    result: parsed,
    telemetry,
  };
}
