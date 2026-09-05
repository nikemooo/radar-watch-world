/**
 * Market Impact — world-event discovery, clustering and analysis.
 *
 * This is the second half of a market radar: the numeric layer says WHAT the
 * value is, this layer says WHAT HAPPENED that could move it. It reuses the
 * existing pluggable search layer (Exa → Brave → OpenAI → DuckDuckGo) and the
 * AI gateway; it never invents a source and never stores a claim without the
 * URLs it came from.
 *
 * Pipeline: queries → documents → recency filter → multi-signal clustering
 * (duplicate coverage collapses into one event, and follow-up coverage is
 * matched onto the event the radar already knows) → one batched AI pass that
 * separates FACT from INTERPRETATION → calibrated confidence, 0–100 importance
 * and observed (never causal) correlation against the radar's value series.
 */
import { chatJson, MODELS } from "../ai/gateway.server";
import { researchQueries } from "../search/providers.server";
import {
  asAffectedAssets,
  asSeverity,
  bestSourceTier,
  calibrateFactConfidence,
  calibrateInterpretationConfidence,
  classifyEventType,
  clusterDocuments,
  computeImportance,
  correlateEvent,
  independentSourceCount,
  isMaterialUpdate,
  matchExistingEvent,
  noveltyScore,
  softenCausality,
  strongTokens,
  type AffectedAsset,
  type CorrelationPoint,
  type EventCluster,
  type EventCorrelation,
  type EventSeverity,
  type EventSource,
  type EventType,
  type SourceTier,
} from "./events";
import { countIndependent, identifyAll, type SourceIdentity } from "./syndication";
import { measureReactions, peakMovePct, type MarketReaction } from "./reaction.server";
import type { MarketMonitorSpec } from "./types";

/** A stored event, as far as the discovery layer needs to know it. */
export interface KnownEvent {
  id: string;
  event_key: string;
  title: string;
  entities: string[];
  event_type: string;
  published_at: string | null;
  severity: string;
  importance_score: number;
  source_urls: string[];
}

export interface ImpactEvent {
  key: string;
  title: string;
  /** Verifiable, source-backed statement of what happened. No speculation. */
  factSummary: string;
  /** Explicitly labelled AI interpretation of why it matters for this instrument. */
  aiAnalysis: string;
  severity: EventSeverity;
  type: EventType;
  entities: string[];
  /** 0-1 — how much this event bears on THIS instrument. */
  relevance: number;
  /** Calibrated confidence in the FACTS, capped by source quality. */
  factConfidence: number;
  /** Calibrated confidence in the INTERPRETATION — always the weaker of the two. */
  interpretationConfidence: number;
  /** 0-100 significance for this radar. Drives the alert policy. */
  importance: number;
  /** 0-1, how unlike everything the radar already knows this story is. */
  novelty: number;
  sourceTier: SourceTier;
  independentSources: number;
  affectedAssets: AffectedAsset[];
  categories: string[];
  sources: EventSource[];
  publishedAt: string | null;
  correlation: EventCorrelation;
  /** Set when this is new coverage of an event the radar already stored. */
  updateOf: KnownEvent | null;
  /** Only meaningful for updates: did the story genuinely move on? */
  materialUpdate: boolean;
  /** One-line description of the development, appended to the event timeline. */
  updateNote: string;
  /** Concrete, checkable next signals — the "what to watch" of the product. */
  whatToWatch: string;
  /** Publisher identity per source: original vs aggregator, wire, quality. */
  sourceIdentities: SourceIdentity[];
  /** Measured moves of the affected assets around the event. Never invented. */
  reactions: MarketReaction[];
}

export interface EventDiscovery {
  events: ImpactEvent[];
  /** Telemetry for run rows and admin cost views. */
  queries: string[];
  documents: number;
  clusters: number;
  /** Clusters recognised as coverage of an already-known event. */
  merged: number;
  provider: string | null;
  searchRequests: number;
  searchFailures: number;
  costEstimate: number;
  discoveryFailed: boolean;
}

