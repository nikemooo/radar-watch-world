/**
 * Run heartbeat + phase tracking.
 *
 * The worker proves it is alive by writing heartbeat_at on a timer — including
 * during long remote calls (search, detail fetching), because the timer is
 * independent of the work. Phase transitions are persisted immediately, so a
 * user who refreshes always sees where the sweep actually is.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { HEARTBEAT_INTERVAL_MS, type RunPhase } from "./lifecycle";

type Db = SupabaseClient<Database>;
type RunUpdate = Database["public"]["Tables"]["monitor_runs"]["Update"];

export type RunTracker = {
  runId: string | null;
  /** Persist a phase transition (plus optional counters) immediately. */
  phase: (phase: RunPhase, patch?: RunUpdate) => Promise<void>;
  /** Write a heartbeat now. */
  beat: () => Promise<void>;
  stop: () => void;
};

export function startRunHeartbeat(db: Db, runId: string | null): RunTracker {
  let stopped = false;

  const write = async (patch: RunUpdate) => {
    if (!runId || stopped) return;
    try {
      const { error } = await db.from("monitor_runs").update(patch).eq("id", runId);
      if (error) throw new Error(error.message);
    } catch (err) {
      // A missed heartbeat must never kill the sweep; the reaper's stale
      // threshold is several beats wide precisely for this case.
      console.warn(`[radar:heartbeat] write failed for run ${runId}: ${String(err)}`);
    }
  };

  const timer = runId
    ? setInterval(() => {
        void write({ heartbeat_at: new Date().toISOString() });
      }, HEARTBEAT_INTERVAL_MS)
    : null;
  // Never hold the process open just for a heartbeat.
  (timer as { unref?: () => void } | null)?.unref?.();

  return {
    runId,
    phase: async (phase, patch) => {
      console.info(`[radar:phase] run ${runId ?? "?"} → ${phase}`);
      await write({ ...patch, current_phase: phase, heartbeat_at: new Date().toISOString() });
    },
    beat: async () => write({ heartbeat_at: new Date().toISOString() }),
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

/** A tracker that writes nothing — used when a caller has no run row. */
export function noopTracker(): RunTracker {
  return {
    runId: null,
    phase: async () => undefined,
    beat: async () => undefined,
    stop: () => undefined,
  };
}
