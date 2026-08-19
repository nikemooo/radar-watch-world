/**
 * Server-driven scheduler.
 *
 * Scheduling must never depend on somebody having the app open. A cron tick
 * calls this module, which:
 *
 *   1. reads a bounded batch of radars whose next run is due,
 *   2. atomically claims each one by moving `next_run_at` forward
 *      (compare-and-swap, so two overlapping ticks can never start the same
 *      radar twice),
 *   3. starts the sweep, which itself is checkpointed and resumable.
 *
 * Nothing here knows anything about a specific radar or category.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { computeNextRunAt, isDue, type SchedulableRadar } from "./schedule";

type Db = SupabaseClient<Database>;
type RadarRow = Database["public"]["Tables"]["radars"]["Row"];

export type StartedRadar = { radarId: string; runId: string | null; nextRunAt: string | null };

/** Max radars a single tick may start — bounds the work per invocation. */
const DEFAULT_BATCH = 5;

export async function startDueRadars(
  db: Db,
  options: { limit?: number; now?: number } = {},
): Promise<StartedRadar[]> {
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const limit = options.limit ?? DEFAULT_BATCH;

  const { data, error } = await db
    .from("radars")
    .select("*")
    .eq("status", "active")
    .is("active_run_id", null)
    .not("next_run_at", "is", null)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.warn(`[radar:scheduler] could not read due radars: ${error.message}`);
    return [];
  }

  const started: StartedRadar[] = [];
  for (const radar of (data ?? []) as RadarRow[]) {
    if (!isDue(radar as unknown as SchedulableRadar, now)) continue;

    // Claim: push next_run_at forward BEFORE starting. Conditional on the
    // value we read, so a concurrent tick loses the race and does nothing.
    const nextRunAt = computeNextRunAt(radar.frequency, new Date(now), radar.status);
    const { data: claimed } = await db
      .from("radars")
      .update({ next_run_at: nextRunAt, scheduled_start_at: null })
      .eq("id", radar.id)
      .eq("next_run_at", radar.next_run_at!)
      .is("active_run_id", null)
      .select("id");
    if (!claimed?.length) continue;

    try {
      const { startRadarSweep } = await import("./sweep.server");
      // The tick must not wait for the sweep: the run is claimed and
      // checkpointed, so later ticks can carry it forward.
      const start = await startRadarSweep(db, radar, { inlineWaitMs: 1_000 });
      started.push({ radarId: radar.id, runId: start.runId, nextRunAt });
      console.info(`[radar:scheduler] started radar ${radar.id} (run ${start.runId ?? "?"})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[radar:scheduler] radar ${radar.id} could not be started — ${message}`);
    }
  }
  return started;
}
