/**
 * Monitoring engine.
 *
 * Responsibilities (all category-agnostic):
 *  1. Research   — pull documents through the pluggable search layer.
 *  2. Extract    — turn documents into structured findings via the AI layer.
 *  3. Diff       — compare against persisted findings to detect real changes.
 *  4. Eligibility— baseline / recency / duplication / relevance gates, each with
 *                  a persisted reason.
 *  5. Persist    — update findings state and create alerts with real sources.
 *
 * Cold-start rule: the FIRST successful sweep of a radar is a BASELINE. It
 * persists findings and sources but never creates alerts or notifications.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { chatJson, MODELS } from "../ai/gateway.server";
import { researchQueries, type SearchDocument } from "../search/providers.server";
import { asConfig, type RadarConfig } from "../radar-types";
import { discoverCandidates, selectForDetailFetch, type CandidateItem } from "./candidates.server";
import { fetchDetailPages } from "../search/detail-fetch.server";
import { asAttributeMap, diffAttributes, extractDetailAttributes, type ExtractedDetail } from "./attributes.server";
import type { AttributeSpec, AttributeValue } from "./normalize";
import {
  assignFingerprints,
  clampRecencyDays,
  evaluateRecency,
  informationDate,
  safeDate,
  type TemporalFacts,
} from "./temporal";

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
  event_date: string | null;
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
          "event_date",
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
          event_date: { type: ["string", "null"] },
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
    .map(
      (d, i) =>
        `[${i + 1}] ${d.title}\nURL: ${d.url}\nPublished: ${d.published_at ?? "unknown"}\n${d.snippet.slice(0, 2500)}`,
    )
    .join("\n\n");
}

export interface RunResult {
  status: "ok" | "no_provider" | "error";
  runType: "baseline" | "incremental";
  message?: string | undefined;
  itemsFound: number;
  newItems: number;
  alertsCreated: number;
  provider: string | null;
  sourcesRetrieved?: number;
  searchRequests?: number;
  searchFailures?: number;
  costEstimate?: number;
  duplicatesRemoved?: number;
  baselineFindings?: number;
  incrementalFindings?: number;
  suppressedBaseline?: number;
  suppressedRecency?: number;
  suppressedDuplicate?: number;
  suppressedRelevance?: number;
  candidatesDiscovered?: number;
  candidatesSelected?: number;
  detailFetchesOk?: number;
  detailFetchesFailed?: number;
  extractionsOk?: number;
  extractionsFailed?: number;
  attributesExtracted?: number;
  attributesMissing?: number;
  indexPages?: number;
  detailCostEstimate?: number;
  attributeChanges?: number;
}

interface Decision {
  fingerprint: string;
  title: string;
  url: string;
  eligible: boolean;
  decision: string;
  reason: string;
  published_at: string | null;
}

export async function runRadarCycle(db: Db, radar: RadarRow): Promise<RunResult> {
  const config: RadarConfig = asConfig(radar.config);
  const started = new Date().toISOString();
  const isBaseline = !radar.baseline_completed;
  const runType: "baseline" | "incremental" = isBaseline ? "baseline" : "incremental";
  const recencyDays = clampRecencyDays(radar.recency_days);

  const queries = config.search_queries.length ? config.search_queries : [radar.raw_request];
  const research = await researchQueries(queries);

  if (!research.configured) {
    await db.from("monitor_runs").insert({
      radar_id: radar.id,
      user_id: radar.user_id,
      status: "no_provider",
      run_type: runType,
      error: "No search provider configured",
      started_at: started,
      finished_at: new Date().toISOString(),
    });
    return {
      status: "no_provider",
      runType,
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
      run_type: runType,
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
        published_at: safeDate(d.published_at),
        retrieved_at: d.retrieved_at,
        last_seen_at: d.retrieved_at,
        snippet: d.snippet.slice(0, 4000),
      })),
    );
  }

  // ---------------------------------------------------------------------
  // 1b. Candidate discovery -> detail fetch -> generic attribute extraction.
  // Index/aggregator pages rarely carry item-level facts, so individual pages
  // are fetched (bounded by the radar's budget) and become primary sources.
  // ---------------------------------------------------------------------
  const specs: AttributeSpec[] = Array.isArray(config.attribute_schema) ? config.attribute_schema : [];
  const criteria = [
    config.target || radar.raw_request,
    config.important_criteria.join("; "),
    config.preferences.join("; "),
  ]
    .filter(Boolean)
    .join("\n");

  let candidates: CandidateItem[] = [];
  let indexPages: string[] = [];
  let selected: CandidateItem[] = [];
  let details: ExtractedDetail[] = [];
  let detailFetchesOk = 0;
  let detailFetchesFailed = 0;
  let extractionsOk = 0;
  let extractionsFailed = 0;
  let attributesExtracted = 0;
  let attributesMissing = 0;
  let detailCostEstimate = 0;
  const detailDocs: SearchDocument[] = [];
  const discoveryByUrl = new Map<string, string>();

  if (research.documents.length > 0) {
    try {
      const discovery = await discoverCandidates(research.documents, criteria);
      candidates = discovery.candidates;
      indexPages = discovery.indexPages;
      const budget = Math.max(0, Math.min(Number(radar.max_detail_fetches ?? 8), 25));
      selected = selectForDetailFetch(candidates, budget);
      for (const c of selected) if (c.url) discoveryByUrl.set(c.url, c.discovery_url);

      if (selected.length > 0) {
        const fetched = await fetchDetailPages(selected.map((c) => c.url!));
        detailFetchesOk = fetched.pages.length;
        detailFetchesFailed = fetched.failures.length;
        detailCostEstimate = fetched.costEstimate;
        for (const f of fetched.failures) {
          console.warn(`[radar:detail] could not fetch ${f.url} — ${f.reason}`);
        }

        for (const page of fetched.pages) {
          detailDocs.push({
            title: page.title ?? page.url,
            url: page.url,
            snippet: page.text.slice(0, 6000),
            publisher: (() => {
              try {
                return new URL(page.url).hostname.replace(/^www\./, "");
              } catch {
                return undefined;
              }
            })(),
            published_at: page.published_at,
            updated_at: page.updated_at,
            retrieved_at: page.fetched_at,
            query: `detail:${discoveryByUrl.get(page.url) ?? "candidate"}`,
          });
        }

        if (specs.length > 0 && fetched.pages.length > 0) {
          const extracted = await extractDetailAttributes(fetched.pages, specs, criteria);
          details = extracted.details;
          extractionsOk = extracted.details.length;
          extractionsFailed = extracted.failures.length;
          for (const d of details) {
            attributesExtracted += d.extracted;
            attributesMissing += d.missing;
          }
        }
      }
    } catch (err) {
      console.error(`[radar:detail] detail pipeline failed — ${(err as Error).message}`);
      extractionsFailed += 1;
    }
  }

  if (detailDocs.length > 0) {
    await db.from("research_sources").insert(
      detailDocs.map((d) => ({
        radar_id: radar.id,
        user_id: radar.user_id,
        run_id: runId,
        provider: research.provider!,
        query: d.query,
        url: d.url,
        title: d.title,
        publisher: d.publisher ?? null,
        published_at: safeDate(d.published_at),
        retrieved_at: d.retrieved_at,
        last_seen_at: d.retrieved_at,
        snippet: d.snippet.slice(0, 4000),
      })),
    );
  }

  // Detail pages join the corpus as first-class documents.
  const allDocs: SearchDocument[] = [...research.documents, ...detailDocs];
  const detailByUrl = new Map(details.map((d) => [d.url, d]));

  type RunUpdate = Database["public"]["Tables"]["monitor_runs"]["Update"];
  const finishRun = async (patch: RunUpdate) => {
    if (!runId) return;
    await db.from("monitor_runs").update(patch).eq("id", runId);
  };

  if (research.documents.length === 0) {
    const failedAll = research.requests > 0 && research.successes === 0;
    await finishRun({
      status: failedAll ? "failed" : "completed",
      error: failedAll ? research.errors.join(" | ").slice(0, 800) : null,
      finished_at: new Date().toISOString(),
    });
    // A failed baseline is never marked complete — it must be retried.
    await db.from("radars").update({ last_run_at: new Date().toISOString() }).eq("id", radar.id);
    return {
      status: failedAll ? "error" : "ok",
      runType,
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
      "event_date is the ISO date (YYYY-MM-DD) when the underlying event actually happened, ONLY if the document states it explicitly. " +
      "NEVER guess a date, never use today's date, and never copy a date from another item: if the document does not state it, event_date must be null. " +
      "If a fact is not clearly supported by the document, leave it null and note in the summary that it could not be verified from the source. " +
      "fingerprint must be a short stable slug identifying the underlying item or event (not the article wording). " +
      "event_type is one of: new_listing, price_decrease, price_increase, new_article, announcement, new_product, regulation, market_move, opportunity, other.",
    user: `Monitoring target (context only — do NOT filter on it): ${config.target || radar.raw_request}
Interpretation: ${config.interpretation}
Important criteria: ${config.important_criteria.join("; ") || "none"}
Exclusions: ${config.exclusions.join("; ") || "none"}
Events to monitor: ${config.monitored_events.join("; ") || "any meaningful change"}

Documents:
${documentBlock(allDocs)}`,
  });

  // Grounding guard: an item may only cite a retrieved document, or a page on
  // the same site as one (listing pages link to their own detail pages).
  const docHosts = new Map<string, string>();
  for (const d of allDocs) {
    try {
      docHosts.set(new URL(d.url).host, d.url);
    } catch {
      /* ignore malformed */
    }
  }
  const items: ExtractedItem[] = extraction.items.filter((i) => {
    if (allDocs.some((d) => d.url === i.url)) return true;
    try {
      return docHosts.has(new URL(i.url).host);
    } catch {
      return false;
    }
  });

  // Deterministic identity: the model's slug wording drifts between runs.
  const identified = assignFingerprints(items);
  items.length = 0;
  items.push(...identified);

  // Collapse items that resolve to the same identity within one sweep.
  const byIdentity = new Map<string, ExtractedItem>();
  for (const item of items) if (!byIdentity.has(item.fingerprint)) byIdentity.set(item.fingerprint, item);
  items.length = 0;
  items.push(...byIdentity.values());

  const docByUrl = new Map(allDocs.map((d) => [d.url, d]));
  const temporalOf = (item: ExtractedItem): TemporalFacts => {
    const doc = docByUrl.get(item.url);
    return {
      eventDate: safeDate(item.event_date),
      publishedAt: safeDate(doc?.published_at),
      updatedAt: safeDate(doc?.updated_at),
      retrievedAt: doc?.retrieved_at ?? new Date().toISOString(),
    };
  };

  // 3. Diff against persisted state.
  const { data: existingRows } = await db.from("findings").select("*").eq("radar_id", radar.id);
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
    // Same fingerprint, same value = the same source showing up again: never an alert.
  }

  const decisions: Decision[] = [];
  let suppressedBaseline = 0;
  let suppressedRecency = 0;
  let suppressedDuplicate = 0;
  let suppressedRelevance = 0;
  let alertsCreated = 0;

  const record = (
    item: ExtractedItem,
    eligible: boolean,
    decision: string,
    reason: string,
  ) => {
    decisions.push({
      fingerprint: item.fingerprint,
      title: item.title.slice(0, 300),
      url: item.url,
      eligible,
      decision,
      reason: reason.slice(0, 500),
      published_at: informationDate(temporalOf(item)),
    });
  };

  // 4a. Baseline gate — the first sweep is a snapshot, never an alert storm.
  let eligible = changed;
  if (isBaseline) {
    for (const c of changed) {
      record(
        c.item,
        false,
        "suppressed_baseline",
        "baseline snapshot — first sweep records existing state without alerting",
      );
    }
    suppressedBaseline = changed.length;
    eligible = [];
  }

  // 4b. Recency gate — old information is never presented as newly occurring.
  if (eligible.length > 0) {
    const passed: typeof eligible = [];
    for (const c of eligible) {
      // A value change is itself the event, observed now — the page's original
      // publication date must not make a fresh price move look stale.
      if (c.kind !== "new") {
        passed.push(c);
        continue;
      }
      const verdict = evaluateRecency(temporalOf(c.item), recencyDays);
      if (!verdict.withinWindow) {
        suppressedRecency += 1;
        record(c.item, false, "suppressed_recency", verdict.reason);
      } else {
        passed.push(c);
      }
    }
    eligible = passed;
  }

  // 4c. Duplication gate — never alert twice on the same underlying item/state.
  if (eligible.length > 0) {
    const { data: priorAlerts } = await db
      .from("alerts")
      .select("id, title, summary, event_type, sources")
      .eq("radar_id", radar.id)
      .limit(500);
    const seenKeys = new Set(
      (priorAlerts ?? []).map((a) => `${a.title}::${(a.sources as { url?: string }[] | null)?.[0]?.url ?? ""}`),
    );
    const passed: typeof eligible = [];
    for (const c of eligible) {
      const key = `${c.item.title}::${c.item.url}`;
      if (c.kind === "new" && seenKeys.has(key)) {
        suppressedDuplicate += 1;
        record(c.item, false, "suppressed_duplicate", "an alert for this exact item and source already exists");
        continue;
      }
      seenKeys.add(key);
      passed.push(c);
    }
    eligible = passed;
  }

  // 4d. Relevance / importance engine.
  if (eligible.length > 0) {
    const evaluation = await chatJson<{ items: EvaluatedItem[] }>({
      model: MODELS.fast,
      schemaName: "radar_evaluation",
      schema: evaluationSchema,
      system:
        "You are the relevance engine of a personal intelligence platform. Judge each change for THIS user's radar. " +
        "Prioritise signal over volume: set notify=false for trivial, duplicate or insignificant changes. " +
        "Information that is not genuinely new or newly changed must get notify=false. " +
        "confidence is 0-1 and must reflect how well the sources support the claim. Never invent facts.",
      user: `Radar: ${radar.name}
Original request: ${radar.raw_request}
Interpretation: ${config.interpretation}
Important criteria: ${config.important_criteria.join("; ") || "none"}
Preferences: ${config.preferences.join("; ") || "none"}
Price range: ${config.price_min ?? "any"} - ${config.price_max ?? "any"} ${config.currency ?? ""}
Relevant time window: last ${recencyDays} days (today is ${new Date().toISOString().slice(0, 10)})

Changes detected:
${eligible
  .map((c) => {
    const t = temporalOf(c.item);
    return `fingerprint: ${c.item.fingerprint}\nchange: ${c.kind}${
      c.previous !== null ? ` (previous value ${c.previous})` : ""
    }\ntitle: ${c.item.title}\nvalue: ${c.item.numeric_value ?? "n/a"} ${c.item.currency ?? ""}\ninformation dated: ${
      informationDate(t) ?? "unknown"
    }\nsummary: ${c.item.summary}\nsource: ${c.item.url}`;
  })
  .join("\n\n")}`,
    });

    const byFingerprint = new Map(evaluation.items.map((e) => [e.fingerprint, e]));
    for (const c of eligible) {
      const verdict = byFingerprint.get(c.item.fingerprint);
      if (!verdict || !verdict.notify) {
        suppressedRelevance += 1;
        record(
          c.item,
          false,
          "suppressed_relevance",
          verdict
            ? `relevance engine judged this below the alerting threshold (${verdict.importance})`
            : "relevance engine returned no verdict for this item",
        );
        continue;
      }
      const doc = docByUrl.get(c.item.url);
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
            published_at: safeDate(doc?.published_at),
          },
        ] as never,
      });
      if (error) {
        record(c.item, false, "error", `could not persist alert: ${error.message}`);
      } else {
        alertsCreated += 1;
        record(c.item, true, "alert_created", `${c.kind} change inside the ${recencyDays}d window`);
      }
    }
  }

  // 5. Persist monitoring state — findings are never deleted, only updated.
  const now = new Date().toISOString();
  for (const item of items) {
    const t = temporalOf(item);
    const prev = existing.get(item.fingerprint);
    const valueChanged =
      !!prev &&
      item.numeric_value !== null &&
      prev.numeric_value !== null &&
      Number(prev.numeric_value) !== item.numeric_value;
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
        published_at: t.publishedAt,
        source_updated_at: t.updatedAt,
        event_date: t.eventDate,
        retrieved_at: t.retrievedAt,
        origin: prev ? prev.origin : isBaseline ? "baseline" : "incremental",
        last_changed_at: valueChanged ? now : (prev?.last_changed_at ?? null),
        last_run_id: runId,
        last_seen_at: now,
      },
      { onConflict: "radar_id,fingerprint" },
    );
  }

  if (decisions.length > 0) {
    await db.from("alert_decisions").insert(
      decisions.map((d) => ({ ...d, radar_id: radar.id, user_id: radar.user_id, run_id: runId })),
    );
  }

  const failed = research.failures > 0 && research.successes === 0;
  const baselineFindings = isBaseline ? items.length : 0;
  const incrementalFindings = isBaseline ? 0 : changed.length;

  await finishRun({
    status: failed ? "failed" : "completed",
    run_type: runType,
    items_found: items.length,
    new_items: changed.length,
    alerts_created: alertsCreated,
    baseline_findings: baselineFindings,
    incremental_findings: incrementalFindings,
    suppressed_baseline: suppressedBaseline,
    suppressed_recency: suppressedRecency,
    suppressed_duplicate: suppressedDuplicate,
    suppressed_relevance: suppressedRelevance,
    error: research.errors.length ? research.errors.join(" | ").slice(0, 800) : null,
    finished_at: now,
  });

  type RadarUpdate = Database["public"]["Tables"]["radars"]["Update"];
  const radarPatch: RadarUpdate = { last_run_at: now };
  if (!failed) {
    radarPatch.last_successful_sweep_at = now;
    // Baseline only counts as complete after a successful sweep.
    if (isBaseline) {
      radarPatch.baseline_completed = true;
      radarPatch.baseline_completed_at = now;
    }
  }
  await db.from("radars").update(radarPatch).eq("id", radar.id);

  return {
    status: failed ? "error" : "ok",
    runType,
    message: isBaseline
      ? `Baseline snapshot complete — ${items.length} findings recorded. Future sweeps will alert only on genuinely new or changed information.`
      : undefined,
    itemsFound: items.length,
    newItems: changed.length,
    alertsCreated,
    provider: research.provider,
    sourcesRetrieved: research.documents.length,
    searchRequests: research.requests,
    searchFailures: research.failures,
    costEstimate: research.costEstimate,
    duplicatesRemoved: research.duplicatesRemoved,
    baselineFindings,
    incrementalFindings,
    suppressedBaseline,
    suppressedRecency,
    suppressedDuplicate,
    suppressedRelevance,
  };
}
