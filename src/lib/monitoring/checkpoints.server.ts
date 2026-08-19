/**
 * Run checkpoints — the persistence layer that makes a sweep resumable.
 *
 * A sweep is a chain of expensive external calls (search, index expansion,
 * detail fetching, AI extraction). The serverless runtime does not promise
 * that the same isolate survives from the first call to the last, so the work
 * must never live only in memory: every expensive step writes its result to
 * `run_checkpoints`, keyed by the run and a stable step key.
 *
 * A continuation therefore re-enters the same run and every step that already
 * succeeded returns instantly from its checkpoint — no provider is billed
 * twice, and no completed work is redone. This is what "resume from the last
 * successful phase" means in practice, and it is entirely category-agnostic.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Db = SupabaseClient<Database>;

export type CheckpointStore = {
  runId: string | null;
  /** Number of steps served from persisted state during this invocation. */
  readonly resumedSteps: number;
  /** Run `fn` unless this step already completed for this run. */
  step<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Read a checkpoint without running anything. */
  read<T>(key: string): Promise<T | undefined>;
};

/** A store that never persists — used by tests and by callers without a run. */
export function memoryCheckpointStore(runId: string | null = null): CheckpointStore {
  const cache = new Map<string, unknown>();
  let resumed = 0;
  return {
    runId,
    get resumedSteps() {
      return resumed;
    },
    async step<T>(key: string, fn: () => Promise<T>): Promise<T> {
      if (cache.has(key)) {
        resumed += 1;
        return cache.get(key) as T;
      }
      const value = await fn();
      cache.set(key, value);
      return value;
    },
    async read<T>(key: string): Promise<T | undefined> {
      return cache.has(key) ? (cache.get(key) as T) : undefined;
    },
  };
}

export function createCheckpointStore(
  db: Db,
  runId: string | null,
  userId: string,
): CheckpointStore {
  if (!runId) return memoryCheckpointStore(null);
  const cache = new Map<string, unknown>();
  let loaded = false;
  let resumed = 0;

  const load = async () => {
    if (loaded) return;
    loaded = true;
    const { data, error } = await db
      .from("run_checkpoints")
      .select("key, value")
      .eq("run_id", runId);
    if (error) {
      console.warn(`[radar:checkpoint] could not read run ${runId}: ${error.message}`);
      return;
    }
    for (const row of data ?? []) cache.set(row.key, row.value);
  };

  return {
    runId,
    get resumedSteps() {
      return resumed;
    },
    async step<T>(key, fn) {
      await load();
      if (cache.has(key)) {
        resumed += 1;
        console.info(`[radar:checkpoint] run ${runId} resumed step "${key}"`);
        return cache.get(key) as T;
      }
      const value = await fn();
      cache.set(key, value);
      const { error } = await db
        .from("run_checkpoints")
        .upsert(
          { run_id: runId, user_id: userId, key, value: (value ?? null) as never },
          { onConflict: "run_id,key" },
        );
      if (error) {
        // A failed checkpoint write only costs a repeat of this step on a
        // later continuation — it must never abort a healthy sweep.
        console.warn(`[radar:checkpoint] could not persist "${key}": ${error.message}`);
      }
      return value;
    },
    async read<T>(key) {
      await load();
      return cache.has(key) ? (cache.get(key) as T) : undefined;
    },
  };
}
