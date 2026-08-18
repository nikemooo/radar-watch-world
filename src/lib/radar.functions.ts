import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Turn a natural-language request into a structured monitoring configuration. */
export const interpretRadarRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { request: string }) => {
    if (!input?.request || input.request.trim().length < 8) {
      throw new Error("Describe what you want Radar to monitor (at least a sentence).");
    }
    return { request: input.request.trim().slice(0, 2000) };
  })
  .handler(async ({ data }) => {
    const { interpretRequest } = await import("./ai/interpret.server");
    return interpretRequest(data.request);
  });

/** Create a radar, enforcing the caller's plan limits server-side. */
export const createRadar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      name: string;
      category: string;
      frequency: string;
      raw_request: string;
      monitoring_window: string;
      recency_days: number;
      config: unknown;
      mode?: string;
      start?: string;
      scheduled_start_at?: string | null;
    }) => {
      if (!input?.name || !input?.config) throw new Error("Missing radar details.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { getEntitlements } = await import("./billing/entitlements.server");
    const { asRadarMode } = await import("./radar-types");
    const e = await getEntitlements(context.supabase, context.userId);
    if (!e.isInternal && e.radarCount >= e.plan.max_radars) {
      throw new Error(
        `Your ${e.plan.name} plan allows ${e.plan.max_radars} radars. Upgrade to add more.`,
      );
    }
    // Scheduling the first sweep is a Pro Plus capability — enforced here, so
    // the client cannot bypass it by posting a scheduled_start_at.
    const wantsSchedule = data.start === "scheduled" && !!data.scheduled_start_at;
    if (wantsSchedule && !e.isInternal && e.planKey !== "pro_plus") {
      throw new Error("Scheduling the first sweep requires Pro Plus.");
    }
    const scheduledAt = wantsSchedule ? new Date(data.scheduled_start_at!).toISOString() : null;
    const { data: radar, error } = await context.supabase
      .from("radars")
      .insert({
        user_id: context.userId,
        name: data.name,
        category: data.category,
        frequency: data.frequency,
        raw_request: data.raw_request,
        monitoring_window: data.monitoring_window,
        recency_days: data.recency_days,
        recency_source: "ai_inferred",
        max_detail_fetches: e.plan.max_detail_fetches,
        mode: asRadarMode(data.mode),
        scheduled_start_at: scheduledAt,
        next_run_at: scheduledAt,
        config: data.config as never,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: radar.id, scheduledStartAt: scheduledAt };
  });

/**
 * Edit an existing radar's criteria. History, findings and identities are kept
 * — only the interpretation the gate runs against changes, and the change is
 * timestamped so the UI can say which observations predate it.
 */
export const updateRadarCriteria = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      radarId: string;
      name?: string;
      frequency?: string;
      mode?: string;
      recency_days?: number;
      config: unknown;
    }) => {
      if (!input?.radarId || !input?.config) throw new Error("Missing radar details.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { asRadarMode } = await import("./radar-types");
    const patch: Record<string, unknown> = {
      config: data.config,
      criteria_updated_at: new Date().toISOString(),
    };
    if (data.name) patch["name"] = data.name;
    if (data.frequency) patch["frequency"] = data.frequency;
    if (data.mode) patch["mode"] = asRadarMode(data.mode);
    if (typeof data.recency_days === "number") {
      patch["recency_days"] = data.recency_days;
      patch["recency_source"] = "user_set";
    }
    const { error } = await context.supabase
      .from("radars")
      .update(patch as never)
      .eq("id", data.radarId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true, criteriaUpdatedAt: patch["criteria_updated_at"] as string };
  });



/** Run one monitoring cycle for a radar the caller owns. */
export const runRadarNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { radarId: string }) => {
    if (!input?.radarId) throw new Error("Missing radar id.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { startRadarSweep } = await import("./monitoring/sweep.server");
    const { getEntitlements, remainingAlerts, minSweepIntervalMinutes } = await import(
      "./billing/entitlements.server"
    );
    const { data: radar, error } = await context.supabase
      .from("radars")
      .select("*")
      .eq("id", data.radarId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!radar) throw new Error("Radar not found.");

    const e = await getEntitlements(context.supabase, context.userId);
    const minInterval = minSweepIntervalMinutes(e);
    if (radar.last_run_at && minInterval > 0) {
      const elapsed = (Date.now() - new Date(radar.last_run_at).getTime()) / 60000;
      if (elapsed < minInterval) {
        const wait = Math.ceil(minInterval - elapsed);
        throw new Error(
          `Your ${e.plan.name} plan allows a sweep every ${minInterval} minutes. Next sweep available in ${wait} minutes.`,
        );
      }
    }

    // Idempotency: never start a second sweep while one is genuinely running.
    const { data: open } = await context.supabase
      .from("monitor_runs")
      .select("id, started_at")
      .eq("radar_id", radar.id)
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(1);
    const openRun = open?.[0];
    if (openRun && Date.now() - new Date(openRun.started_at).getTime() < 15 * 60_000) {
      return { state: "running" as const, startedAt: openRun.started_at, runId: openRun.id };
    }

    return startRadarSweep(context.supabase, radar, {

      alertBudget: remainingAlerts(e),
      maxDetailFetches: e.isInternal ? undefined : e.plan.max_detail_fetches,
      priority: e.isInternal || e.plan.priority_processing,
    });
  });

