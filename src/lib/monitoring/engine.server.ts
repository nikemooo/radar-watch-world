/**
 * Monitoring engine.
 *
 * Responsibilities (all category-agnostic):
 *  1. Research  — pull documents through the pluggable search layer.
 *  2. Extract   — turn documents into structured findings via the AI layer.
 *  3. Diff      — compare against persisted findings to detect real changes.
 *  4. Evaluate  — score relevance/importance/confidence, drop noise.
 *  5. Persist   — update findings state and create alerts with real sources.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { chatJson, MODELS } from "../ai/gateway.server";
import { researchQueries, type SearchDocument } from "../search/providers.server";
import { asConfig, type RadarConfig } from "../radar-types";

type Db = SupabaseClient<Database>;
type RadarRow = Database["public"]["Tables"]["radars"]["Row"];

interface ExtractedItem {
  fingerprint: string;
  title: string;
  url: string;
  entity: string;
  numeric_value: number | null;
  currency: string | null;
  event_type: string;
  summary: string;
}

interface EvaluatedItem {
  fingerprint: string;
  importance: "critical" | "important" | "interesting" | "minor";
  confidence: number;
  notify: boolean;
  why_it_matters: string;
  what_changed: string;
  potential_impact: string;
}

const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "fingerprint",
          "title",
          "url",
          "entity",
          "numeric_value",
          "currency",
          "event_type",
          "summary",
        ],
        properties: {
          fingerprint: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          entity: { type: "string" },
          numeric_value: { type: ["number", "null"] },
          currency: { type: ["string", "null"] },
          event_type: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
  },
} as const;

const evaluationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "fingerprint",
          "importance",
          "confidence",
          "notify",
          "why_it_matters",
          "what_changed",
          "potential_impact",
        ],
        properties: {
          fingerprint: { type: "string" },
          importance: { type: "string", enum: ["critical", "important", "interesting", "minor"] },
          confidence: { type: "number" },
          notify: { type: "boolean" },
          why_it_matters: { type: "string" },
          what_changed: { type: "string" },
          potential_impact: { type: "string" },
        },
      },
    },
  },
} as const;

function documentBlock(docs: SearchDocument[]) {
  return docs
    .map((d, i) => `[${i + 1}] ${d.title}\nURL: ${d.url}\n${d.snippet.slice(0, 2500)}`)
    .join("\n\n");
}

export interface RunResult {
  status: "ok" | "no_provider" | "error";
  message?: string;
  itemsFound: number;
  newItems: number;
  alertsCreated: number;
  provider: string | null;
  sourcesRetrieved?: number;
  searchRequests?: number;
  searchFailures?: number;
  costEstimate?: number;
  duplicatesRemoved?: number;
}

export async function runRadarCycle(db: Db, radar: RadarRow): Promise<RunResult> {
  const config: RadarConfig = asConfig(radar.config);
  const started = new Date().toISOString();

  const queries = config.search_queries.length ? config.search_queries : [radar.raw_request];
  const research = await researchQueries(queries);

  if (!research.configured) {
    await db.from("monitor_runs").insert({
      radar_id: radar.id,
      user_id: radar.user_id,
      status: "no_provider",
      error: "No search provider configured",
      started_at: started,
      finished_at: new Date().toISOString(),
    });
    return {
      status: "no_provider",
      message:
        "No research provider is connected yet. Add an EXA_API_KEY so Radar can read live public sources.",
      itemsFound: 0,
      newItems: 0,
      alertsCreated: 0,
      provider: null,
    };
  }

  // Every retrieved source is persisted verbatim so alerts stay verifiable.
  const { data: runRow } = await db
    .from("monitor_runs")
    .insert({
      radar_id: radar.id,
      user_id: radar.user_id,
      status: "running",
      provider: research.provider,
      started_at: started,
      search_requests: research.requests,
      search_successes: research.successes,
      search_failures: research.failures,
      sources_retrieved: research.documents.length,
      cost_estimate: research.costEstimate,
    })
    .select("id")
    .maybeSingle();
  const runId = runRow?.id ?? null;

  if (research.documents.length > 0) {
    await db.from("research_sources").insert(
      research.documents.map((d) => ({
        radar_id: radar.id,
        user_id: radar.user_id,
        run_id: runId,
        provider: research.provider!,
        query: d.query,
        url: d.url,
        title: d.title,
        publisher: d.publisher ?? null,
        published_at: d.published_at ? safeDate(d.published_at) : null,
        retrieved_at: d.retrieved_at,
        snippet: d.snippet.slice(0, 4000),
      })),
    );
  }

  type RunUpdate = Database["public"]["Tables"]["monitor_runs"]["Update"];
  const finishRun = async (patch: RunUpdate) => {
    if (!runId) return;
    await db.from("monitor_runs").update(patch).eq("id", runId);
  };


  if (research.documents.length === 0) {
    const failedAll = research.requests > 0 && research.successes === 0;
    await finishRun({
      status: failedAll ? "error" : "ok",
      error: failedAll ? research.errors.join(" | ").slice(0, 800) : null,
      finished_at: new Date().toISOString(),
    });
    await db.from("radars").update({ last_run_at: new Date().toISOString() }).eq("id", radar.id);
    return {
      status: failedAll ? "error" : "ok",
      message: failedAll
        ? `Search provider error: ${research.errors[0] ?? "unknown error"}`
        : "No sources could be retrieved for this radar — nothing could be verified, so no alert was created.",
      itemsFound: 0,
      newItems: 0,
      alertsCreated: 0,
      provider: research.provider,
      sourcesRetrieved: 0,
      searchRequests: research.requests,
      searchFailures: research.failures,
      costEstimate: research.costEstimate,
      duplicatesRemoved: research.duplicatesRemoved,
    };
  }

  // 2. Extract structured items — grounded strictly in the retrieved documents.
  const extraction = await chatJson<{ items: ExtractedItem[] }>({
    model: MODELS.fast,
    schemaName: "radar_extraction",
    schema: extractionSchema,
    system:
      "You extract structured monitoring items from retrieved web documents for a personal intelligence platform. " +
      "Extract EVERY concrete listing, offer, product, price or event visible in the document text — including items on aggregator and listing-index pages — even when an item does not fully match the user's criteria. Relevance filtering happens in a later step. " +
      "Only use facts present in the provided documents. Never invent URLs, prices, products, companies, dates or facts. " +
      "The url field must be the URL of the document the item came from, copied verbatim. " +
      "If a fact is not clearly supported by the document, leave it null and note in the summary that it could not be verified from the source. " +
      "fingerprint must be a short stable slug identifying the underlying item or event (not the article wording). " +
      "event_type is one of: new_listing, price_decrease, price_increase, new_article, announcement, new_product, regulation, market_move, opportunity, other.",
    user: `Monitoring target (context only — do NOT filter on it): ${config.target || radar.raw_request}
Interpretation: ${config.interpretation}
Important criteria: ${config.important_criteria.join("; ") || "none"}
Exclusions: ${config.exclusions.join("; ") || "none"}
Events to monitor: ${config.monitored_events.join("; ") || "any meaningful change"}

Documents:
${documentBlock(research.documents)}`,
  });


  // Grounding guard: an item may only cite a retrieved document, or a page on

  // the same site as one (listing pages link to their own detail pages).
  const docHosts = new Map<string, string>();
  for (const d of research.documents) {
    try {
      docHosts.set(new URL(d.url).host, d.url);
    } catch {
      /* ignore malformed */
    }
  }
  const items = extraction.items.filter((i) => {
    if (research.documents.some((d) => d.url === i.url)) return true;
    try {
      return docHosts.has(new URL(i.url).host);
    } catch {
      return false;
    }
  });



  // 3. Diff against persisted state.
  const { data: existingRows } = await db
    .from("findings")
    .select("*")
    .eq("radar_id", radar.id);
  const existing = new Map((existingRows ?? []).map((f) => [f.fingerprint, f]));

  const changed: { item: ExtractedItem; kind: string; previous: number | null }[] = [];
  for (const item of items) {
    const prev = existing.get(item.fingerprint);
    if (!prev) {
      changed.push({ item, kind: "new", previous: null });
    } else if (
      item.numeric_value !== null &&
      prev.numeric_value !== null &&
      Number(prev.numeric_value) !== item.numeric_value
    ) {
      changed.push({
        item,
        kind: item.numeric_value < Number(prev.numeric_value) ? "decrease" : "increase",
        previous: Number(prev.numeric_value),
      });
    }
  }

  let alertsCreated = 0;

  // 4. Relevance engine — only genuinely new, relevant signal gets through.
  if (changed.length > 0) {
    const evaluation = await chatJson<{ items: EvaluatedItem[] }>({
      model: MODELS.fast,
      schemaName: "radar_evaluation",
      schema: evaluationSchema,
      system:
        "You are the relevance engine of a personal intelligence platform. Judge each change for THIS user's radar. " +
        "Prioritise signal over volume: set notify=false for trivial, duplicate or insignificant changes. " +
        "confidence is 0-1 and must reflect how well the sources support the claim. Never invent facts.",
      user: `Radar: ${radar.name}
Original request: ${radar.raw_request}
Interpretation: ${config.interpretation}
Important criteria: ${config.important_criteria.join("; ") || "none"}
Preferences: ${config.preferences.join("; ") || "none"}
Price range: ${config.price_min ?? "any"} - ${config.price_max ?? "any"} ${config.currency ?? ""}

Changes detected:
${changed
  .map(
    (c) =>
      `fingerprint: ${c.item.fingerprint}\nchange: ${c.kind}${
        c.previous !== null ? ` (previous value ${c.previous})` : ""
      }\ntitle: ${c.item.title}\nvalue: ${c.item.numeric_value ?? "n/a"} ${c.item.currency ?? ""}\nsummary: ${c.item.summary}\nsource: ${c.item.url}`,
  )
  .join("\n\n")}`,
    });

    const byFingerprint = new Map(evaluation.items.map((e) => [e.fingerprint, e]));
    for (const c of changed) {
      const verdict = byFingerprint.get(c.item.fingerprint);
      if (!verdict || !verdict.notify) continue;
      const doc = research.documents.find((d) => d.url === c.item.url);
      const { error } = await db.from("alerts").insert({
        radar_id: radar.id,
        user_id: radar.user_id,
        title: c.item.title,
        summary: c.item.summary,
        why_it_matters: verdict.why_it_matters,
        what_changed: verdict.what_changed,
        potential_impact: verdict.potential_impact,
        importance: verdict.importance,
        confidence: Math.max(0, Math.min(1, verdict.confidence)),
        event_type: c.item.event_type,
        sources: [
          {
            title: doc?.title ?? c.item.title,
            url: c.item.url,
            publisher: doc?.publisher ?? null,
          },
        ] as never,
      });
      if (!error) alertsCreated += 1;
    }
  }

  // 5. Persist monitoring state.
  const now = new Date().toISOString();
  for (const item of items) {
    await db.from("findings").upsert(
      {
        radar_id: radar.id,
        user_id: radar.user_id,
        fingerprint: item.fingerprint,
        title: item.title,
        url: item.url,
        entity: item.entity,
        numeric_value: item.numeric_value,
        currency: item.currency,
        snapshot: { summary: item.summary, event_type: item.event_type } as never,
        last_seen_at: now,
      },
      { onConflict: "radar_id,fingerprint" },
    );
  }

  await finishRun({
    status: research.failures > 0 && research.successes === 0 ? "error" : "ok",
    items_found: items.length,
    new_items: changed.length,
    alerts_created: alertsCreated,
    error: research.errors.length ? research.errors.join(" | ").slice(0, 800) : null,
    finished_at: now,
  });

  await db.from("radars").update({ last_run_at: now }).eq("id", radar.id);

  return {
    status: "ok",
    itemsFound: items.length,
    newItems: changed.length,
    alertsCreated,
    provider: research.provider,
    sourcesRetrieved: research.documents.length,
    searchRequests: research.requests,
    searchFailures: research.failures,
    costEstimate: research.costEstimate,
    duplicatesRemoved: research.duplicatesRemoved,
  };
}

/** Providers return loose date strings; only keep parsable ones. */
function safeDate(value: string): string | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

