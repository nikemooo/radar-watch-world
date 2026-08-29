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
import { computeNextRunAt } from "./schedule";
import { chatJson, MODELS } from "../ai/gateway.server";
import { researchQueries, type ResearchResult, type SearchDocument } from "../search/providers.server";
import { planDiscoveryQueries } from "../search/query-planner.server";
import { expandIndexPages } from "../search/index-expansion.server";
import type { IndexPriceHint } from "../search/index-rows";
import { asConfig, type RadarConfig } from "../radar-types";
import { startRunHeartbeat, type RunTracker } from "./heartbeat.server";
import type { RunPhase } from "./lifecycle";
import { reapStaleRuns, releaseRadar } from "./reaper.server";
import { createCheckpointStore, type CheckpointStore } from "./checkpoints.server";

import { discoverCandidates, harvestLinks, type CandidateItem } from "./candidates.server";
import { fetchDetailPages } from "../search/detail-fetch.server";
import { resolveListingUrl, type ResolvedListingUrl } from "../search/listing-url";
import { detectItemFamilies, looksLikeItemUrl } from "../search/url-shape";
import {
  asAttributeMap,
  diffAttributes,
  extractDetailAttributes,
  inferAttributeSchema,
  type ExtractedDetail,
} from "./attributes.server";
import type { AttributeSpec, AttributeValue } from "./normalize";
import {
  enrichFromEvidence,
  mergeAttributeMaps,
  missingKeys,
  type EvidenceDoc,
} from "./enrichment";
import {
  applyVisualEvidence,
  collectAttributeEvidence,
  imageEvidence,
  storableEvidence,
  structuredPrice,
  type AttributeEvidence,
  type ImageEvidence,
  type StoredEvidence,
} from "./evidence";
import { detectIdentifiers, mergeIdentifiers, presentableIdentifiers, type Identifier } from "./identifiers";
import { comparableIdentity, parseIdentity, type IdentitySource } from "./identity";
import { dedupeListings } from "./dedupe";

import { evaluateCriteria, radarConstraints, type MatchVerdict } from "./criteria";
import { classifyCandidateUrl, gateCandidates, marketAllowed } from "./candidate-gate";
import { SweepPaused } from "./slice";


import {
  COUNTRY_ATTRIBUTE,
  countryAttribute,
  countryConstraint,
  inferMarket,
  requiredMarkets,
} from "./geo";
import { buildHistory, hostPriority, type PriorityContext } from "@/lib/search/source-priority.server";
import { normalizeAttribute } from "./normalize";
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
  criteriaMatched?: number;
  criteriaRejected?: number;
  criteriaUnverified?: number;
  paginationPagesAttempted?: number;
  paginationPagesSucceeded?: number;
  paginationPagesBlocked?: number;
  indexesExhausted?: number;
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
  /**
   * A run row already claimed by the caller (see beginRun). The cycle then
   * updates that row instead of creating one, so the run is visible to the UI
   * from the moment the user pressed "Sök nu" — not only after research ends.
   */
  runId?: string | null | undefined;
  startedAt?: string | undefined;
  /** Heartbeat/phase writer owned by the caller (see startRadarSweep). */
  tracker?: RunTracker | undefined;
  /**
   * True when this invocation continues an already-claimed run. The cycle then
   * replays only the steps that never completed — every checkpointed step is
   * served from persisted state, so no provider is billed twice.
   */
  continuation?: boolean | undefined;
  /** Override the checkpoint store (tests). */
  checkpoints?: CheckpointStore | undefined;
  /**
   * Wall-clock time (ms epoch) after which this invocation stops between two
   * checkpointed steps and throws SweepPaused. The run remains claimed and is
   * carried forward by the next scheduler tick or UI poll.
   */
  deadlineAt?: number | undefined;
};


export type RunClaim = {
  runId: string | null;
  startedAt: string;
  runType: "baseline" | "incremental";
  scanPhase: "initial_scan" | "monitoring";
};

/** Thrown when a radar already has a live (heartbeating) run. */
export class ActiveRunError extends Error {
  constructor(
    public runId: string,
    public startedAt: string,
  ) {
    super("A sweep is already running for this radar.");
    this.name = "ActiveRunError";
  }
}

/**
 * Claim a run BEFORE any expensive work happens.
 *
 * Research + planning take tens of seconds. If the monitor_runs row were only
 * written afterwards, a refresh in that window would show the radar exactly as
 * it was before the click — which is precisely the "nothing happened" bug.
 * Claiming first makes the running state durable and pollable immediately.
 *
 * The claim is also the concurrency lock: radars.active_run_id is set with a
 * conditional update, so two simultaneous clicks can never start two sweeps
 * (and therefore never two parallel provider bills). Dead runs are reaped
 * first, so a lost worker never blocks a retry.
 */
/** Release the concurrency lock, but only if this run still owns it. */
async function clearRunLock(db: Db, radarId: string, runId: string): Promise<void> {
  await db.from("radars").update({ active_run_id: null }).eq("id", radarId).eq("active_run_id", runId);
}

export async function beginRun(db: Db, radar: RadarRow): Promise<RunClaim> {

  // Recover first: a stale lock from a killed worker must not block the user.
  await reapStaleRuns(db, { radarId: radar.id });

  const startedAt = new Date().toISOString();
  const isBaseline = !radar.baseline_completed;
  const runType: "baseline" | "incremental" = isBaseline ? "baseline" : "incremental";
  const scanPhase: "initial_scan" | "monitoring" = isBaseline ? "initial_scan" : "monitoring";
  const runId = crypto.randomUUID();

  // Atomic lock: only the update that finds active_run_id NULL wins.
  const { data: locked } = await db
    .from("radars")
    .update({
      active_run_id: runId,
      ...(isBaseline
        ? { scan_state: "INITIAL_SCAN_RUNNING", initial_scan_started_at: startedAt }
        : {}),
    })
    .eq("id", radar.id)
    .is("active_run_id", null)
    .select("id");

  if (!locked?.length) {
    const { data: open } = await db
      .from("monitor_runs")
      .select("id, started_at")
      .eq("radar_id", radar.id)
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(1);
    const existing = open?.[0];
    if (existing) throw new ActiveRunError(existing.id, existing.started_at);
    // The pointer survived its run: the owning run already finished (or never
    // persisted). Releasing exactly that finished owner is safe and unblocks
    // the radar; anything else is a genuine concurrent claim.
    const { data: current } = await db
      .from("radars")
      .select("active_run_id")
      .eq("id", radar.id)
      .maybeSingle();
    const staleId = current?.active_run_id ?? null;
    if (staleId) {
      const { data: owner } = await db
        .from("monitor_runs")
        .select("id, status")
        .eq("id", staleId)
        .maybeSingle();
      if (!owner || owner.status !== "running") {
        await releaseRadar(db, radar.id, staleId);
        const { data: retried } = await db
          .from("radars")
          .update({
            active_run_id: runId,
            ...(isBaseline
              ? { scan_state: "INITIAL_SCAN_RUNNING", initial_scan_started_at: startedAt }
              : {}),
          })
          .eq("id", radar.id)
          .is("active_run_id", null)
          .select("id");
        if (retried?.length) {
          // Lock acquired on the retry — fall through to run creation below.
        } else {
          throw new Error("A sweep is being claimed. Please check its status again.");
        }
      } else {
        throw new ActiveRunError(owner.id, startedAt);
      }
    } else {
      throw new Error("A sweep is being claimed. Please check its status again.");
    }
  }


  const { error } = await db.from("monitor_runs").insert({
    id: runId,
    radar_id: radar.id,
    user_id: radar.user_id,
    status: "running",
    run_type: runType,
    scan_phase: scanPhase,
    started_at: startedAt,
    heartbeat_at: startedAt,
    current_phase: "initializing",
  });
  if (error) {
    await releaseRadar(db, radar.id, runId);
    throw new Error(`Could not start the sweep: ${error.message}`);
  }

  return { runId, startedAt, runType, scanPhase };
}

