/**
 * Market Impact — world-event discovery and analysis.
 *
 * This is the second half of a market radar: the numeric layer says WHAT the
 * value is, this layer says WHAT HAPPENED that could move it. It reuses the
 * existing pluggable search layer (Exa → Brave → OpenAI → DuckDuckGo) and the
 * AI gateway; it never invents a source and never stores a claim without the
 * URLs it came from.
 *
 * Pipeline: queries → documents → recency filter → clustering (duplicate
 * coverage collapses into one event) → one batched AI pass that separates
 * FACT from INTERPRETATION and scores significance/relevance → correlation
 * against the radar's own observation series.
 */
import { chatJson, MODELS } from "../ai/gateway.server";
import { researchQueries } from "../search/providers.server";
import {
  asSeverity,
  clusterDocuments,
  correlateEvent,
  type CorrelationPoint,
  type EventCluster,
  type EventCorrelation,
  type EventSeverity,
  type EventSource,
} from "./events";
import type { MarketMonitorSpec } from "./types";

export interface ImpactEvent {
  key: string;
  title: string;
  /** Verifiable, source-backed statement of what happened. No speculation. */
  factSummary: string;
  /** Explicitly labelled AI interpretation of why it matters for this instrument. */
  aiAnalysis: string;
  severity: EventSeverity;
  /** 0-1 — how much this event bears on THIS instrument. */
  relevance: number;
  confidence: number;
  categories: string[];
  sources: EventSource[];
  publishedAt: string | null;
  correlation: EventCorrelation;
}

export interface EventDiscovery {
  events: ImpactEvent[];
  /** Telemetry for run rows and admin cost views. */
  queries: string[];
  documents: number;
  clusters: number;
  provider: string | null;
  searchRequests: number;
  searchFailures: number;
  costEstimate: number;
  discoveryFailed: boolean;
}

const MAX_QUERIES = 4;
const RESULTS_PER_QUERY = 8;
const MAX_CLUSTERS_ANALYZED = 12;

/**
 * Queries for the event sweep. The impact profile drives it when the AI
 * produced one; otherwise the instrument's own name is enough to find the
 * news that concerns it. Nothing here is hardcoded per asset.
 */
export function buildEventQueries(spec: MarketMonitorSpec, rawRequest?: string | null): string[] {
  const inst = spec.instrument;
  const subject = inst.name || inst.symbol;
  const out: string[] = [];
  const push = (q: string) => {
    const clean = q.trim().replace(/\s+/g, " ");
    if (clean && !out.some((existing) => existing.toLowerCase() === clean.toLowerCase())) out.push(clean);
  };

  for (const q of spec.impact?.queries ?? []) push(q);
  for (const topic of spec.impact?.topics ?? []) push(`${subject} ${topic} news`);
  for (const entity of spec.impact?.entities ?? []) push(`${entity} ${subject} latest news`);

  push(`${subject} price news today`);
  push(`what is moving ${subject} market analysis`);
  if (rawRequest && out.length < MAX_QUERIES) push(rawRequest);

  return out.slice(0, MAX_QUERIES);
}

const analysisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "headline",
          "fact_summary",
          "ai_analysis",
          "severity",
          "relevance",
          "confidence",
          "categories",
        ],
        properties: {
          key: { type: "string" },
          headline: { type: "string" },
          fact_summary: { type: "string" },
          ai_analysis: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          relevance: { type: "number" },
          confidence: { type: "number" },
          categories: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

interface AnalyzedEvent {
  key: string;
  headline: string;
  fact_summary: string;
  ai_analysis: string;
  severity: string;
  relevance: number;
  confidence: number;
  categories: string[];
}

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, n));
}

function clusterBlock(clusters: EventCluster[]): string {
  return clusters
    .map(
      (c) =>
        `KEY: ${c.key}\nHEADLINE: ${c.title}\nPUBLISHED: ${c.published_at ?? "unknown"}\nOUTLETS: ${c.sources
          .map((s) => s.publisher ?? s.url)
          .join(", ")}\nEXCERPT: ${c.text.slice(0, 1800)}`,
    )
    .join("\n\n---\n\n");
}