/** Persisted outcome of the latest sweep — the single source of truth for the UI. */
export const getSweepStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { radarId: string; since?: string }) => {
    if (!input?.radarId) throw new Error("Missing radar id.");
    return { radarId: input.radarId, since: input.since };
  })
  .handler(async ({ data, context }) => {
    const { readSweepStatus } = await import("./monitoring/sweep.server");
    return readSweepStatus(context.supabase, data.radarId, data.since);
  });




/** Which research providers are wired up (nothing is faked when none are). */
export const getResearchStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { providerStatus } = await import("./search/providers.server");
    return { providers: providerStatus() };
  });

/** Build a daily or weekly intelligence report from real stored alerts. */
export const buildIntelligenceReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { kind: "daily" | "weekly" }) => ({
    kind: input?.kind === "weekly" ? ("weekly" as const) : ("daily" as const),
  }))
  .handler(async ({ data, context }) => {
    const { generateReport } = await import("./intelligence/report.server");
    return generateReport(context.supabase, context.userId, data.kind);
  });

/** Admin-only search-provider observability: request volume, failures, cost, key status. */
export const getSearchOpsMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden");

    const { providerStatus } = await import("./search/providers.server");
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data: runs } = await context.supabase
      .from("monitor_runs")
      .select(
        "id, status, run_type, provider, error, cost_estimate, search_requests, search_successes, search_failures, sources_retrieved, baseline_findings, incremental_findings, suppressed_baseline, suppressed_recency, suppressed_duplicate, suppressed_relevance, alerts_created, started_at, finished_at, candidates_discovered, detail_fetches_attempted, detail_fetches_ok, detail_fetches_failed, detail_fetches_skipped_backoff, detail_cost_estimate, usable_comparables, comparable_coverage, baselines_computed, baselines_insufficient, baselines_backfilled",
      )
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(500);

    const { data: hosts } = await context.supabase
      .from("source_fetch_stats")
      .select("host, attempts, successes, last_failure_reason");

    const rows = runs ?? [];
    const exaRuns = rows.filter((r) => r.provider === "exa");
    const lastSuccess = rows.find(
      (r) => (r.status === "ok" || r.status === "completed") && (r.search_successes ?? 0) > 0,
    );
    const lastFailure = rows.find(
      (r) => r.status === "error" || r.status === "failed" || (r.search_failures ?? 0) > 0,
    );
    const sum = (key: keyof (typeof rows)[number]) =>
      rows.reduce((n, r) => n + Number(r[key] ?? 0), 0);

    return {
      providers: providerStatus(),
      requests: rows.reduce((n, r) => n + (r.search_requests ?? 0), 0),
      successes: rows.reduce((n, r) => n + (r.search_successes ?? 0), 0),
      failures: rows.reduce((n, r) => n + (r.search_failures ?? 0), 0),
      sources: rows.reduce((n, r) => n + (r.sources_retrieved ?? 0), 0),
      costEstimate: rows.reduce((n, r) => n + Number(r.cost_estimate ?? 0), 0),
      exaSweeps: exaRuns.length,
      lastSuccessAt: lastSuccess?.finished_at ?? lastSuccess?.started_at ?? null,
      lastFailureAt: lastFailure?.finished_at ?? lastFailure?.started_at ?? null,
      lastFailureError: lastFailure?.error ?? null,
      baselineRuns: rows.filter((r) => r.run_type === "baseline").length,
      baselineFindings: sum("baseline_findings"),
      incrementalFindings: sum("incremental_findings"),
      suppressedBaseline: sum("suppressed_baseline"),
      suppressedRecency: sum("suppressed_recency"),
      suppressedDuplicate: sum("suppressed_duplicate"),
      suppressedRelevance: sum("suppressed_relevance"),
      alertsCreated: sum("alerts_created"),
      candidates: sum("candidates_discovered"),
      detailAttempted: sum("detail_fetches_attempted"),
      detailOk: sum("detail_fetches_ok"),
      detailFailed: sum("detail_fetches_failed"),
      detailSkippedBackoff: sum("detail_fetches_skipped_backoff"),
      detailCost: rows.reduce((n, r) => n + Number(r.detail_cost_estimate ?? 0), 0),
      usableComparables: rows[0]?.usable_comparables ?? 0,
      comparableCoverage: Number(rows[0]?.comparable_coverage ?? 0),
      baselinesComputed: sum("baselines_computed"),
      baselinesInsufficient: sum("baselines_insufficient"),
      baselinesBackfilled: sum("baselines_backfilled"),
      hosts: (hosts ?? [])
        .map((h) => ({
          host: h.host,
          attempts: h.attempts,
          successes: h.successes,
          rate: h.attempts > 0 ? Math.round((h.successes / h.attempts) * 100) : null,
          lastFailureReason: h.last_failure_reason,
        }))
        .sort((a, b) => b.attempts - a.attempts)
        .slice(0, 12),
    };
  });

/** Sources retrieved for one of the caller's radars, newest first. */
export const listRadarSources = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { radarId: string; limit?: number }) => {
    if (!input?.radarId) throw new Error("Missing radar id.");
    return { radarId: input.radarId, limit: Math.min(Math.max(input.limit ?? 25, 1), 100) };
  })
  .handler(async ({ data, context }) => {
    const { data: sources, error } = await context.supabase
      .from("research_sources")
      .select("id, url, title, publisher, published_at, retrieved_at, snippet, query, provider")
      .eq("radar_id", data.radarId)
      .order("retrieved_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return sources ?? [];
  });