export async function runRadarCycle(
  db: Db,
  radar: RadarRow,
  options: RunOptions = {},
): Promise<RunResult> {
  const config: RadarConfig = asConfig(radar.config);
  // Market Monitoring runs on its own engine. Dispatch before any product
  // state is set up so the two engines never share a code path.
  if (config.kind === "market_monitoring" && config.market) {
    const { runMarketCycle } = await import("../market/engine.server");
    return runMarketCycle(db, radar, options);
  }

  let alertBudget = options.alertBudget ?? null;
  const isBaseline = !radar.baseline_completed;
  const runType: "baseline" | "incremental" = isBaseline ? "baseline" : "incremental";
  const recencyDays = clampRecencyDays(radar.recency_days);

  // Claim the run first (or adopt the caller's claim) so the running state is
  // durable before any slow work starts.
  const claim: RunClaim =
    options.runId !== undefined && options.runId !== null
      ? {
          runId: options.runId,
          startedAt: options.startedAt ?? new Date().toISOString(),
          runType,
          scanPhase: isBaseline ? "initial_scan" : "monitoring",
        }
      : await beginRun(db, radar);
  const runId = claim.runId;
  const started = claim.startedAt;
  const scanPhase = claim.scanPhase;
  const ownsTracker = !options.tracker;
  const tracker: RunTracker = options.tracker ?? startRunHeartbeat(db, runId);
  // Resumability: expensive steps are checkpointed under this run id, so a
  // continuation after a lost worker replays nothing it already paid for.
  const checkpoints: CheckpointStore =
    options.checkpoints ?? createCheckpointStore(db, runId, radar.user_id, radar.id);
  let currentPhase: RunPhase = "initializing";
  const phase = (name: RunPhase, patch?: Database["public"]["Tables"]["monitor_runs"]["Update"]) => {
    currentPhase = name;
    return tracker.phase(name, { phase_started_at: new Date().toISOString(), ...patch });
  };
  const seenPhases = new Set<string>();
  /** Phase transition from inside a loop: written once, not per item. */
  const phaseOnce = async (name: RunPhase) => {
    if (seenPhases.has(name)) return;
    seenPhases.add(name);
    await phase(name);
  };

  /**
   * Run one expensive step exactly once per run.
   *
   * The contract is strict: `last_successful_operation` is written only AFTER
   * the checkpoint is durably stored, so the run row can never claim progress
   * the checkpoint table cannot back up. A failed checkpoint write throws and
   * the whole sweep fails honestly (lock released, radar restored) instead of
   * pretending to be resumable.
   */
  const deadlineAt = options.deadlineAt ?? null;
  /**
   * True when this invocation stopped on its slice deadline rather than
   * finishing. The run then stays claimed (and locked) so the next invocation
   * resumes it from the checkpoint just written.
   */
  let paused = false;
  const step = async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    const resumedBefore = checkpoints.resumedSteps;
    const value = await checkpoints.step(key, fn, { phase: currentPhase });
    const fresh = checkpoints.resumedSteps === resumedBefore;
    if (fresh) await patchRun({ last_successful_operation: key });
    if (fresh && deadlineAt !== null && Date.now() > deadlineAt) {
      paused = true;
      throw new SweepPaused(currentPhase, key);
    }
    return value;
  };


  const patchRun = async (patch: Database["public"]["Tables"]["monitor_runs"]["Update"]) => {
    if (!runId) return;
    await db
      .from("monitor_runs")
      .update({ ...patch, heartbeat_at: new Date().toISOString() })
      .eq("id", runId);
  };

  try {
    if (runId) {
      await db
        .from("monitor_runs")
        .update({
          worker_started_at: new Date().toISOString(),
          heartbeat_at: new Date().toISOString(),
          ...(options.continuation
            ? {}
            : { continuation_count: 0, attempt: 1, worker_finished_at: null }),
        })
        .eq("id", runId);
    }
    return await runCycleBody();
  } finally {
    if (ownsTracker) tracker.stop();
    // Whatever happened, the radar must not stay locked — unless this
    // invocation only paused, in which case the run still owns the radar.
    if (runId && !paused) await clearRunLock(db, radar.id, runId);
  }


  // eslint-disable-next-line no-inner-declarations
  async function runCycleBody(): Promise<RunResult> {


  // Discovery strategy: a single broad natural-language query mostly returns
  // editorial/specification pages. The planner expands the radar's own
  // configuration into several short, market-shaped queries (generic — it has
  // no per-category or per-site knowledge).
  await phase("query_planning");
  const plannedQueries = await step("query_planning", () =>
    planDiscoveryQueries(config, radar.raw_request, isBaseline ? 8 : 6),
  );
  const queries = plannedQueries.map((q) => q.query);
  console.info(
    `[radar:queries] ${radar.id} planned ${queries.length}: ${plannedQueries
      .map((q) => `${q.intent}/${q.origin}: ${q.query}`)
      .join(" | ")}`,
  );
  await phase("searching_sources");

  // Search one query per checkpoint. Previously the whole 6-8 query batch was
  // one checkpoint: if the runtime ended after query 7, the persisted run still
  // said zero sources and a continuation paid for every query again. Each
  // provider response is now durable and reflected in live telemetry before
  // the next request starts.
  const researchParts: ResearchResult[] = [];
  const seenResearchUrls = new Set<string>();
  let firstCandidatesPersisted = false;
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex];
    if (!query) continue;
    const part = await step(`research:${queryIndex}`, () =>
      researchQueries([query], isBaseline ? 10 : 8, 1),
    );
    researchParts.push(part);

    const uniquePartDocs = part.documents.filter((doc) => {
      if (seenResearchUrls.has(doc.url)) return false;
      seenResearchUrls.add(doc.url);
      return true;
    });
    const requests = researchParts.reduce((sum, item) => sum + item.requests, 0);
    const successes = researchParts.reduce((sum, item) => sum + item.successes, 0);
    const failures = researchParts.reduce((sum, item) => sum + item.failures, 0);
    const sources = seenResearchUrls.size;
    const cost = researchParts.reduce((sum, item) => sum + item.costEstimate, 0);
    await patchRun({
      provider: part.provider,
      search_requests: requests,
      search_successes: successes,
      search_failures: failures,
      sources_retrieved: sources,
      cost_estimate: Number(cost.toFixed(4)),
      // A provider failure that the fallback recovered from is technical
      // information, not a run error: the user still gets real results.
      error:
        successes > 0
          ? researchParts.some((item) => item.fallbackUsed)
            ? `Primary discovery provider unavailable — answered by fallback provider ${part.provider}.`
            : null
          : researchParts.flatMap((item) => item.errors).join(" | ").slice(0, 800) || null,
    });

    if (uniquePartDocs.length > 0) {
      await db.from("research_sources").upsert(
        uniquePartDocs.map((doc) => ({
          radar_id: radar.id,
          user_id: radar.user_id,
          run_id: runId,
          provider: part.provider ?? "search",
          query: doc.query,
          url: doc.url,
          title: doc.title,
          publisher: doc.publisher ?? null,
          published_at: safeDate(doc.published_at),
          retrieved_at: doc.retrieved_at,
          last_seen_at: doc.retrieved_at,
          snippet: doc.snippet.slice(0, 4000),
        })),
        { onConflict: "radar_id,url,retrieved_at", ignoreDuplicates: true },
      );
    }

    // Produce visible inventory from the first useful local-market response;
    // the full candidate pass below still expands indexes and replaces these
    // placeholders with verified findings.
    if (!firstCandidatesPersisted && seenResearchUrls.size > 0) {
      // Do not put another AI call between the first provider response and the
      // first visible inventory. Repeating URL families are deterministic
      // evidence of item pages and direct result URLs are accepted only when
      // their path has an item shape. The richer AI discovery still runs later.
      const earlyDocs = researchParts.flatMap((item) => item.documents);
      const earlyCandidates: CandidateItem[] = [];
      for (const doc of earlyDocs) {
        const familyUrls = detectItemFamilies(harvestLinks(doc), doc.url)
          .flatMap((family) => family.urls)
          .slice(0, 30);
        const urls = familyUrls.length > 0 ? familyUrls : looksLikeItemUrl(doc.url) ? [doc.url] : [];
        for (const url of urls) {
          earlyCandidates.push({
            title: url === doc.url ? doc.title : doc.title || url,
            url,
            discovery_url: doc.url,
            individual: true,
            likelihood: familyUrls.includes(url) ? 0.9 : 0.7,
            relevance: 0.5,
            clue: null,
          });
        }
      }
      const now = new Date().toISOString();
      const provisional = earlyCandidates
        .filter((candidate) => candidate.url && candidate.individual)
        .slice(0, 30)
        .map((candidate) => ({
          radar_id: radar.id,
          user_id: radar.user_id,
          fingerprint: `provisional:${candidate.url}`,
          title: candidate.title || String(candidate.url),
          url: String(candidate.url),
          snapshot: { match_status: "pending", match_reason: "being checked", images: [] } as never,
          attributes: {} as never,
          discovery_url: candidate.discovery_url,
          detail_status: "not_attempted",
          origin: isBaseline ? "baseline" : "incremental",
          last_run_id: runId,
          first_seen_at: now,
          last_seen_at: now,
        }));
      if (provisional.length > 0) {
        await db.from("findings").upsert(provisional, { onConflict: "radar_id,fingerprint" });
        await patchRun({
          candidates_discovered: provisional.length,
          persisted_findings: provisional.length,
          first_useful_result_at: now,
        });
        firstCandidatesPersisted = true;
      }
    }
  }

  const research: ResearchResult = {
    configured: researchParts.some((part) => part.configured),
    provider: researchParts.find((part) => part.provider)?.provider ?? null,
    documents: researchParts.flatMap((part) => part.documents).filter((doc, index, all) =>
      all.findIndex((candidate) => candidate.url === doc.url) === index,
    ),
    requests: researchParts.reduce((sum, part) => sum + part.requests, 0),
    successes: researchParts.reduce((sum, part) => sum + part.successes, 0),
    failures: researchParts.reduce((sum, part) => sum + part.failures, 0),
    costEstimate: Number(researchParts.reduce((sum, part) => sum + part.costEstimate, 0).toFixed(4)),
    rawResults: researchParts.reduce((sum, part) => sum + part.rawResults, 0),
    duplicatesRemoved: researchParts.reduce((sum, part) => sum + part.duplicatesRemoved, 0),
    errors: researchParts.flatMap((part) => part.errors),
    attempts: researchParts.flatMap((part) => part.attempts ?? []),
    fallbackUsed: researchParts.some((part) => part.fallbackUsed),
    // Only "discovery is down" when NO query was answered by ANY provider.
    discoveryFailed:
      researchParts.length > 0 && researchParts.every((part) => part.discoveryFailed === true),
  };

  if (research.fallbackUsed) {
    console.info(
      `[radar:discovery] ${radar.id} primary provider unavailable — answered by fallback provider ${research.provider}`,
    );
  }

  if (!research.configured) {
    await patchRun({
      status: "no_provider",
      error: "No search provider configured",
      finished_at: new Date().toISOString(),
    });
    if (isBaseline) {
      await db.from("radars").update({ scan_state: "initial_scan_pending" }).eq("id", radar.id);
    }
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

  await patchRun({
    provider: research.provider,
    search_requests: research.requests,
    search_successes: research.successes,
    search_failures: research.failures,
    sources_retrieved: research.documents.length,
    cost_estimate: research.costEstimate,
  });


  // ---------------------------------------------------------------------
  // Source priority. Learned from this radar's own history (which hosts
  // actually produced listings that passed the criteria gate, and which hosts
  // can be read at all) plus the market the radar asked for. It only ORDERS
  // sources — nothing is filtered away, so new sources stay discoverable.
  // ---------------------------------------------------------------------
  const markets = requiredMarkets(config.locations);
  const [{ data: priorFindings }, { data: priorHosts }] = await Promise.all([
    db.from("findings").select("url, primary_url, snapshot").eq("radar_id", radar.id).limit(500),
    db.from("source_fetch_stats").select("host, attempts, successes").eq("user_id", radar.user_id),
  ]);
  const priorityContext: PriorityContext = {
    markets,
    history: buildHistory(priorFindings ?? [], priorHosts ?? []),
  };
  const priorityOf = (host: string) => hostPriority(host, priorityContext).score;
  const geoResolvedUrls = new Set<string>();
  if (markets.length > 0) {
    console.info(
      `[radar:geo] ${radar.id} required market(s): ${markets.map((m) => m.name).join(", ")}`,
    );
  }


  // Index-page expansion: any retrieved page that links to a repeating family
  // of item URLs is re-read at full width so the concrete listing URLs it
  // contains become visible to candidate discovery. Purely structural — no
  // site-specific rules, and no URL is ever invented.
  let indexExpansionCost = 0;
  let indexPriceHints = new Map<string, IndexPriceHint>();
  let ambiguousPriceList: { itemUrl: string; values: string[]; sourceUrl: string }[] = [];
  let indexCards = new Map<string, { itemUrl: string; text: string; sourceUrl: string }>();
  let indexCardsUsed = 0;
  const indexTelemetry = {
    index_pages_fetched: 0,
    index_pages_expanded: 0,
    index_prices_joined: 0,
    ambiguous_price_joins: 0,
    pages_attempted: 0,
    pages_succeeded: 0,
    pages_blocked: 0,
    pages_skipped: 0,
    indexes_exhausted: 0,
  };
  try {
    await phase("expanding_indexes");
    const expansion = await step("index_expansion", () =>
      expandIndexPages(
        research.documents,
        isBaseline ? 14 : 8,
        (isBaseline ? 14 : 8) * 3,
        priorityOf,
      ),
    );
    research.documents = expansion.documents;
    indexExpansionCost = expansion.costEstimate;
    indexPriceHints = expansion.priceHints;
    ambiguousPriceList = expansion.ambiguousPrices;
    indexCards = expansion.indexCards;
    Object.assign(indexTelemetry, expansion.telemetry);
    for (const e of expansion.expanded) {
      console.info(
        `[radar:index] expanded ${e.url} — ${e.pagesRead} page(s), ${e.linkCount} links, ${e.textLength} chars, ` +
          `item URLs: ${e.itemUrls.length}, row prices: ${e.pricesJoined}, ambiguous: ${e.ambiguousPrices}`,
      );
    }
    for (const f of expansion.failures) console.warn(`[radar:index] ${f.url} — ${f.reason}`);
  } catch (err) {
    console.warn(`[radar:index] expansion failed — ${(err as Error).message}`);
  }

  if (research.documents.length > 0) {
    await db.from("research_sources").upsert(
      research.documents.map((d) => ({
        radar_id: radar.id,
        user_id: radar.user_id,
        run_id: runId,
        provider: research.provider ?? "search",
        query: d.query,
        url: d.url,
        title: d.title,
        publisher: d.publisher ?? null,
        published_at: safeDate(d.published_at),
        retrieved_at: d.retrieved_at,
        last_seen_at: d.retrieved_at,
        snippet: d.snippet.slice(0, 4000),
      })),
      { onConflict: "radar_id,url,retrieved_at", ignoreDuplicates: true },
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
      specs = await step("attribute_schema", () =>
        inferAttributeSchema(`${radar.name}\n${radar.raw_request}`),
      );
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
  // The initial market scan is meant to be comprehensive, so it may spend more
  // of the radar's budget than a routine monitoring sweep — still hard-capped.
  const costCeiling = Math.max(0.005, Number(radar.max_sweep_cost ?? 0.06)) * (isBaseline ? 2 : 1);


  // Persisted state is loaded BEFORE the detail stage so the fetch policy can
  // aim the budget at items that actually improve comparable coverage.
  const { data: existingRows } = await db
    .from("findings")
    .select("*")
    .eq("radar_id", radar.id)
    .not("fingerprint", "like", "provisional:%");
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

  // Machine-checkable requirements are known before extraction: the enrichment
  // pass uses them to know which terms it must try hardest to read from the
  // page (it never assumes them — a term must literally appear in a source).
  const constraints = radarConstraints({
    hard_constraints: config.hard_constraints,
    price_min: config.price_min,
    price_max: config.price_max,
    currency: config.currency,
    attribute_schema: specs,
  });
  // A radar that named exactly one market gets a machine-checkable country
  // requirement. A listing proven to be elsewhere is rejected; a listing whose
  // market could not be established stays unverified — never a match.
  const geoConstraint = countryConstraint(config.locations);
  if (geoConstraint && !constraints.some((c) => c.attribute === COUNTRY_ATTRIBUTE)) {
    constraints.push(geoConstraint);
  }


  let candidates: CandidateItem[] = [];
  let indexPages: string[] = [];
  let selected: CandidateItem[] = [];
  let details: ExtractedDetail[] = [];
  let detailFetchesOk = 0;
  let detailFetchesFailed = 0;
  let listingsRemoved = 0;

  let extractionsOk = 0;
  let extractionsFailed = 0;
  let attributesExtracted = 0;
  let attributesMissing = 0;
  let detailCostEstimate = 0;
  let detailFetchesAttempted = 0;
  let detailFetchesSkippedBackoff = 0;
  let indexPricesApplied = 0;
  let unknownPrices = 0;
  let detailFetchBudget = 0;
  let budgetReason = "detail stage not reached";
  const imageByUrl = new Map<string, { url: string; source: string; images: string[] }>();
  /** Per-item evidence: what is known, how strongly, and from which surface. */
  const attributeEvidenceByUrl = new Map<string, Record<string, AttributeEvidence>>();
  const identifiersByUrl = new Map<string, Identifier[]>();
  const imageEvidenceByUrl = new Map<string, ImageEvidence>();
  /** Every retrieved surface per item URL, used for canonical identity resolution. */
  const identitySourcesByUrl = new Map<string, IdentitySource[]>();

  let structuredPricesApplied = 0;
  let evidenceConflicts = 0;
  let visualObservations = 0;
  let identifiersFound = 0;

  /** Verified direct listing URL per requested candidate URL. */
  const linkByUrl = new Map<string, ResolvedListingUrl>();
  let directLinksVerified = 0;
  let extractionAttempted = 0;
  let extractionAiCalls = 0;
  let jsonldFound = 0;
  let ogDataFound = 0;
  let imagesFound = 0;
  let evidenceMergeCount = 0;
  let attributesVerified = 0;
  const extractionSourcesUsed = new Set<string>();
  const detailDocs: SearchDocument[] = [];
  const discoveryByUrl = new Map<string, string>();

  if (research.documents.length > 0) {
    try {
      await phase("extracting_candidates");
      const discovery = await step("candidates", () =>
        discoverCandidates(research.documents, criteria),
      );
      candidates = discovery.candidates;
      indexPages = discovery.indexPages;

      // ---------- CHEAP DETERMINISTIC GATE (before any paid work) ----------
      // A search/category page is never a listing, and a source whose
      // country-code TLD proves another market than the radar asked for can be
      // dropped without spending a single fetch or AI token on it.
      {
        const gate = gateCandidates({
          candidates,
          indexUrls: [...indexPages, ...research.documents.map((d) => d.url)],
          markets: requiredMarkets(config.locations),
        });
        if (gate.kept.length > 0) {
          console.info(
            `[radar:gate] ${candidates.length} candidate(s) → ${gate.kept.length} listing(s); dropped ${gate.searchPages} non-listing page(s), ${gate.offMarket} off-market source(s)`,
          );
          candidates = gate.kept;
        } else {
          // Never starve the sweep: with no provable listing URL we keep the
          // market-eligible candidates and let link resolution mark them
          // "unverified" so the UI says "Öppna källa", not "Öppna annons".
          console.warn("[radar:gate] no candidate passed the listing gate — keeping market-eligible candidates");
          const markets = requiredMarkets(config.locations);
          candidates = candidates.filter((c) => !c.url || marketAllowed(c.url, markets));
        }
      }

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

      // Incremental visibility: persist discovered item candidates immediately as
      // "pending" findings so the UI can show them while the sweep continues.
      // They are replaced by the real finding once extraction settles, and any
      // leftovers are removed at the end of the persist phase.
      const knownUrls = new Set(
        (existingRows ?? []).flatMap((f) => [f.primary_url, f.url].filter(Boolean) as string[]),
      );
      const provisional = candidates
        .filter((c) => c.url && c.individual && !knownUrls.has(c.url))
        .slice(0, 60)
        .map((c) => ({
          radar_id: radar.id,
          user_id: radar.user_id,
          fingerprint: `provisional:${c.url}`,
          title: c.title || (c.url as string),
          url: c.url as string,
          snapshot: { match_status: "pending", match_reason: "being checked", images: [] } as never,
          attributes: {} as never,
          discovery_url: c.discovery_url,
          detail_status: "not_attempted",
          origin: isBaseline ? "baseline" : "incremental",
          last_run_id: runId,
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        }));
      // Clear placeholders left behind by an interrupted earlier sweep.
      await db.from("findings").delete().eq("radar_id", radar.id).like("fingerprint", "provisional:%");
      if (provisional.length > 0) {
        await db.from("findings").upsert(provisional, { onConflict: "radar_id,fingerprint" });
      }

      const fetchable = candidates.filter((c) => c.url && c.individual).length;
      const budgetPlan = adaptiveBudget({
        configured: Math.min(
          // Phase 1 aims for full inventory coverage rather than the first few results.
          Number(radar.max_detail_fetches ?? 8) * (isBaseline ? 2 : 1),
          (options.maxDetailFetches ?? Number.MAX_SAFE_INTEGER) * (isBaseline ? 2 : 1),
        ),

        frequency: radar.frequency,
        comparableGap: specs.length > 0 ? comparableGap : 0,
        fetchableCandidates: fetchable,
        spentCost: research.costEstimate + indexExpansionCost,
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
        await phase("fetching_details");
        const fetched = await step("detail_pages", () =>
          fetchDetailPages(selected.map((c) => c.url!)),
        );
        // Real listing imagery only — captured from the item's own page, with
        // its provenance. A missing image is left missing; nothing is invented.
        for (const p of fetched.pages) {
          const images = (p.images ?? []).filter(Boolean);
          const evidence = imageEvidence({
            pageUrl: p.url,
            primary: p.image,
            images,
            sourceUrl: p.image_source ?? p.url,
          });
          imageEvidenceByUrl.set(p.url, evidence);
          if (evidence.status === "from_listing") {
            imageByUrl.set(p.url, {
              url: evidence.primary!,
              source: evidence.sourceUrl ?? p.url,
              images: evidence.images,
            });
            imagesFound += evidence.images.length;
          } else {
            console.info(`[radar:image] ${p.url} — no listing image published (shown as unavailable)`);
          }

          // Direct listing URL: canonical > served URL > requested URL, and
          // only ever labelled "direct" when the URL addresses one item.
          const link = resolveListingUrl({
            requestedUrl: p.url,
            finalUrl: p.final_url,
            canonical: p.structured?.canonical ?? null,
          });
          linkByUrl.set(p.url, link);
          if (link.status === "direct") directLinksVerified += 1;
        }
        detailFetchesOk = fetched.pages.length;
        detailFetchesFailed = fetched.failures.length;
        detailCostEstimate = fetched.costEstimate;
        for (const f of fetched.failures) {
          console.warn(`[radar:detail] could not fetch ${f.url} — ${f.reason}`);
        }
        // A listing whose own page is proven gone (404/410) is recorded as
        // removed on the SAME finding — history is never deleted.
        {
          const { removedListings } = await import("./availability");
          const known = new Map<string, (typeof existingRows extends (infer R)[] | null ? R : never)>();
          for (const row of existingRows ?? []) {
            for (const u of [row.primary_url, row.url]) if (u) known.set(u, row);
          }
          for (const gone of removedListings(fetched.failures, known.keys())) {
            const row = known.get(gone.url)!;
            if (row.availability === "removed") continue;
            await db.from("findings").update({ availability: "removed" }).eq("id", row.id);
            await db.from("finding_changes").insert({
              radar_id: radar.id,
              user_id: radar.user_id,
              finding_id: row.id,
              run_id: runId,
              fingerprint: row.fingerprint,
              attribute: "availability",
              previous_value: row.availability ?? "available",
              new_value: "removed",
              previous_raw: row.availability ?? "available",
              new_raw: gone.reason,
            });
            listingsRemoved += 1;
          }
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
          // ---------- STRUCTURED EXTRACTION + EVIDENCE MERGING ----------
          // Every retrieved surface for the same item is read deterministically
          // first: JSON-LD, OpenGraph/meta, spec tables, page title, page text,
          // the index card it was discovered in, and the search snippet. Only
          // what is literally written is used, and the AI pass afterwards is
          // limited to whatever is still missing (cost control).
          const snippetByUrl = new Map(research.documents.map((d) => [d.url, d]));
          const evidenceByUrl = new Map<string, EvidenceDoc[]>();
          const deterministic = new Map<string, Record<string, AttributeValue>>();

          for (const page of fetched.pages) {
            extractionAttempted += 1;
            const docs: EvidenceDoc[] = [];
            const st = page.structured;
            if (st) {
              if (Object.keys(st.jsonld).length > 0) {
                jsonldFound += 1;
                docs.push({ url: page.url, sourceType: "jsonld", fields: st.jsonld, text: Object.values(st.jsonld).join(" ") });
              }
              if (Object.keys(st.og).length > 0) {
                ogDataFound += 1;
                docs.push({
                  url: page.url,
                  sourceType: "opengraph",
                  title: st.og["title"] ?? null,
                  text: st.og["description"] ?? "",
                  fields: st.og,
                });
              }
              if (Object.keys(st.meta).length > 0) {
                docs.push({ url: page.url, sourceType: "meta", text: st.meta["description"] ?? "", fields: st.meta });
              }
              if (Object.keys(st.fields).length > 0) {
                docs.push({ url: page.url, sourceType: "detail_field", fields: st.fields });
              }
            }
            docs.push({ url: page.url, sourceType: "detail_title", title: page.title });
            docs.push({ url: page.url, sourceType: "detail_text", text: page.text });
            const card = indexCards.get(page.url) ?? indexCards.get(`${page.url}/`);
            if (card) {
              indexCardsUsed += 1;
              docs.push({ url: card.sourceUrl, sourceType: "index_card", title: card.text.slice(0, 200), text: card.text });
            }
            const snippet = snippetByUrl.get(page.url);
            if (snippet) {
              docs.push({ url: page.url, sourceType: "search_snippet", title: snippet.title, text: snippet.snippet });
            }
            evidenceByUrl.set(page.url, docs);
            // Identity is resolved over EVERY surface, so a structured field on
            // one page and a title on another can jointly prove the product.
            identitySourcesByUrl.set(
              page.url,
              docs.map((d) => ({
                sourceType: d.sourceType,
                url: d.url,
                text: [d.title ?? "", d.text ?? "", Object.entries(d.fields ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n")]
                  .filter(Boolean)
                  .join("\n")
                  .slice(0, 20000),
              })),
            );

            const enriched = enrichFromEvidence(specs, docs, constraints);
            // Geography is derived from explicit evidence only (host ccTLD,
            // stated address country, or the country written on the page).
            const geoAttribute = countryAttribute(
              inferMarket({
                url: page.url,
                fields: { ...(st?.jsonld ?? {}), ...(st?.og ?? {}), ...(st?.meta ?? {}), ...(st?.fields ?? {}) },
                text: `${page.title ?? ""}\n${page.text.slice(0, 4000)}`,
              }),
            );
            if (geoAttribute) {
              enriched.attributes[COUNTRY_ATTRIBUTE] = geoAttribute;
              geoResolvedUrls.add(page.url);
            }
            deterministic.set(page.url, enriched.attributes);
            evidenceMergeCount += enriched.telemetry.mergeCount;
            for (const src of enriched.telemetry.sourcesUsed) extractionSourcesUsed.add(src);

            // Per-surface evidence: read each source on its own so agreement
            // and contradiction between them stays observable.
            const perAttribute = collectAttributeEvidence(specs, docs);
            attributeEvidenceByUrl.set(page.url, perAttribute);
            for (const e of Object.values(perAttribute)) {
              if (e.status === "conflicted") {
                evidenceConflicts += 1;
                console.info(`[radar:evidence] ${page.url} — ${e.explanation}`);
              }
            }

            // Generic identity: VIN, registration, reference, serial, GTIN…
            const identifiers = mergeIdentifiers([
              detectIdentifiers({ url: page.url, fields: st?.fields ?? {} }),
              detectIdentifiers({ url: page.url, fields: st?.jsonld ?? {} }),

              detectIdentifiers({ url: page.url, text: `${page.title ?? ""}\n${page.text.slice(0, 8000)}` }),
            ]);
            const presentable = presentableIdentifiers(identifiers);
            if (presentable.length > 0) {
              identifiersByUrl.set(page.url, presentable);
              identifiersFound += presentable.length;
            }

          }

          // AI extraction runs ONLY for pages that still miss attributes.
          const needsAi = fetched.pages.filter(
            (p) => missingKeys(specs, deterministic.get(p.url) ?? {}).length > 0,
          );
          const augmented = needsAi.map((page) => {
            const card = indexCards.get(page.url) ?? indexCards.get(`${page.url}/`);
            const structuredText = page.structured
              ? `\n\n[structured data on this page]\n${Object.entries({
                  ...page.structured.jsonld,
                  ...page.structured.og,
                  ...page.structured.fields,
                })
                  .slice(0, 60)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join("\n")}`
              : "";
            const cardText = card ? `\n\n[listing card for this item, as printed on ${card.sourceUrl}]\n${card.text}` : "";
            return { ...page, text: `${page.text}${structuredText}${cardText}`.slice(0, 12000) };
          });

          let aiDetails: ExtractedDetail[] = [];
          let aiFailures: { url: string; reason: string }[] = [];
          if (augmented.length > 0) {
            extractionAiCalls += 1;
            await phaseOnce("extracting_attributes");
            const extracted = await step("ai_extraction", () =>
              extractDetailAttributes(augmented, specs, criteria),
            );
            aiDetails = extracted.details;
            aiFailures = extracted.failures;
          }
          const aiByUrl = new Map(aiDetails.map((d) => [d.url, d]));

          // Merge: deterministic evidence first, AI only where it fills a gap.
          details = fetched.pages.map((page) => {
            const base = deterministic.get(page.url) ?? {};
            const ai = aiByUrl.get(page.url);
            const { merged, merges } = mergeAttributeMaps(base, ai?.attributes ?? {});
            evidenceMergeCount += merges;
            // The synthetic country attribute is evidence, not part of the
            // radar's declared schema, so it never skews coverage counters.
            const extracted = Object.values(merged).filter(
              (a) => a.key !== COUNTRY_ATTRIBUTE && a.confidence !== "unknown",
            ).length;
            attributesVerified += Object.values(merged).filter(
              (a) => a.confidence === "structured" || a.confidence === "stated",
            ).length;
            return {
              url: page.url,
              title: ai?.title ?? page.title,
              attributes: merged,
              availability: ai?.availability ?? null,
              extracted,
              missing: specs.length - extracted,
            } satisfies ExtractedDetail;
          });
          extractionsOk = details.filter((d) => d.extracted > 0).length;
          extractionsFailed = aiFailures.filter((f) => (deterministic.get(f.url) ?? {}) && !details.some((d) => d.url === f.url && d.extracted > 0)).length;

          // Index-row price provenance: when a detail page is client-rendered
          // and states no value, the value printed in that item's own card on
          // the index page it was discovered on may be used. The join is by
          // exact item URL only, and only when that card held exactly one
          // price — otherwise the value stays unknown.
          const valueSpec = valueKey ? specs.find((s) => s.key === valueKey) : undefined;
          if (valueSpec) {
            const structuredByUrl = new Map(fetched.pages.map((p) => [p.url, p.structured]));
            for (const d of details) {
              const current = d.attributes[valueSpec.key];
              if (current?.raw) {
                console.info(`[radar:price] ${d.url} — price from detail page (${current.raw})`);
                continue;
              }
              // Structured commerce metadata states a price far more often than
              // the prose does on client-rendered marketplaces.
              const st = structuredByUrl.get(d.url);
              const fromStructured = st
                ? structuredPrice({ ...st.jsonld, ...st.og, ...st.meta, ...st.fields })
                : null;
              if (fromStructured) {
                d.attributes[valueSpec.key] = normalizeAttribute(
                  valueSpec,
                  fromStructured.raw,
                  "structured",
                  d.url,
                );
                structuredPricesApplied += 1;
                d.extracted += 1;
                d.missing = Math.max(0, d.missing - 1);
                console.info(`[radar:price] ${d.url} — price from structured metadata (${fromStructured.raw})`);
                continue;
              }
              const hint = indexPriceHints.get(d.url) ?? indexPriceHints.get(`${d.url}/`);

              if (hint && hint.value !== null) {
                d.attributes[valueSpec.key] = {
                  ...normalizeAttribute(valueSpec, hint.raw, "structured", hint.sourceUrl),
                  origin: "index",
                };
                indexPricesApplied += 1;
                d.extracted += 1;
                d.missing = Math.max(0, d.missing - 1);
                console.info(
                  `[radar:price] ${d.url} — price joined from index row "${hint.raw}" (source ${hint.sourceUrl})`,
                );
              } else {
                unknownPrices += 1;
                const ambiguous = ambiguousPriceList.find((a) => a.itemUrl === d.url);
                console.info(
                  `[radar:price] ${d.url} — price unknown (` +
                    (ambiguous
                      ? `ambiguous index row: ${ambiguous.values.join(" / ")}`
                      : "no price on detail page and no unambiguous index row") +
                    ")",
                );
              }
            }
          }

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
    await db
      .from("monitor_runs")
      .update({
        ...patch,
        current_phase: "completed",
        heartbeat_at: new Date().toISOString(),
        worker_finished_at: new Date().toISOString(),
        termination_reason: patch.status === "completed" || patch.status === "ok" ? "completed" : "finished_with_error",
      })
      .eq("id", runId);
  };

  if (research.documents.length === 0) {
    const failedAll = research.requests > 0 && research.successes === 0;
    await finishRun({
      status: failedAll ? "failed" : "completed",
      error: failedAll
        ? (research.discoveryFailed
            ? "Discovery unavailable — no search provider could be reached. This is not an empty market; Radar retries automatically. "
            : "") + research.errors.join(" | ").slice(0, 600)
        : null,
      finished_at: new Date().toISOString(),
    });
    // A failed initial scan is never marked complete — it must be retried.
    await db
      .from("radars")
      .update({
        last_run_at: new Date().toISOString(),
        // The next recurring sweep is scheduled server-side, so cadence never
        // depends on anyone having the app open.
        next_run_at: computeNextRunAt(radar.frequency, new Date(), radar.status),
        ...(isBaseline ? { scan_state: "initial_scan_pending" } : {}),
      })
      .eq("id", radar.id);

    return {
      status: failedAll ? "error" : "ok",
      runType,
      message: failedAll
        ? research.discoveryFailed
          ? "Market discovery could not be completed right now — every search provider was unavailable. This does not mean there are no listings; Radar will retry automatically."
          : `Search provider error: ${research.errors[0] ?? "unknown error"}`
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
${documentBlock(allDocs.slice(0, 45))}`,
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
    // A shop front page or a filtered result list is a SOURCE, never an item.
    // Dropping it here is what keeps "12 hittade annonser" honest.
    const kind = classifyCandidateUrl(i.url);
    if (kind === "aggregator" || kind === "search_page") {
      console.info(`[radar:gate] item dropped — ${kind} presented as listing: ${i.url}`);
      return false;
    }
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

  // Listing-level deduplication: the same advert reached through a slugged URL,
  // an id-only URL, an AMP mirror or a re-slug is ONE result, not four.
  const listingDedupe = dedupeListings(
    items.map((item) => ({ ...item, identifiers: identifiersByUrl.get(item.url) ?? [] })),
  );
  for (const gone of listingDedupe.removed) {
    console.info(`[radar:dedupe] ${gone.rule} — ${gone.url} is the same listing as ${gone.duplicateOf}`);
  }
  const listingDuplicatesRemoved = listingDedupe.removed.length;
  items.length = 0;
  items.push(...listingDedupe.kept.map(({ identifiers: _identifiers, ...item }) => item as ExtractedItem));


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

  // ------------------------------------------------------------------
  // 2b. Deterministic criteria matching.
  // Arithmetic and string containment over STATED facts only — no model, no
  // "probably". Every item gets match / reject / unverified plus the exact
  // reason, and only a confirmed match may ever reach the alert pipeline.
  // ------------------------------------------------------------------
  await phase("evaluating_criteria");
  const verdicts = new Map<string, MatchVerdict>();
  let criteriaMatched = 0;
  let criteriaRejected = 0;
  let criteriaUnverified = 0;
  for (const item of items) {
    const attributes = {
      ...(attributesFor(item) ?? asAttributeMap(existing.get(item.fingerprint)?.attributes ?? null) ?? {}),
    };
    // Items that never got a detail read can still carry structural geography
    // (the item URL's own country-code TLD). Text is not consulted here.
    if (!attributes[COUNTRY_ATTRIBUTE]) {
      const geoAttribute = countryAttribute(inferMarket({ url: item.url }));
      if (geoAttribute) {
        attributes[COUNTRY_ATTRIBUTE] = geoAttribute;
        geoResolvedUrls.add(item.url);
      }
    }
    // Identity evidence: every retrieved surface for this item, plus the item's
    // own extracted wording as a last-resort surface.
    const identitySources: IdentitySource[] = [
      ...(identitySourcesByUrl.get(item.url) ?? []),
      { sourceType: "extracted_item", url: item.url, text: `${item.title}\n${item.summary ?? ""}` },
      ...Object.values(attributes)
        .filter((a) => a.raw && (a.confidence === "stated" || a.confidence === "structured"))
        .map((a) => ({ sourceType: "detail_field", url: a.source_url, text: `${a.key}: ${a.raw}` })),
    ];
    const verdict = evaluateCriteria(
      {
        title: item.title,
        attributes,
        numericValue: item.numeric_value,
        currency: item.currency,
        identitySources,
      },
      constraints,
    );

    verdicts.set(item.fingerprint, verdict);
    if (verdict.status === "match") criteriaMatched += 1;
    else if (verdict.status === "reject") criteriaRejected += 1;
    else criteriaUnverified += 1;
    console.info(
      `[radar:criteria] ${verdict.status.toUpperCase()} ${item.url} — ${verdict.reason}`,
    );
  }
  if (markets.length > 0) {
    console.info(
      `[radar:geo] market established for ${items.filter((i) => geoResolvedUrls.has(i.url)).length}/${items.length} item(s) from explicit evidence`,
    );
  }

  // ------------------------------------------------------------------
  // 2c. Visual evidence for what the text never stated.
  // Only for items that are still unverified, only for the attributes that
  // actually block them, only when the listing published its own photo, and
  // only within a small budget. A photo is evidence, never proof: it can fill
  // a gap or contradict the text, but it never changes the machine verdict.
  // ------------------------------------------------------------------
  const visualByUrl = new Map<string, { attribute: string; observation: string; value: string | null; confidence: "high" | "low" | "none"; image_url: string }[]>();
  const visualTargets = items
    .filter((item) => {
      const verdict = verdicts.get(item.fingerprint);
      if (!verdict || verdict.status !== "unverified") return false;
      if (!imageByUrl.get(item.url)?.url) return false;
      return verdict.outcomes.some((o) => o.status === "unverified" && specs.some((s) => s.key === o.constraint.attribute));
    })
    .slice(0, 6);

  if (visualTargets.length > 0) {
    await phase("analyzing_images");
    try {
      const { readImageEvidence } = await import("./reverify.server");
      for (const item of visualTargets) {
        const image = imageByUrl.get(item.url)!.url;
        const wanted = (verdicts.get(item.fingerprint)?.outcomes ?? [])
          .filter((o) => o.status === "unverified")
          .map((o) => specs.find((s) => s.key === o.constraint.attribute))
          .filter((s): s is AttributeSpec => !!s);
        if (wanted.length === 0) continue;
        const observations = await step(`visual:${item.url}`, () => readImageEvidence(image, wanted));
        const useful = observations.filter((o) => o.confidence !== "none");
        if (useful.length === 0) continue;
        visualByUrl.set(item.url, observations);
        visualObservations += useful.length;
        const current = attributeEvidenceByUrl.get(item.url);
        if (current) attributeEvidenceByUrl.set(item.url, applyVisualEvidence(current, specs, observations));
      }
    } catch (err) {
      console.warn(`[radar:evidence] visual pass skipped — ${(err as Error).message}`);
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
  // Market value may only be built from products that are actually comparable:
  // a different generation or a different model code is a different market.
  const targetIdentity = parseIdentity(config.target || radar.raw_request || "");
  const identityComparable = (o: Observation): boolean =>
    targetIdentity.words.length === 0 && targetIdentity.codes.length === 0
      ? true
      : comparableIdentity(targetIdentity, parseIdentity(o.title));
  const rejectedComparables = [...currentObservations, ...persistedObservations].filter(
    (o) => !identityComparable(o),
  );
  if (rejectedComparables.length > 0) {
    console.info(
      `[radar:comparables] ${rejectedComparables.length} observation(s) excluded — not the same product identity as "${targetIdentity.raw}"`,
    );
  }
  const population = [...currentObservations, ...persistedObservations].filter(identityComparable);


  await phase("building_comparables");
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

  // 4a0. Deterministic criteria gate — an item that provably falls outside the
  // user's stated constraints, or whose facts could not be verified, is never
  // alerted on. This gate only ever tightens: it cannot let anything through.
  if (constraints.length > 0) {
    const passed: typeof changed = [];
    for (const c of changed) {
      const verdict = verdicts.get(c.item.fingerprint);
      if (verdict && verdict.status !== "match") {
        record(
          c.item,
          false,
          verdict.status === "reject" ? "suppressed_criteria" : "suppressed_unverified",
          verdict.reason,
        );
        continue;
      }
      passed.push(c);
    }
    changed.length = 0;
    changed.push(...passed);
  }

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

  await phase("persisting_results");
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
          snapshot: {
            summary: item.summary,
            event_type: item.event_type,
            image: imageByUrl.get(item.url)?.url ?? (prev?.snapshot as { image?: string } | null)?.image ?? null,
            image_source:
              imageByUrl.get(item.url)?.source ??
              (prev?.snapshot as { image_source?: string } | null)?.image_source ??
              null,
            images:
              imageByUrl.get(item.url)?.images ??
              (prev?.snapshot as { images?: string[] } | null)?.images ??
              [],
            match_status: verdicts.get(item.fingerprint)?.status ?? "unverified",
            match_reason: verdicts.get(item.fingerprint)?.reason ?? "no machine-checkable constraints defined",
            criteria: verdicts.get(item.fingerprint)?.outcomes ?? [],
            // Why this listing is not a confirmed match, attribute by attribute.
            unverified_reason:
              (verdicts.get(item.fingerprint)?.outcomes ?? [])
                .filter((o) => o.status === "unverified")
                .map((o) => o.constraint.label ?? o.constraint.attribute)
                .join(", ") || null,
            missing_attributes: attrs
              ? Object.values(attrs)
                  .filter((a) => a.confidence === "unknown")
                  .map((a) => a.key)
              : [],
            // Link honesty: the UI must not present a generic page as "the advert".
            link_status:
              linkByUrl.get(item.url)?.status ??
              (prev?.snapshot as { link_status?: string } | null)?.link_status ??
              (looksLikeItemUrl(item.url) ? "direct" : "unverified"),
            canonical_url:
              linkByUrl.get(item.url)?.canonical ??
              (prev?.snapshot as { canonical_url?: string } | null)?.canonical_url ??
              null,
            requested_url: item.url,
            // What Radar actually knows about this item, and why: one record
            // per attribute with status, confidence, sources and conflicts.
            evidence: (attributeEvidenceByUrl.has(item.url)
              ? storableEvidence(attributeEvidenceByUrl.get(item.url)!)
              : ((prev?.snapshot as { evidence?: StoredEvidence[] } | null)?.evidence ?? [])) as never,
            // Photo observations for the requirements the text never stated.
            image_evidence: (visualByUrl.get(item.url) ??
              (prev?.snapshot as { image_evidence?: unknown } | null)?.image_evidence ??
              []) as never,
            image_status:
              imageEvidenceByUrl.get(item.url)?.status ??
              (imageByUrl.get(item.url) ? "from_listing" : null) ??
              (prev?.snapshot as { image_status?: string } | null)?.image_status ??
              null,
            // Unique identity of the physical item, when the page publishes one.
            identifiers: (identifiersByUrl.get(item.url) ??
              (prev?.snapshot as { identifiers?: Identifier[] } | null)?.identifiers ??
              []) as never,
            // Canonical product identity: what the accumulated evidence says the
            // item IS, independent of whether every other criterion is proven.
            identity: ((verdicts.get(item.fingerprint)?.outcomes ?? [])
              .map((o) => o.identity)
              .filter(Boolean)[0] ??
              (prev?.snapshot as { identity?: unknown } | null)?.identity ??
              null) as never,



          } as never,
          attributes: (attrs ?? {}) as never,
          primary_url:
            linkByUrl.get(item.url)?.url ?? (detail ? item.url : (prev?.primary_url ?? null)),
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

  // Remove provisional placeholders: confirmed items now exist under their real
  // identity, anything left was not a real item.
  await db
    .from("findings")
    .delete()
    .eq("radar_id", radar.id)
    .like("fingerprint", "provisional:%");

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
    scan_phase: scanPhase,
    // Terminology: "matching" means verified against the user's hard criteria.
    matching_listings: criteriaMatched,
    discovered_listings: items.length,
    persisted_findings: items.length,
    duplicates_removed: research.duplicatesRemoved + listingDuplicatesRemoved,
    blocked_pages: detailFetchesFailed,
    monitoring_transition: isBaseline && !failed,
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
    listings_removed: listingsRemoved,

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
    detail_cost_estimate: Number((detailCostEstimate + indexExpansionCost).toFixed(4)),
    index_pages_fetched: indexTelemetry.index_pages_fetched,
    index_pages_expanded: indexTelemetry.index_pages_expanded,
    index_prices_joined: indexPricesApplied,
    ambiguous_price_joins: indexTelemetry.ambiguous_price_joins,
    index_cards_used: indexCardsUsed,
    extraction_attempted: extractionAttempted,
    extraction_ai_calls: extractionAiCalls,
    extraction_sources_used: Array.from(extractionSourcesUsed),
    attributes_verified: attributesVerified,
    images_found: imagesFound,
    images_persisted: imageByUrl.size,
    direct_links_verified: directLinksVerified,
    direct_links_unverified: Math.max(0, linkByUrl.size - directLinksVerified),
    jsonld_found: jsonldFound,
    og_data_found: ogDataFound,
    evidence_merge_count: evidenceMergeCount,
    evidence_conflicts: evidenceConflicts,
    structured_prices_joined: structuredPricesApplied,
    visual_observations: visualObservations,
    identifiers_found: identifiersFound,

    criteria_matched: criteriaMatched,
    criteria_rejected: criteriaRejected,
    criteria_unverified: criteriaUnverified,
    pagination_pages_attempted: indexTelemetry.pages_attempted,
    pagination_pages_succeeded: indexTelemetry.pages_succeeded,
    pagination_pages_blocked: indexTelemetry.pages_blocked,
    pagination_pages_skipped: indexTelemetry.pages_skipped,
    indexes_exhausted: indexTelemetry.indexes_exhausted,
    unknown_prices: unknownPrices,
    error: research.errors.length ? research.errors.join(" | ").slice(0, 800) : null,
    finished_at: now,
  });

  type RadarUpdate = Database["public"]["Tables"]["radars"]["Update"];
  const radarPatch: RadarUpdate = {
    last_run_at: now,
    next_run_at: computeNextRunAt(radar.frequency, now, radar.status),
  };
  if (!failed) {
    radarPatch.last_successful_sweep_at = now;
    // Baseline only counts as complete after a successful sweep.
    if (isBaseline) {
      radarPatch.baseline_completed = true;
      radarPatch.baseline_completed_at = now;
      // Phase 1 -> Phase 2: the inventory exists, so monitoring starts now.
      radarPatch.scan_state = "MONITORING";
      radarPatch.initial_scan_completed_at = now;
      radarPatch.initial_listings_count = items.length;
    }
  } else if (isBaseline) {
    // A failed initial scan must be retried, never treated as an inventory.
    radarPatch.scan_state = "initial_scan_pending";
  }
  await db.from("radars").update(radarPatch).eq("id", radar.id);

  return {
    status: failed ? "error" : "ok",
    runType,
    message: isBaseline
      ? `Initial market scan complete — ${items.length} matching listings found right now. Radar is now monitoring the market for new listings and changes.`
      : undefined,

    itemsFound: items.length,
    newItems: changed.length,
    alertsCreated,
    provider: research.provider,
    sourcesRetrieved: allDocs.length,
    searchRequests: research.requests,
    searchFailures: research.failures,
    costEstimate: Number((research.costEstimate + detailCostEstimate + indexExpansionCost).toFixed(4)),
    duplicatesRemoved: research.duplicatesRemoved + listingDuplicatesRemoved,

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
    detailCostEstimate: Number((detailCostEstimate + indexExpansionCost).toFixed(4)),
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
    criteriaMatched,
    criteriaRejected,
    criteriaUnverified,
    paginationPagesAttempted: indexTelemetry.pages_attempted,
    paginationPagesSucceeded: indexTelemetry.pages_succeeded,
    paginationPagesBlocked: indexTelemetry.pages_blocked,
    indexesExhausted: indexTelemetry.indexes_exhausted,
  };
}
}
