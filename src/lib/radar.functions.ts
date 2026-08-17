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

/** Run one monitoring cycle for a radar the caller owns. */
export const runRadarNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { radarId: string }) => {
    if (!input?.radarId) throw new Error("Missing radar id.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { runRadarCycle } = await import("./monitoring/engine.server");
    const { data: radar, error } = await context.supabase
      .from("radars")
      .select("*")
      .eq("id", data.radarId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!radar) throw new Error("Radar not found.");
    return runRadarCycle(context.supabase, radar);
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
        "id, status, run_type, provider, error, cost_estimate, search_requests, search_successes, search_failures, sources_retrieved, baseline_findings, incremental_findings, suppressed_baseline, suppressed_recency, suppressed_duplicate, suppressed_relevance, alerts_created, started_at, finished_at",
      )
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(500);

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
