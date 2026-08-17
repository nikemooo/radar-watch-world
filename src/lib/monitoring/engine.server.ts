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
import { discoverCandidates, type CandidateItem } from "./candidates.server";
import { fetchDetailPages } from "../search/detail-fetch.server";
import {
  asAttributeMap,
  diffAttributes,
  extractDetailAttributes,
  inferAttributeSchema,
  type ExtractedDetail,
} from "./attributes.server";
import type { AttributeSpec, AttributeValue } from "./normalize";
import {
  buildBaseline,
  comparableSettings,
  observedValue,
  valueAttributeKey,
  NO_BASELINE_PHRASE,
  type BaselineResult,
  type Observation,
} from "./comparables";
import {
  adaptiveBudget,
  backoffUntil,
  prioritizeCandidates,
  type HostStat,
  type KnownItem,
  type UrlState,
} from "./fetch-policy";
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
  baselinesComputed?: number;
  baselinesInsufficient?: number;
  comparableObservations?: number;
  detailFetchesAttempted?: number;
  detailFetchesSkippedBackoff?: number;
  detailFetchBudget?: number;
  budgetReason?: string;
  usableComparables?: number;
  comparableCoverage?: number;
  baselinesBackfilled?: number;
  costCeiling?: number;
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


/**
 * Persist per-host success rates and per-URL backoff so the next sweep spends
 * its budget on sources that actually answer.
 */
async function recordFetchHealth(
  db: Db,
  userId: string,
  input: {
    ok: string[];
    failed: { url: string; reason: string }[];
    previous: Map<string, UrlState>;
    hostStats: Map<string, HostStat>;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const hostOf = (url: string): string | null => {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return null;
    }
  };

  const perHost = new Map<string, { attempts: number; successes: number; failures: number; reason: string | null }>();
  const bump = (url: string, success: boolean, reason: string | null) => {
    const host = hostOf(url);
    if (!host) return;
    const agg = perHost.get(host) ?? { attempts: 0, successes: 0, failures: 0, reason: null };
    agg.attempts += 1;
    if (success) agg.successes += 1;
    else {
      agg.failures += 1;
      agg.reason = reason;
    }
    perHost.set(host, agg);
  };
  for (const url of input.ok) bump(url, true, null);
  for (const f of input.failed) bump(f.url, false, f.reason);

  const hostRows = [...perHost.entries()].map(([host, agg]) => {
    const prior = input.hostStats.get(host);
    return {
      user_id: userId,
      host,
      attempts: (prior?.attempts ?? 0) + agg.attempts,
      successes: (prior?.successes ?? 0) + agg.successes,
      failures: Math.max(0, (prior?.attempts ?? 0) - (prior?.successes ?? 0)) + agg.failures,
      last_attempt_at: now,
      last_success_at: agg.successes > 0 ? now : null,
      last_failure_reason: agg.reason,
      updated_at: now,
    };
  });
  if (hostRows.length > 0) {
    await db.from("source_fetch_stats").upsert(hostRows, { onConflict: "user_id,host" });
  }

  const urlRows = [
    ...input.ok.map((url) => ({
      user_id: userId,
      url,
      host: hostOf(url) ?? "",
      consecutive_failures: 0,
      last_reason: null as string | null,
      last_attempt_at: now,
      last_success_at: now,
      next_attempt_at: null as string | null,
      updated_at: now,
    })),
    ...input.failed.map((f) => {
      const failures = (input.previous.get(f.url)?.consecutiveFailures ?? 0) + 1;
      return {
        user_id: userId,
        url: f.url,
        host: hostOf(f.url) ?? "",
        consecutive_failures: failures,
        last_reason: f.reason.slice(0, 300),
        last_attempt_at: now,
        last_success_at: input.previous.get(f.url) ? null : null,
        next_attempt_at: backoffUntil(failures, f.reason),
        updated_at: now,
      };
    }),
  ].filter((r) => r.host);
  if (urlRows.length > 0) {
    await db.from("url_fetch_state").upsert(urlRows, { onConflict: "user_id,url" });
  }
}

export type RunOptions = {
  /** Remaining alerts the user's plan allows this month; null = unlimited. */
  alertBudget?: number | null | undefined;
  /** Plan-imposed cap on detail fetches for this sweep. */
  maxDetailFetches?: number | undefined;
  /** Plan-level priority processing flag. */
  priority?: boolean | undefined;
};