/** One batched AI pass over the clusters — fact, interpretation, significance. */
async function analyzeClusters(
  clusters: EventCluster[],
  spec: MarketMonitorSpec,
  rawRequest: string | null,
): Promise<Map<string, AnalyzedEvent>> {
  const inst = spec.instrument;
  const result = await chatJson<{ events: AnalyzedEvent[] }>({
    model: MODELS.fast,
    schemaName: "market_impact_events",
    schema: analysisSchema,
    system:
      "You analyse world events for a market monitoring product. For each candidate event you receive a headline, " +
      "a publication date and an excerpt from real published sources. Return one object per event, reusing the given KEY verbatim.\n" +
      "fact_summary: ONLY what the sources actually state — the concrete happening, named actors, numbers and dates. " +
      "One or two sentences. Never speculate, never add context that is not in the excerpt, never use hedging words.\n" +
      "ai_analysis: your own interpretation of why this could matter for the instrument being monitored — transmission " +
      "mechanism, what to watch next. This is explicitly labelled as AI interpretation in the product, so it may reason, " +
      "but it must never be presented as fact and must never invent numbers.\n" +
      "severity: how significant the event itself is in the world — 'low' routine coverage or commentary, 'medium' a real " +
      "development with limited reach, 'high' a major development (central bank decision, major sanctions, large supply " +
      "shock, big earnings surprise), 'critical' a rare, system-level event (war outbreak, default, emergency rate move).\n" +
      "relevance: 0-1, how directly the event bears on THIS instrument specifically. Generic market commentary that only " +
      "mentions the instrument in passing is below 0.3. A decision that directly prices it is above 0.8.\n" +
      "confidence: 0-1, how well the sources support the fact_summary.\n" +
      "categories: 1-3 short lowercase slugs such as monetary_policy, geopolitics, supply, demand, regulation, earnings, " +
      "energy, conflict, macro_data.\n" +
      "Drop nothing: return an entry for every KEY you were given. Answer in the language of the user's request.",
    user:
      `INSTRUMENT: ${inst.name} (${inst.symbol}), kind ${inst.kind}, metric ${inst.metric}` +
      `${inst.currency ? `, quoted in ${inst.currency}` : ""}\n` +
      (spec.impact?.topics.length ? `USER CARES ABOUT: ${spec.impact.topics.join("; ")}\n` : "") +
      (rawRequest ? `ORIGINAL REQUEST: ${rawRequest}\n` : "") +
      `\nCANDIDATE EVENTS:\n\n${clusterBlock(clusters)}`,
  });
  const map = new Map<string, AnalyzedEvent>();
  for (const event of result.events ?? []) {
    if (event && typeof event.key === "string") map.set(event.key, event);
  }
  return map;
}

/**
 * Discover and analyse the world events that could move this instrument.
 * `knownKeys` are events the radar already stored — they are dropped before
 * the AI pass so a sweep only ever pays for genuinely new happenings.
 */
export async function discoverImpactEvents(input: {
  spec: MarketMonitorSpec;
  rawRequest?: string | null;
  /** Ignore anything published before this timestamp. */
  sinceIso: string;
  knownKeys: Set<string>;
  /** The radar's own observation series, for correlation. */
  points: CorrelationPoint[];
}): Promise<EventDiscovery> {
  const queries = buildEventQueries(input.spec, input.rawRequest ?? null);
  const research = await researchQueries(queries, RESULTS_PER_QUERY, MAX_QUERIES);

  const base: EventDiscovery = {
    events: [],
    queries,
    documents: research.documents.length,
    clusters: 0,
    provider: research.provider,
    searchRequests: research.requests,
    searchFailures: research.failures,
    costEstimate: research.costEstimate,
    discoveryFailed: Boolean(research.discoveryFailed) || !research.configured,
  };
  if (research.documents.length === 0) return base;

  const sinceMs = Date.parse(input.sinceIso);
  const fresh = research.documents.filter((doc) => {
    if (!doc.published_at) return false;
    const t = Date.parse(doc.published_at);
    return Number.isFinite(t) && (!Number.isFinite(sinceMs) || t >= sinceMs);
  });
  if (fresh.length === 0) return base;

  const clusters = clusterDocuments(
    fresh.map((doc) => ({
      title: doc.title,
      url: doc.url,
      snippet: doc.snippet,
      publisher: doc.publisher ?? null,
      published_at: doc.published_at ?? null,
    })),
  );
  base.clusters = clusters.length;

  // Multi-source coverage first: an event three outlets report is more likely
  // to be real and significant than a single blog post.
  const candidates = clusters
    .filter((c) => !input.knownKeys.has(c.key))
    .sort((a, b) => {
      if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
      return (b.published_at ?? "").localeCompare(a.published_at ?? "");
    })
    .slice(0, MAX_CLUSTERS_ANALYZED);
  if (candidates.length === 0) return base;

  let analyses: Map<string, AnalyzedEvent>;
  try {
    analyses = await analyzeClusters(candidates, input.spec, input.rawRequest ?? null);
  } catch (err) {
    console.error(`[radar:market-events] analysis failed: ${(err as Error).message}`);
    return base;
  }

  const events: ImpactEvent[] = [];
  for (const cluster of candidates) {
    const analysis = analyses.get(cluster.key);
    if (!analysis) continue;
    const relevance = clamp01(analysis.relevance, 0.3);
    // Anything the model itself judges unrelated never reaches the timeline.
    if (relevance < 0.25) continue;
    events.push({
      key: cluster.key,
      title: (analysis.headline || cluster.title).slice(0, 300),
      factSummary: (analysis.fact_summary || "").slice(0, 1200),
      aiAnalysis: (analysis.ai_analysis || "").slice(0, 1600),
      severity: asSeverity(analysis.severity),
      relevance,
      confidence: clamp01(analysis.confidence, 0.5),
      categories: (Array.isArray(analysis.categories) ? analysis.categories : [])
        .filter((c): c is string => typeof c === "string" && c.length > 0)
        .slice(0, 3),
      sources: cluster.sources,
      publishedAt: cluster.published_at,
      correlation: correlateEvent(cluster.published_at, input.points),
    });
  }

  events.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return { ...base, events };
}
