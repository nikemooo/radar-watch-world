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
 * The platform cannot guarantee that a background worker survives a process
 * restart. Instead of pretending otherwise, every run heartbeats while it
 * lives (see heartbeat.server.ts) and a lost worker is detected and reaped
 * (see reaper.server.ts) — so a sweep either runs, completes, or is reported
 * as interrupted. It can never stay "running" forever.
 *
 * No monitoring logic lives here — this file only starts the real cycle and
 * reports its persisted truth.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { beginRun, runRadarCycle, type RunOptions, type RunResult } from "./engine.server";
import { keepRuntimeAlive } from "../runtime-context.server";
import { startRunHeartbeat } from "./heartbeat.server";
import { reapStaleRuns, releaseRadar } from "./reaper.server";
import { resumeInterruptedRuns } from "./continuation.server";
import { phaseLabel } from "./lifecycle";

type Db = SupabaseClient<Database>;
type RadarRow = Database["public"]["Tables"]["radars"]["Row"];

/** How long the request waits for a fast sweep before handing off to polling. */
const INLINE_WAIT_MS = 12_000;

export type SweepStart =
  | { state: "completed"; result: RunResult; runId: string | null; startedAt: string }
  | { state: "running"; startedAt: string; runId: string | null };

export type SweepStatus = {
  state: "running" | "completed" | "failed" | "none";
  runId: string | null;
  runType: string | null;
  status: string | null;
  error: string | null;
  failureReason: string | null;
  phase: string | null;
  phaseLabel: string | null;
  heartbeatAt: string | null;
  itemsFound: number;
  newItems: number;
  alertsCreated: number;
  sourcesRetrieved: number;
  candidates: number;
  detailFetches: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** Which worker invocation is currently carrying the run (1 = the first). */
  attempt: number;
  /** How many times the run had to be picked up again after an interruption. */
  continuations: number;
  lastOperation: string | null;
  phaseStartedAt: string | null;
  /** True when the run is claimed but waiting to be picked up again. */
  resuming: boolean;
};

export async function startRadarSweep(
  db: Db,
  radar: RadarRow,
  options: RunOptions & { inlineWaitMs?: number } = {},
): Promise<SweepStart> {
  // The run row (and, for a first sweep, the radar's running scan state) is
  // written synchronously BEFORE the cycle starts. Only then can the caller
  // honestly report "the sweep has started" — and a refresh one second later
  // already shows a running sweep instead of the untouched initial state.
  const claim = await beginRun(db, radar);
  const startedAt = claim.startedAt;
  const tracker = startRunHeartbeat(db, claim.runId);

  const sweep = (async () => {
    try {
      return await runRadarCycle(db, radar, {
        ...options,
        runId: claim.runId,
        startedAt: claim.startedAt,
        tracker,
      });
    } catch (err) {
      // Without this, a crashed cycle leaves monitor_runs stuck on "running"
      // forever and the UI can never tell success from failure.
      const message = err instanceof Error ? err.message : String(err);
      const checkpointFailure = err instanceof Error && err.name === "CheckpointWriteError";
      if (checkpointFailure) {
        // A run whose progress cannot be persisted is NOT resumable. Saying so
        // out loud is the whole point: a silent warning is what made sweeps
        // restart from query planning forever.
        console.error(
          JSON.stringify({ event: "run_not_resumable", run_id: claim.runId, radar_id: radar.id, error: message }),
        );
      }
      if (claim.runId) {
        await db
          .from("monitor_runs")
          .update({
            status: "failed",
            error: message.slice(0, 800),
            failure_reason: "start_failed",
            termination_reason: checkpointFailure ? "checkpoint_write_failed" : "worker_error",
            failed_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            worker_finished_at: new Date().toISOString(),
          })
          .eq("id", claim.runId);
      }
      // Restore the radar's state and release the concurrency lock so the user
      // can immediately try again.
      await releaseRadar(db, radar.id, claim.runId);
      console.error(`[radar:sweep] radar ${radar.id} failed — ${message}`);


      throw err;
    } finally {
      tracker.stop();
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
      setTimeout(() => resolve({ done: false as const }), options.inlineWaitMs ?? INLINE_WAIT_MS),
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
  // Recovery is never left to chance: every status read first closes runs whose
  // worker has gone quiet, so the UI cannot show an endless "searching".
  // Recovery is never left to chance. A quiet run is first offered a
  // continuation (it resumes from its checkpoints, paying nothing twice); only
  // a run that can no longer be resumed is closed as failed. Either way the UI
  // can never show an endless "searching".
  const resumed = await resumeInterruptedRuns(db, { radarId });
  await reapStaleRuns(db, { radarId });

  let query = db
    .from("monitor_runs")
    .select(
      "id, status, run_type, error, failure_reason, current_phase, heartbeat_at, items_found, new_items, alerts_created, sources_retrieved, candidates_discovered, detail_fetches_ok, started_at, finished_at, attempt, continuation_count, last_successful_operation, phase_started_at",
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
      failureReason: null,
      phase: null,
      phaseLabel: null,
      heartbeatAt: null,
      itemsFound: 0,
      newItems: 0,
      alertsCreated: 0,
      sourcesRetrieved: 0,
      candidates: 0,
      detailFetches: 0,
      startedAt: null,
      finishedAt: null,
      attempt: 0,
      continuations: 0,
      lastOperation: null,
      phaseStartedAt: null,
      resuming: false,
    };
  }

  const status = run.status;
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
    failureReason: run.failure_reason,
    phase: run.current_phase,
    phaseLabel: phaseLabel(run.current_phase),
    heartbeatAt: run.heartbeat_at,
    itemsFound: run.items_found,
    newItems: run.new_items,
    alertsCreated: run.alerts_created,
    sourcesRetrieved: run.sources_retrieved,
    candidates: run.candidates_discovered,
    detailFetches: run.detail_fetches_ok,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    attempt: run.attempt ?? 1,
    continuations: run.continuation_count ?? 0,
    lastOperation: run.last_successful_operation,
    phaseStartedAt: run.phase_started_at,
    resuming: resumed.some((r) => r.runId === run.id),
  };
}