export async function runRadarCycle(
  db: Db,
  radar: RadarRow,
  options: RunOptions = {},
): Promise<RunResult> {
  let alertBudget = options.alertBudget ?? null;
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
  let specs: AttributeSpec[] = Array.isArray(config.attribute_schema) ? config.attribute_schema : [];
  if (specs.length === 0) {
    // Radars created before the attribute layer keep working: infer once, persist.
    try {
      specs = await inferAttributeSchema(`${radar.name}\n${radar.raw_request}`);
      if (specs.length > 0) {
        await db
          .from("radars")
          .update({ config: { ...config, attribute_schema: specs } as never })
          .eq("id", radar.id);
      }
    } catch (err) {
      console.warn(`[radar:detail] attribute schema inference failed — ${(err as Error).message}`);
    }
  }
  const criteria = [
    config.target || radar.raw_request,
    config.important_criteria.join("; "),
    config.preferences.join("; "),
  ]
    .filter(Boolean)
    .join("\n");

  const valueKey = valueAttributeKey(specs);
  const minComparables = Math.max(2, Number(radar.min_comparables ?? 10));
  const costCeiling = Math.max(0.005, Number(radar.max_sweep_cost ?? 0.06));

  // Persisted state is loaded BEFORE the detail stage so the fetch policy can
  // aim the budget at items that actually improve comparable coverage.
  const { data: existingRows } = await db.from("findings").select("*").eq("radar_id", radar.id);
  const existing = new Map((existingRows ?? []).map((f) => [f.fingerprint, f]));

  const asObservation = (f: NonNullable<typeof existingRows>[number]): Observation => ({
    fingerprint: f.fingerprint,
    title: f.title,
    url: f.primary_url ?? f.url,
    attributes: asAttributeMap(f.attributes) ?? {},
    numericValue: f.numeric_value === null ? null : Number(f.numeric_value),
    currency: f.currency,
    observedAt: f.last_seen_at,
    detailFetched: f.detail_status === "fetched",
  });
  /**
   * A "usable comparable" is an observation whose value came from a read
   * item-level page — the quality bar for comparables is not lowered here, so
   * coverage is measured against stated facts only.
   */
  const isUsableComparable = (o: Observation): boolean => {
    const v = observedValue(o, valueKey);
    return v !== null && v.stated;
  };
  const usableComparablesBefore = (existingRows ?? []).filter((f) =>
    isUsableComparable(asObservation(f)),
  ).length;
  const comparableGap = Math.max(0, minComparables - usableComparablesBefore);

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
  let detailFetchesAttempted = 0;
  let detailFetchesSkippedBackoff = 0;
  let detailFetchBudget = 0;
  let budgetReason = "detail stage not reached";
  const detailDocs: SearchDocument[] = [];
  const discoveryByUrl = new Map<string, string>();

  if (research.documents.length > 0) {
    try {
      const discovery = await discoverCandidates(research.documents, criteria);
      candidates = discovery.candidates;
      indexPages = discovery.indexPages;
      // Adaptive budget + priority: fetch what is most likely to yield stated,
      // item-level facts — never simply the first N results.
      const [{ data: hostRows }, { data: urlRows }] = await Promise.all([
        db.from("source_fetch_stats").select("host, attempts, successes").eq("user_id", radar.user_id),
        db
          .from("url_fetch_state")
          .select("url, consecutive_failures, next_attempt_at")
          .eq("user_id", radar.user_id),
      ]);
      const hostStats = new Map<string, HostStat>(
        (hostRows ?? []).map((h) => [h.host, { host: h.host, attempts: h.attempts, successes: h.successes }]),
      );
      const urlStates = new Map<string, UrlState>(
        (urlRows ?? []).map((u) => [
          u.url,
          { url: u.url, consecutiveFailures: u.consecutive_failures, nextAttemptAt: u.next_attempt_at },
        ]),
      );
      const known = new Map<string, KnownItem>();
      for (const f of existingRows ?? []) {
        const url = f.primary_url ?? f.url;
        if (!url) continue;
        const attrs = asAttributeMap(f.attributes) ?? {};
        known.set(url, {
          url,
          detailStatus: f.detail_status,
          detailFetchedAt: f.detail_fetched_at,
          hasComparableValue: isUsableComparable(asObservation(f)),
          // The comparable value is the attribute that matters most for coverage.
          missingCritical: valueKey ? !attrs[valueKey]?.raw : false,
        });
      }

      const fetchable = candidates.filter((c) => c.url && c.individual).length;
      const budgetPlan = adaptiveBudget({
        configured: Math.min(
          Number(radar.max_detail_fetches ?? 8),
          options.maxDetailFetches ?? Number.MAX_SAFE_INTEGER,
        ),
        frequency: radar.frequency,
        comparableGap: specs.length > 0 ? comparableGap : 0,
        fetchableCandidates: fetchable,
        spentCost: research.costEstimate,
        costCeiling,
        perFetchCost: 0.001,
      });
      detailFetchBudget = budgetPlan.budget;
      budgetReason = budgetPlan.reason;

      const priority = prioritizeCandidates({
        candidates,
        hostStats,
        urlStates,
        known,
        needsComparables: specs.length > 0 && comparableGap > 0,
        budget: budgetPlan.budget,
      });
      selected = priority.selected;
      detailFetchesSkippedBackoff = priority.skippedBackoff;
      detailFetchesAttempted = selected.length;
      for (const c of selected) if (c.url) discoveryByUrl.set(c.url, c.discovery_url);

      if (selected.length > 0) {
        const fetched = await fetchDetailPages(selected.map((c) => c.url!));
        detailFetchesOk = fetched.pages.length;
        detailFetchesFailed = fetched.failures.length;
        detailCostEstimate = fetched.costEstimate;
        for (const f of fetched.failures) {
          console.warn(`[radar:detail] could not fetch ${f.url} — ${f.reason}`);
        }
        await recordFetchHealth(db, radar.user_id, {
          ok: fetched.pages.map((p) => p.url),
          failed: fetched.failures,
          previous: urlStates,
          hostStats,
        });

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

  // Attribute enrichment: a detail page is the primary source for its item.
  const attributesFor = (item: ExtractedItem): Record<string, AttributeValue> | null =>
    detailByUrl.get(item.url)?.attributes ?? null;
  for (const item of items) {
    const attrs = attributesFor(item);
    if (!attrs) continue;
    const money = Object.values(attrs).find(
      (a) => a.currency !== null && a.value !== null && (a.confidence === "stated" || a.confidence === "structured"),
    );
    // Normalized price from the detail page beats a value read off an index page.
    if (money) {
      item.numeric_value = money.value;
      item.currency = money.currency;
    }
  }

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

  // 3. Diff against persisted state (loaded before the detail stage).

  const changed: { item: ExtractedItem; kind: string; previous: number | null }[] = [];
  const attributeEvents: {
    fingerprint: string;
    attribute: string;
    previous: AttributeValue | null;
    next: AttributeValue;
  }[] = [];
  for (const item of items) {
    const prev = existing.get(item.fingerprint);
    const attrs = attributesFor(item);
    const attrDiffs = prev && attrs ? diffAttributes(asAttributeMap(prev.attributes), attrs) : [];
    for (const d of attrDiffs) {
      attributeEvents.push({ fingerprint: item.fingerprint, attribute: d.attribute, previous: d.previous, next: d.next });
    }
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
    } else if (attrDiffs.length > 0) {
      // A changed attribute is an event on a KNOWN item, never a new item.
      changed.push({ item, kind: `attribute_change:${attrDiffs.map((d) => d.attribute).join(",")}`, previous: null });
    }
    // Same fingerprint, same value = the same source showing up again: never an alert.
  }

  // ---------------------------------------------------------------------
  // 3b. Comparable / baseline engine (deterministic, category-agnostic).
  // The population is ONLY real persisted findings plus this sweep's items.
  // No market claim is ever made without a calculated baseline.
  // ---------------------------------------------------------------------
  const settings = comparableSettings(
    { minComparables, allowBroadComparison: !!radar.allow_broad_comparison },
    recencyDays,
  );
  const currentObservations: Observation[] = items.map((item) => ({
    fingerprint: item.fingerprint,
    title: item.title,
    url: item.url,
    attributes: attributesFor(item) ?? asAttributeMap(existing.get(item.fingerprint)?.attributes ?? null) ?? {},
    numericValue: item.numeric_value,
    currency: item.currency,
    observedAt: new Date().toISOString(),
    detailFetched: detailByUrl.has(item.url),
  }));
  const currentKeys = new Set(currentObservations.map((o) => o.fingerprint));
  const persistedObservations: Observation[] = (existingRows ?? [])
    .filter((f) => !currentKeys.has(f.fingerprint))
    .map(asObservation);
  const population = [...currentObservations, ...persistedObservations];

  const baselines = new Map<string, BaselineResult>();
  let baselinesComputed = 0;
  let baselinesInsufficient = 0;
  if (specs.length > 0) {
    for (const subject of currentObservations) {
      const result = buildBaseline({ subject, population, specs, settings });
      baselines.set(subject.fingerprint, result);
      if (result.status === "computed") baselinesComputed += 1;
      else if (result.status === "insufficient_comparables") baselinesInsufficient += 1;
    }
  }
  // 3c. Progressive baselines: findings that were previously insufficient are
  // recomputed against the grown population and upgraded as soon as the
  // minimum sample size is genuinely reached. Thresholds are unchanged.
  let baselinesBackfilled = 0;
  if (specs.length > 0) {
    const pending = (existingRows ?? []).filter(
      (f) => !currentKeys.has(f.fingerprint) && f.baseline_status !== "computed",
    );
    for (const f of pending.slice(0, 200)) {
      const result = buildBaseline({ subject: asObservation(f), population, specs, settings });
      if (result.status !== "computed") continue;
      const { error } = await db
        .from("findings")
        .update({
          baseline: result as never,
          baseline_status: result.status,
          baseline_confidence: result.confidence,
          anomaly_score: result.anomalyScore,
          opportunity_score: result.opportunityScore,
          baseline_computed_at: new Date().toISOString(),
        })
        .eq("id", f.id);
      if (!error) baselinesBackfilled += 1;
    }
  }

  const baselineLine = (fingerprint: string): string => {
    const b = baselines.get(fingerprint);
    if (!b || b.status !== "computed") return `baseline: none — ${NO_BASELINE_PHRASE}`;
    return `baseline: ${b.statement} (anomaly ${b.anomalyScore}, opportunity ${b.opportunityScore})`;
  };

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
        "confidence is 0-1 and must reflect how well the sources support the claim. Never invent facts. " +
        "A pre-calculated market baseline may be attached to an item. You may only describe something as cheap, expensive, " +
        "underpriced, above/below market or a bargain when a baseline is present, and then only in the direction and " +
        "magnitude that the baseline states. When the baseline says none, you must instead say that there is insufficient " +
        "comparable data to judge market value. Never compute or estimate a market value yourself.",
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
    }\nsummary: ${c.item.summary}\n${baselineLine(c.item.fingerprint)}\nsource: ${c.item.url}`;
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
      if (alertBudget !== null && alertBudget <= 0) {
        record(
          c.item,
          false,
          "suppressed_plan_limit",
          "monthly alert allowance for the current plan is used up",
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
        baseline: (baselines.get(c.item.fingerprint) ?? { status: "not_computed", statement: NO_BASELINE_PHRASE }) as never,
        anomaly_score: baselines.get(c.item.fingerprint)?.anomalyScore ?? null,
        opportunity_score: baselines.get(c.item.fingerprint)?.opportunityScore ?? null,
        sources: [
          {
            title: doc?.title ?? c.item.title,
            url: c.item.url,
            publisher: doc?.publisher ?? null,
            published_at: safeDate(doc?.published_at),
            role: detailByUrl.has(c.item.url) ? "primary" : "discovery",
          },
          ...(discoveryByUrl.get(c.item.url) && discoveryByUrl.get(c.item.url) !== c.item.url
            ? [
                {
                  title: docByUrl.get(discoveryByUrl.get(c.item.url)!)?.title ?? "Discovery page",
                  url: discoveryByUrl.get(c.item.url)!,
                  publisher: docByUrl.get(discoveryByUrl.get(c.item.url)!)?.publisher ?? null,
                  published_at: null,
                  role: "secondary",
                },
              ]
            : []),
        ] as never,
      });
      if (error) {
        record(c.item, false, "error", `could not persist alert: ${error.message}`);
      } else {
        alertsCreated += 1;
        if (alertBudget !== null) alertBudget -= 1;
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
    const detail = detailByUrl.get(item.url);
    const attrs = detail?.attributes ?? asAttributeMap(prev?.attributes ?? null);
    const discoveryUrl = discoveryByUrl.get(item.url) ?? prev?.discovery_url ?? null;
    const attrChanged = attributeEvents.some((e) => e.fingerprint === item.fingerprint);
    const secondary = discoveryUrl && discoveryUrl !== item.url
      ? [{ url: discoveryUrl, role: "secondary", title: docByUrl.get(discoveryUrl)?.title ?? null }]
      : [];
    const { data: saved } = await db
      .from("findings")
      .upsert(
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
          attributes: (attrs ?? {}) as never,
          primary_url: detail ? item.url : (prev?.primary_url ?? null),
          discovery_url: discoveryUrl,
          secondary_sources: secondary as never,
          detail_status: detail
            ? "fetched"
            : selected.some((c) => c.url === item.url)
              ? "failed"
              : (prev?.detail_status ?? "not_attempted"),
          detail_fetched_at: detail ? now : (prev?.detail_fetched_at ?? null),
          availability: detail?.availability ?? prev?.availability ?? null,
          published_at: t.publishedAt,
          source_updated_at: t.updatedAt,
          event_date: t.eventDate,
          retrieved_at: t.retrievedAt,
          origin: prev ? prev.origin : isBaseline ? "baseline" : "incremental",
          last_changed_at: valueChanged || attrChanged ? now : (prev?.last_changed_at ?? null),
          last_run_id: runId,
          baseline: (baselines.get(item.fingerprint) ?? {}) as never,
          baseline_status: baselines.get(item.fingerprint)?.status ?? "not_computed",
          baseline_confidence: baselines.get(item.fingerprint)?.confidence ?? null,
          anomaly_score: baselines.get(item.fingerprint)?.anomalyScore ?? null,
          opportunity_score: baselines.get(item.fingerprint)?.opportunityScore ?? null,
          baseline_computed_at: baselines.get(item.fingerprint)?.status === "computed" ? now : null,
          last_seen_at: now,
        },
        { onConflict: "radar_id,fingerprint" },
      )
      .select("id")
      .maybeSingle();

    // Attribute-level change events: recorded against the EXISTING item.
    const events = attributeEvents.filter((e) => e.fingerprint === item.fingerprint);
    if (events.length > 0) {
      await db.from("finding_changes").insert(
        events.map((e) => ({
          radar_id: radar.id,
          user_id: radar.user_id,
          finding_id: saved?.id ?? null,
          run_id: runId,
          fingerprint: e.fingerprint,
          attribute: e.attribute,
          previous_value: e.previous?.value !== null && e.previous?.value !== undefined ? String(e.previous.value) : null,
          new_value: e.next.value !== null ? String(e.next.value) : null,
          previous_raw: e.previous?.raw ?? null,
          new_raw: e.next.raw,
        })),
      );
    }
  }

  if (decisions.length > 0) {
    await db.from("alert_decisions").insert(
      decisions.map((d) => ({ ...d, radar_id: radar.id, user_id: radar.user_id, run_id: runId })),
    );
  }

  const failed = research.failures > 0 && research.successes === 0;
  const baselineFindings = isBaseline ? items.length : 0;
  const incrementalFindings = isBaseline ? 0 : changed.length;

  const usableComparablesAfter = population.filter(isUsableComparable).length;
  const comparableCoverage =
    population.length > 0 ? Number(((usableComparablesAfter / population.length) * 100).toFixed(1)) : 0;

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
    candidates_discovered: candidates.length,
    candidates_selected: selected.length,
    detail_fetches_ok: detailFetchesOk,
    detail_fetches_failed: detailFetchesFailed,
    extractions_ok: extractionsOk,
    extractions_failed: extractionsFailed,
    attributes_extracted: attributesExtracted,
    attributes_missing: attributesMissing,
    items_merged: research.duplicatesRemoved,
    baselines_computed: baselinesComputed,
    baselines_insufficient: baselinesInsufficient,
    comparable_observations: population.length,
    detail_fetches_attempted: detailFetchesAttempted,
    detail_fetches_skipped_backoff: detailFetchesSkippedBackoff,
    detail_fetch_budget: detailFetchBudget,
    usable_comparables: usableComparablesAfter,
    comparable_coverage: comparableCoverage,
    baselines_backfilled: baselinesBackfilled,
    cost_ceiling: costCeiling,
    detail_cost_estimate: detailCostEstimate,
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
    sourcesRetrieved: allDocs.length,
    searchRequests: research.requests,
    searchFailures: research.failures,
    costEstimate: Number((research.costEstimate + detailCostEstimate).toFixed(4)),
    duplicatesRemoved: research.duplicatesRemoved,
    baselineFindings,
    incrementalFindings,
    suppressedBaseline,
    suppressedRecency,
    suppressedDuplicate,
    suppressedRelevance,
    candidatesDiscovered: candidates.length,
    candidatesSelected: selected.length,
    detailFetchesOk,
    detailFetchesFailed,
    extractionsOk,
    extractionsFailed,
    attributesExtracted,
    attributesMissing,
    indexPages: indexPages.length,
    detailCostEstimate,
    attributeChanges: attributeEvents.length,
    baselinesComputed,
    baselinesInsufficient,
    comparableObservations: population.length,
    detailFetchesAttempted,
    detailFetchesSkippedBackoff,
    detailFetchBudget,
    budgetReason,
    usableComparables: usableComparablesAfter,
    comparableCoverage,
    baselinesBackfilled,
    costCeiling,
  };
}
