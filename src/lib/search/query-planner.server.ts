/**
 * Discovery query planner.
 *
 * A single broad natural-language query is a weak discovery strategy: general
 * web search answers it with editorial and specification pages instead of the
 * marketplace/index pages that actually carry live items. A human searching
 * manually uses several short, concrete queries in the local language, on the
 * platforms where items live.
 *
 * This planner reproduces that behaviour generically — it knows nothing about
 * cars, watches or property. It asks the model to expand a radar's own
 * configuration into a small, diverse set of discovery queries and never
 * invents constraints the radar did not state.
 */
import { chatJson, MODELS } from "../ai/gateway.server";
import type { RadarConfig } from "../radar-types";

const querySchema = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["query", "intent"],
        properties: {
          query: { type: "string" },
          intent: { type: "string", enum: ["index", "item", "broad"] },
        },
      },
    },
  },
} as const;

export interface PlannedQuery {
  query: string;
  /** index = marketplace/listing pages, item = individual pages, broad = context. */
  intent: "index" | "item" | "broad";
  origin: "configured" | "planned";
}

const normalize = (q: string) => q.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Expand the radar's configured queries into a diverse discovery set.
 * Falls back to the configured queries if the planner is unavailable.
 */
export async function planDiscoveryQueries(
  config: RadarConfig,
  rawRequest: string,
  max = 8,
): Promise<PlannedQuery[]> {
  const configured: PlannedQuery[] = (config.search_queries ?? [])
    .filter((q) => typeof q === "string" && q.trim())
    .map((query) => ({ query: query.trim(), intent: "broad" as const, origin: "configured" as const }));

  let planned: PlannedQuery[] = [];
  try {
    const result = await chatJson<{ queries: { query: string; intent: PlannedQuery["intent"] }[] }>({
      model: MODELS.fast,
      schemaName: "radar_discovery_queries",
      schema: querySchema,
      system:
        "You plan web-search queries that DISCOVER live, individual items for a category-agnostic monitoring radar. " +
        "Think like a person who knows where these items are actually published: marketplaces, listing sites, " +
        "aggregators, official registries, job boards, news sources — whichever fits the subject. " +
        "Produce SHORT, concrete queries, not full sentences. A general-purpose search engine answers long " +
        "natural-language questions with editorial and specification pages, which contain no live items. " +
        "Rules: " +
        "1) Write queries in the language of the target market when the radar names a country or region, and " +
        "add at least one query in English. " +
        "2) Use the naming the market itself uses, including model/trim/variant spellings and common synonyms " +
        "(both the short and the fully qualified name of the subject). " +
        "3) Include at least two queries whose intent is 'index': they should surface listing/search/category " +
        "pages that contain MANY items (add words the local market uses for buying, for sale, used, classifieds). " +
        "4) Include 'item' queries that target individual pages, and one 'broad' query for context. " +
        "5) Do NOT bake numeric filters such as price ceilings into every query — filtering happens later; " +
        "a hard number in a query usually removes real matches. " +
        "6) Never invent constraints, brands, sites or regions the radar did not state. " +
        "7) Do not repeat the same query in different word order.",
      user: `Radar request (verbatim): ${rawRequest}
Target: ${config.target || "(none)"}
Interpretation: ${config.interpretation || "(none)"}
Locations: ${(config.locations ?? []).join("; ") || "(none)"}
Important criteria: ${(config.important_criteria ?? []).join("; ") || "(none)"}
Preferences: ${(config.preferences ?? []).join("; ") || "(none)"}
Currency: ${config.currency ?? "(none)"}
Existing queries (improve on these, keep what is good):
${(config.search_queries ?? []).join("\n") || "(none)"}

Return ${max} queries.`,
    });
    planned = (result.queries ?? [])
      .filter((q) => q.query && q.query.trim().length > 2)
      .map((q) => ({ query: q.query.trim(), intent: q.intent, origin: "planned" as const }));
  } catch (err) {
    console.warn(`[radar:queries] planner unavailable — ${(err as Error).message}`);
  }

  // Planned queries lead (they are the discovery-oriented ones), configured
  // queries follow so a radar never loses what the user's interpretation set.
  const out: PlannedQuery[] = [];
  const seen = new Set<string>();
  for (const q of [...planned, ...configured]) {
    const key = normalize(q.query);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= max) break;
  }
  return out.length > 0
    ? out
    : [{ query: rawRequest, intent: "broad", origin: "configured" }];
}