const MAX_QUERIES = 4;
const RESULTS_PER_QUERY = 8;
const MAX_CLUSTERS_ANALYZED = 12;
/** Reaction measurement costs network calls — only the events that matter. */
const MAX_EVENTS_MEASURED = 6;

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  sv: "Swedish",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  nl: "Dutch",
  pt: "Portuguese",
  pl: "Polish",
  da: "Danish",
  nb: "Norwegian",
  no: "Norwegian",
  fi: "Finnish",
  ar: "Arabic",
};

/** UI language tag -> a name the model reliably understands. */
export function languageName(tag: string | null | undefined): string {
  const base = (tag ?? "en").toLowerCase().split(/[-_]/)[0] ?? "en";
  return LANGUAGE_NAMES[base] ?? "English";
}

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
          "fact_confidence",
          "interpretation_confidence",
          "categories",
          "entities",
          "affected_assets",
          "update_note",
          "what_to_watch",
        ],
        properties: {
          key: { type: "string" },
          headline: { type: "string" },
          fact_summary: { type: "string" },
          ai_analysis: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          relevance: { type: "number" },
          fact_confidence: { type: "number" },
          interpretation_confidence: { type: "number" },
          categories: { type: "array", items: { type: "string" } },
          entities: { type: "array", items: { type: "string" } },
          affected_assets: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["symbol", "name", "relation", "rationale"],
              properties: {
                symbol: { type: "string" },
                name: { type: "string" },
                relation: { type: "string", enum: ["direct", "possible", "indirect"] },
                rationale: { type: "string" },
              },
            },
          },
          update_note: { type: "string" },
          what_to_watch: { type: "string" },
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
  fact_confidence: number;
  interpretation_confidence: number;
  categories: string[];
  entities: string[];
  affected_assets: unknown;
  update_note: string;
  what_to_watch: string;
}

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, n));
}

