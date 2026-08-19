/**
 * Continuations — how a sweep survives the runtime.
 *
 * The worker that starts a sweep is not guaranteed to live until the sweep is
 * done: the platform may end the invocation as soon as the HTTP response is
 * sent, and deploys or restarts end it too. So a sweep is never "a process
 * that must stay alive"; it is a claimed run row plus persisted checkpoints
 * that ANY later invocation can pick up.
 *
 * This module is the pick-up mechanism. It finds runs that are still claimed
 * but whose invocation has gone quiet, atomically takes over the next attempt
 * (compare-and-swap on `attempt`, so two pollers can never continue the same
 * run twice), and re-enters the engine with the same run id. Every expensive
 * step that already completed is served from its checkpoint, so a continuation
 * costs nothing for work already paid for.
 *
 * Nothing here knows anything about a specific radar, market or category.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { runVerdict } from "./lifecycle";
import { keepRuntimeAlive } from "../runtime-context.server";
import { isSweepPaused, UI_SLICE_MS } from "./slice";


type Db = SupabaseClient<Database>;
type RadarRow = Database["public"]["Tables"]["radars"]["Row"];

export type ContinuationOutcome = {
  runId: string;
  radarId: string;
  attempt: number;
};

/** Rows the continuation planner needs — kept tiny so the check stays cheap. */
export type ClaimableRun = {
  id: string;
  radar_id: string;
  status: string | null;
  started_at: string;
  heartbeat_at: string | null;
  attempt: number | null;
  current_phase: string | null;
  phase_started_at?: string | null;
};

/**
 * Take over a quiet run for one more attempt.
 * Returns false when another invocation won the race, or when the run moved on.
 */
export async function claimContinuation(
  db: Db,
  run: ClaimableRun,
  now: number = Date.now(),
): Promise<boolean> {
  const verdict = runVerdict(run, now);
  if (verdict.state !== "resume") return false;

  const { data } = await db
    .from("monitor_runs")
    .update({
      attempt: verdict.attempt + 1,
      continuation_count: (run.attempt ?? 1), // one continuation per extra attempt
      heartbeat_at: new Date(now).toISOString(),
      worker_started_at: new Date(now).toISOString(),
    })
    .eq("id", run.id)
    .eq("status", "running")
    .eq("attempt", verdict.attempt)
    .select("id");

  return Boolean(data?.length);
}

/**
 * Find quiet-but-resumable runs and continue them.
 *
 * Called from status polling (the UI is the cheapest scheduler we have) and
 * from the public recovery endpoint, so a sweep keeps moving even if nobody
 * has the page open.
 */
export async function resumeInterruptedRuns(
  db: Db,
  options: {
    radarId?: string;
    userId?: string;
    now?: number;
    limit?: number;
    /**
     * Run the continuation inside THIS request (bounded by `sliceMs`) instead
     * of detaching it. Awaiting is what makes progress independent of whether
     * the runtime keeps background work alive.
     */
    await?: boolean;
    sliceMs?: number;
  } = {},
): Promise<ContinuationOutcome[]> {
  const now = options.now ?? Date.now();
  let query = db
    .from("monitor_runs")
    .select("id, radar_id, status, started_at, heartbeat_at, attempt, current_phase, phase_started_at")
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(options.limit ?? 20);
  if (options.radarId) query = query.eq("radar_id", options.radarId);
  if (options.userId) query = query.eq("user_id", options.userId);

  const { data, error } = await query;
  if (error) {
    console.warn(`[radar:continuation] could not read running runs: ${error.message}`);
    return [];
  }

  const resumed: ContinuationOutcome[] = [];
  const sliceMs = options.sliceMs ?? UI_SLICE_MS;
  const budgetEnd = Date.now() + sliceMs;
  for (const run of data ?? []) {
    const verdict = runVerdict(run, now);
    if (verdict.state !== "resume") continue;
    if (options.await && Date.now() >= budgetEnd) break;
    if (!(await claimContinuation(db, run, now))) continue;

    const { data: radar } = await db
      .from("radars")
      .select("*")
      .eq("id", run.radar_id)
      .maybeSingle();
    if (!radar) continue;

    console.info(
      `[radar:continuation] resuming run ${run.id} (radar ${run.radar_id}) from phase ${run.current_phase ?? "?"} — attempt ${verdict.attempt + 1}`,
    );
    const work = startContinuation(db, radar as RadarRow, run.id, run.started_at, budgetEnd);
    if (options.await) await work;
    resumed.push({ runId: run.id, radarId: run.radar_id, attempt: verdict.attempt + 1 });
  }
  return resumed;
}

/**
 * Run one more slice of an already-claimed run.
 *
 * The engine is imported lazily so that merely reading a status never pulls the
 * whole monitoring stack into the request. The returned promise settles when
 * the slice finishes, pauses on its deadline, or fails.
 */
function startContinuation(
  db: Db,
  radar: RadarRow,
  runId: string,
  startedAt: string,
  deadlineAt: number,
): Promise<void> {
  const work = (async () => {
    const [{ runRadarCycle }, { startRunHeartbeat }, { releaseRadar }] = await Promise.all([
      import("./engine.server"),
      import("./heartbeat.server"),
      import("./reaper.server"),
    ]);
    const tracker = startRunHeartbeat(db, runId);
    try {
      await runRadarCycle(db, radar, {
        runId,
        startedAt,
        tracker,
        continuation: true,
        deadlineAt,
      });
    } catch (err) {
      if (isSweepPaused(err)) {
        // Expected: the slice ended between two checkpointed steps. The run
        // stays running and the next tick/poll carries it forward.
        console.info(`[radar:continuation] run ${runId} paused — ${(err as Error).message}`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[radar:continuation] run ${runId} failed — ${message}`);
      await db
        .from("monitor_runs")
        .update({
          status: "failed",
          error: message.slice(0, 800),
          failure_reason: "worker_lost",
          termination_reason: "continuation_failed",
          failed_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          worker_finished_at: new Date().toISOString(),
        })
        .eq("id", runId)
        .eq("status", "running");
      await releaseRadar(db, radar.id, runId);
    } finally {
      tracker.stop();
    }
  })();

  keepRuntimeAlive(work);
  work.catch(() => undefined);
  return work;
}

