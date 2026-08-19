/**
 * Recovery for lost workers.
 *
 * Background sweeps live in the server process. A restart (deploy, crash, HMR)
 * kills them silently, and without recovery the database keeps claiming
 * "running" forever while the UI shows an endless search. The reaper is the
 * generic answer: any run whose heartbeat has gone quiet is closed as failed
 * and its radar is released back to a retryable state.
 *
 * It never touches a run that is still heartbeating, never deletes history and
 * knows nothing about any specific radar or category.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { runVerdict, type FailureReason } from "./lifecycle";

type Db = SupabaseClient<Database>;

export type ReapedRun = {
  runId: string;
  radarId: string;
  reason: FailureReason;
  lastPhase: string | null;
  lastHeartbeatAt: string | null;
};

const REASON_MESSAGE: Record<FailureReason, string> = {
  worker_lost: "Bakgrundskörningen avslutades innan den blev klar.",
  heartbeat_timeout: "Bakgrundskörningen slutade svara och avbröts.",
  run_timeout: "Sökningen tog för lång tid och avbröts.",
  start_failed: "Sökningen kunde inte startas.",
};

/**
 * Close every stale running run (optionally limited to one radar) and restore
 * the owning radar's state.
 */
export async function reapStaleRuns(
  db: Db,
  options: { radarId?: string; userId?: string; now?: number } = {},
): Promise<ReapedRun[]> {
  const now = options.now ?? Date.now();
  let query = db
    .from("monitor_runs")
    .select("id, radar_id, status, started_at, heartbeat_at, current_phase, attempt")
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(200);
  if (options.radarId) query = query.eq("radar_id", options.radarId);
  if (options.userId) query = query.eq("user_id", options.userId);

  const { data, error } = await query;
  if (error) {
    console.warn(`[radar:reaper] could not read running runs: ${error.message}`);
    return [];
  }

  const reaped: ReapedRun[] = [];
  for (const run of data ?? []) {
    // A quiet run is not automatically a dead run: it may simply be waiting
    // for its next continuation. Only a run that can no longer be resumed
    // (attempts spent, or past the absolute ceiling) is reaped.
    const verdict = runVerdict(run, now);
    if (verdict.state !== "dead") continue;

    const finishedAt = new Date(now).toISOString();
    // Conditional on status so a worker that woke up in the meantime wins.
    const { data: closed } = await db
      .from("monitor_runs")
      .update({
        status: "failed",
        error: REASON_MESSAGE[verdict.reason],
        failure_reason: verdict.reason,
        termination_reason: verdict.reason,
        failed_at: finishedAt,
        finished_at: finishedAt,
        worker_finished_at: finishedAt,
      })
      .eq("id", run.id)
      .eq("status", "running")
      .select("id");
    if (!closed?.length) continue;

    await releaseRadar(db, run.radar_id, run.id);
    reaped.push({
      runId: run.id,
      radarId: run.radar_id,
      reason: verdict.reason,
      lastPhase: run.current_phase,
      lastHeartbeatAt: run.heartbeat_at,
    });
    console.warn(
      `[radar:reaper] run ${run.id} (radar ${run.radar_id}) reaped — ${verdict.reason} at phase ${run.current_phase}`,
    );
  }
  return reaped;
}

/**
 * Release a radar's run lock and put it back in the correct state:
 * a radar without a successful baseline becomes retryable, one with a baseline
 * returns to monitoring. No radar-specific logic.
 */
export async function releaseRadar(db: Db, radarId: string, runId?: string | null): Promise<void> {
  const { data: radar } = await db
    .from("radars")
    .select("id, baseline_completed, scan_state, active_run_id")
    .eq("id", radarId)
    .maybeSingle();
  if (!radar) return;

  const patch: Database["public"]["Tables"]["radars"]["Update"] = { active_run_id: null };
  if (!radar.baseline_completed) {
    patch.scan_state = "initial_scan_pending";
  } else if (radar.scan_state === "INITIAL_SCAN_RUNNING") {
    patch.scan_state = "MONITORING";
  }

  let update = db.from("radars").update(patch).eq("id", radarId);
  // Only clear the lock we own — a newer run must keep its claim.
  if (runId) update = update.or(`active_run_id.eq.${runId},active_run_id.is.null`);
  const { error } = await update;
  if (error) throw new Error(`Could not release radar ${radarId}: ${error.message}`);
}