function clusterBlock(clusters: { cluster: EventCluster; existing: KnownEvent | null }[]): string {
  return clusters
    .map(({ cluster: c, existing }) =>
      [
        `KEY: ${c.key}`,
        `HEADLINE: ${c.title}`,
        `TYPE: ${c.type}`,
        `PUBLISHED: ${c.published_at ?? "unknown"}`,
        `OUTLETS: ${c.sources.map((s) => s.publisher ?? s.url).join(", ")}`,
        existing ? `CONTINUES KNOWN EVENT: "${existing.title}"` : "STATUS: new to this radar",
        `EXCERPT: ${c.text.slice(0, 1800)}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

/** One batched AI pass over the clusters — fact, interpretation, significance. */
async function analyzeClusters(
  clusters: { cluster: EventCluster; existing: KnownEvent | null }[],
  spec: MarketMonitorSpec,
  rawRequest: string | null,
  language: string,
): Promise<Map<string, AnalyzedEvent>> {
  const inst = spec.instrument;
  const result = await chatJson<{ events: AnalyzedEvent[] }>({
    model: MODELS.fast,
    schemaName: "market_impact_events",
    schema: analysisSchema,
    system:
      "You are the analyst of a market intelligence product. For each candidate event you receive a headline, a type, " +
      "a publication date and an excerpt from real published sources. Return one object per event, reusing the given KEY verbatim.\n" +
      "fact_summary: ONLY what the sources actually state — the concrete happening, named actors, numbers and dates. " +
      "One or two sentences. Never speculate, never add context that is not in the excerpt.\n" +
      "ai_analysis: your own interpretation of why this could matter for the instrument being monitored — transmission " +
      "mechanism, what to watch next. It is labelled as AI interpretation in the product. NEVER claim that this event " +
      "caused any price move; markets are multi-causal. Write about plausible channels, not proven causes.\n" +
      "severity: significance of the event in the world — 'low' routine coverage or commentary, 'medium' a real " +
      "development with limited reach, 'high' a major development (central bank decision, major sanctions, large supply " +
      "shock, big earnings surprise), 'critical' a rare, system-level event (war outbreak, default, emergency rate move). " +
      "Recycled commentary and opinion pieces are 'low'.\n" +
      "relevance: 0-1, how directly the event bears on THIS instrument specifically. Generic market commentary that only " +
      "mentions the instrument in passing is below 0.3. A decision that directly prices it is above 0.8.\n" +
      "fact_confidence: 0-1, how well the given sources support the fact_summary. Be strict: one anonymous or low-quality " +
      "outlet is below 0.6.\n" +
      "interpretation_confidence: 0-1, how sure you are of your own reading. Must be lower than fact_confidence.\n" +
      "entities: 2-6 named actors, places, tickers or institutions central to the event.\n" +
      "affected_assets: assets plausibly touched, with relation 'direct' (the event prices this asset), 'possible' " +
      "(a credible channel exists) or 'indirect' (second-order). Empty array if none beyond the monitored instrument.\n" +
      "update_note: if the candidate CONTINUES a known event, one short sentence stating only what is NEW versus the known " +
      "event. Otherwise an empty string.\n" +
      "what_to_watch: one or two concrete, checkable things that would confirm or kill this story in the coming days " +
      "(a scheduled decision, a data release, a level being held or broken, an official statement). Name them specifically; " +
      "never write generic advice like 'monitor the situation'.\n" +
      "categories: 1-3 short lowercase slugs such as monetary_policy, geopolitics, supply, demand, regulation, earnings, " +
      "energy, conflict, macro_data.\n" +
      "Drop nothing: return an entry for every KEY you were given.\n" +
      `Write every human-readable field (fact_summary, ai_analysis, update_note, what_to_watch) in ${languageName(language)}. ` +
      "Keep key, categories, entities and asset symbols unchanged and untranslated.",
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
 * Discover, cluster and analyse the world events that could move this
 * instrument. `known` are events the radar already stored: fresh coverage of
 * them becomes an UPDATE to the existing event, never a second event.
 */
export async function discoverImpactEvents(input: {
  spec: MarketMonitorSpec;
  rawRequest?: string | null;
  /** Ignore anything published before this timestamp. */
  sinceIso: string;
  known: KnownEvent[];
  /** The radar's own observation series, for correlation. */
  points: CorrelationPoint[];
  /** UI language tag — AI interpretations are written in it. */
  language?: string | undefined;
}): Promise<EventDiscovery> {
  const queries = buildEventQueries(input.spec, input.rawRequest ?? null);
  const research = await researchQueries(queries, RESULTS_PER_QUERY, MAX_QUERIES);

  const base: EventDiscovery = {
    events: [],
    queries,
    documents: research.documents.length,
    clusters: 0,
    merged: 0,
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

  const knownShapes = input.known.map((row) => ({
    ...row,
    type: classifyEventType(row.event_type) === "other" ? classifyEventType(row.title) : (row.event_type as EventType),
    entities: row.entities.length > 0 ? row.entities : strongTokens(row.title),
  }));

  // Match each cluster against what the radar already knows. Known stories are
  // only re-analysed when they bring genuinely new sources.
  const paired = clusters.map((cluster) => {
    const existing = matchExistingEvent(
      { title: cluster.title, entities: cluster.entities, type: cluster.type, published_at: cluster.published_at },
      knownShapes,
    );
    const knownUrls = new Set(existing?.source_urls ?? []);
    const newSources = cluster.sources.filter((s) => !knownUrls.has(s.url));
    return { cluster, existing: existing ? (existing as KnownEvent) : null, newSources };
  });
  base.merged = paired.filter((p) => p.existing).length;

  const candidates = paired
    .filter((p) => !p.existing || p.newSources.length > 0)
    .sort((a, b) => {
      if (b.cluster.sources.length !== a.cluster.sources.length) {
        return b.cluster.sources.length - a.cluster.sources.length;
      }
      return (b.cluster.published_at ?? "").localeCompare(a.cluster.published_at ?? "");
    })
    .slice(0, MAX_CLUSTERS_ANALYZED);
  if (candidates.length === 0) return base;

  let analyses: Map<string, AnalyzedEvent>;
  try {
    analyses = await analyzeClusters(
      candidates.map(({ cluster, existing }) => ({ cluster, existing })),
      input.spec,
      input.rawRequest ?? null,
      input.language ?? "en",
    );
  } catch (err) {
    console.error(`[radar:market-events] analysis failed: ${(err as Error).message}`);
    return base;
  }

  const events: ImpactEvent[] = [];
  for (const { cluster, existing, newSources } of candidates) {
    const analysis = analyses.get(cluster.key);
    if (!analysis) continue;
    const relevance = clamp01(analysis.relevance, 0.3);
    // Anything the model itself judges unrelated never reaches the timeline.
    if (relevance < 0.25) continue;

    const severity = asSeverity(analysis.severity);
    const tier = bestSourceTier(cluster.sources);
    const identities = identifyAll(cluster.sources);
    // Syndicated copies of one wire report are ONE voice, not five.
    const independent = Math.max(1, Math.min(countIndependent(identities), independentSourceCount(cluster.sources)));
    const factConfidence = calibrateFactConfidence({
      modelConfidence: clamp01(analysis.fact_confidence, 0.5),
      tier,
      independentSources: independent,
    });
    const interpretationConfidence = calibrateInterpretationConfidence({
      modelConfidence: clamp01(analysis.interpretation_confidence, 0.4),
      factConfidence,
    });
    const correlation = correlateEvent(cluster.published_at, input.points);
    const novelty = existing
      ? 0.3
      : noveltyScore({ title: cluster.title, entities: cluster.entities, type: cluster.type }, knownShapes);
    const importance = computeImportance({
      severity,
      relevance,
      tier,
      independentSources: independent,
      marketMovePct: correlation.changePct,
      novelty,
      isUpdate: Boolean(existing),
    });

    // The model's named actors are the entities; headline tokens are only a
    // fallback so a thin analysis still leaves something to match updates on.
    const named = (Array.isArray(analysis.entities) ? analysis.entities : [])
      .filter((e): e is string => typeof e === "string" && e.trim().length > 1)
      .map((e) => e.trim());
    const entities = [...new Set(named.length >= 3 ? named : [...named, ...cluster.entities])].slice(0, 12);

    events.push({
      key: existing?.event_key ?? cluster.key,
      title: (analysis.headline || cluster.title).slice(0, 300),
      factSummary: (analysis.fact_summary || "").slice(0, 1200),
      // The product never asserts causation between an event and a price move.
      aiAnalysis: softenCausality(analysis.ai_analysis || "").slice(0, 1600),
      severity,
      type: cluster.type,
      entities,
      relevance,
      factConfidence,
      interpretationConfidence,
      importance,
      novelty,
      sourceTier: tier,
      independentSources: independent,
      affectedAssets: asAffectedAssets(analysis.affected_assets),
      categories: (Array.isArray(analysis.categories) ? analysis.categories : [])
        .filter((c): c is string => typeof c === "string" && c.length > 0)
        .slice(0, 3),
      sources: cluster.sources,
      publishedAt: cluster.published_at,
      correlation,
      updateOf: existing,
      materialUpdate: existing
        ? isMaterialUpdate({
            newIndependentSources: independentSourceCount(newSources),
            previousImportance: existing.importance_score,
            importance,
            previousSeverity: asSeverity(existing.severity),
            severity,
          })
        : false,
      updateNote: typeof analysis.update_note === "string" ? softenCausality(analysis.update_note).slice(0, 400) : "",
      whatToWatch: typeof analysis.what_to_watch === "string" ? analysis.what_to_watch.slice(0, 600) : "",
      sourceIdentities: identities,
      reactions: [],
    });
  }

  events.sort((a, b) => b.importance - a.importance);

  // Market Reaction Engine: for the events that matter, measure what the
  // affected assets actually did around the event timestamp. Failures stay
  // visible as "unavailable" rather than becoming a fabricated 0%.
  const measured = events.slice(0, MAX_EVENTS_MEASURED);
  await Promise.all(
    measured.map(async (event) => {
      const assets = [
        { symbol: input.spec.instrument.symbol, name: input.spec.instrument.name },
        ...event.affectedAssets
          .filter((a) => a.relation !== "indirect")
          .map((a) => ({ symbol: a.symbol, name: a.name })),
      ];
      event.reactions = await measureReactions({ assets, eventIso: event.publishedAt, max: 4 });
      // An observed move is evidence of significance — never of causation.
      const peak = peakMovePct(event.reactions);
      if (peak !== null && event.correlation.changePct === null) {
        event.importance = Math.min(100, event.importance + Math.min(12, Math.round(peak * 2)));
      }
    }),
  );

  events.sort((a, b) => b.importance - a.importance);
  return { ...base, events };
}

