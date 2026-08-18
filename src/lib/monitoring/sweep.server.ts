/**
 * Sweep execution wrapper.
 *
 * A full monitoring cycle regularly runs for 1-3 minutes (search -> candidate
 * discovery -> detail fetching -> baselines -> evaluation -> persistence).
 * That is longer than an HTTP request may stay open, so the request must not
 * be the thing that owns the work: the cycle is started, kept alive through
 * the platform's waitUntil hook when available, and its outcome is read back
 * from the persisted monitor_run row.
 *
 * No monitoring logic lives here — this file only starts the real cycle and
 * reports its persisted truth.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { beginRun, runRadarCycle, type RunOptions, type RunResult } from "./engine.server";
import { keepRuntimeAlive } from "../runtime-context.server";

type Db = SupabaseClient<Database>;
type RadarRow = Database["public"]["Tables"]["radars"]["Row"];

/** How long the request waits for a fast sweep before handing off to polling. */
const INLINE_WAIT_MS = 12_000;
/** A run still "running" after this long is treated as dead (worker cut off). */
const STALE_RUN_MS = 15 * 60_000;

export type SweepStart =
  | { state: "completed"; result: RunResult; runId: string | null; startedAt: string }
  | { state: "running"; startedAt: string; runId: string | null };

export type SweepStatus = {
  state: "running" | "completed" | "failed" | "none";
  runId: string | null;
  runType: string | null;
  status: string | null;
  error: string | null;
  itemsFound: number;
  newItems: number;
  alertsCreated: number;
  sourcesRetrieved: number;
  startedAt: string | null;
  finishedAt: string | null;
};

export async function startRadarSweep(
  db: Db,
  radar: RadarRow,
  options: RunOptions = {},
): Promise<SweepStart> {
  // The run row (and, for a first sweep, the radar's running scan state) is
  // written synchronously BEFORE the cycle starts. Only then can the caller
  // honestly report "the sweep has started" — and a refresh one second later
  // already shows a running sweep instead of the untouched initial state.
  const claim = await beginRun(db, radar);
  const startedAt = claim.startedAt;

  const sweep = (async () => {
    try {
      return await runRadarCycle(db, radar, {
        ...options,
        runId: claim.runId,
        startedAt: claim.startedAt,
      });
    } catch (err) {
      // Without this, a crashed cycle leaves monitor_runs stuck on "running"
      // forever and the UI can never tell success from failure.
      const message = err instanceof Error ? err.message : String(err);
      if (claim.runId) {
        await db
          .from("monitor_runs")
          .update({
            status: "failed",
            error: message.slice(0, 800),
            finished_at: new Date().toISOString(),
          })
          .eq("id", claim.runId);
      }
      if (!radar.baseline_completed) {
        // A crashed initial scan must be retried, never presented as inventory.
        await db
          .from("radars")
          .update({ scan_state: "initial_scan_pending" })
          .eq("id", radar.id);
      }
      console.error(`[radar:sweep] radar ${radar.id} failed — ${message}`);

      throw err;
    }
  })();

  const backgroundAttached = keepRuntimeAlive(sweep);
  console.info(
    `[radar:sweep] radar ${radar.id} run ${claim.runId ?? "?"} background ${backgroundAttached ? "attached" : "unavailable"}`,
  );
  sweep.catch(() => undefined); // handled above; prevents unhandled rejection

  const raced = await Promise.race([
    sweep.then((result) => ({ done: true as const, result })).catch(() => ({ done: false as const })),
    new Promise<{ done: false }>((resolve) =>
      setTimeout(() => resolve({ done: false as const }), INLINE_WAIT_MS),
    ),
  ]);

  if (raced.done)
    return { state: "completed", result: raced.result, runId: claim.runId, startedAt };
  return { state: "running", startedAt, runId: claim.runId };
}


/** Reads the persisted truth of the most recent run for a radar. */
export async function readSweepStatus(
  db: Db,
  radarId: string,
  since?: string | undefined,
): Promise<SweepStatus> {
  let query = db
    .from("monitor_runs")
    .select(
      "id, status, run_type, error, items_found, new_items, alerts_created, sources_retrieved, started_at, finished_at",
    )
    .eq("radar_id", radarId)
    .order("started_at", { ascending: false })
    .limit(1);
  if (since) query = query.gte("started_at", since);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const run = data?.[0];
  if (!run) {
    return {
      state: "none",
      runId: null,
      runType: null,
      status: null,
      error: null,
      itemsFound: 0,
      newItems: 0,
      alertsCreated: 0,
      sourcesRetrieved: 0,
      startedAt: null,
      finishedAt: null,
    };
  }

  let status = run.status;
  if (status === "running" && Date.now() - new Date(run.started_at).getTime() > STALE_RUN_MS) {
    status = "failed";
    await db
      .from("monitor_runs")
      .update({
        status: "failed",
        error: "Sweep did not finish — the run was interrupted.",
        finished_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    // Reaping the run is not enough: a radar whose initial scan was cut off
    // stays pinned on INITIAL_SCAN_RUNNING forever and the UI can never show
    // anything but "scan running". Release it back to a retryable state.
    // Nothing else about the radar (config, findings, baseline) is touched.
    await db
      .from("radars")
      .update({ scan_state: "initial_scan_pending" })
      .eq("id", radarId)
      .eq("scan_state", "INITIAL_SCAN_RUNNING")
      .eq("baseline_completed", false);
  }

  const state: SweepStatus["state"] =
    status === "running"
      ? "running"
      : status === "completed" || status === "ok"
        ? "completed"
        : "failed";

  return {
    state,
    runId: run.id,
    runType: run.run_type,
    status,
    error: run.error,
    itemsFound: run.items_found,
    newItems: run.new_items,
    alertsCreated: run.alerts_created,
    sourcesRetrieved: run.sources_retrieved,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
  };
}
