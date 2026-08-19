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
 *
 * The contract is deliberately strict:
 *
 *   checkpoint persisted  ⇒ the operation is completed and must not be redone
 *   no checkpoint         ⇒ the operation may need a retry
 *
 * Therefore a failed checkpoint write is NOT a warning. If the database did
 * not accept the checkpoint the run is not resumable, and pretending otherwise
 * is exactly the bug that made sweeps restart from query planning forever. A
 * failed write throws `CheckpointWriteError`, which the caller turns into an
 * honest run failure (lock released, radar state restored).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Db = SupabaseClient<Database>;

/** Envelope version — bump when the stored shape changes meaning. */
export const CHECKPOINT_SCHEMA_VERSION = 1;

export type CheckpointEnvelope<T = unknown> = {
  v: number;
  run_id: string;
  radar_id: string | null;
  key: string;
  phase: string | null;
  at: string;
  data: T;
};

export class CheckpointWriteError extends Error {
  readonly key: string;
  readonly runId: string;
  constructor(runId: string, key: string, cause: string) {
    super(`checkpoint "${key}" could not be persisted for run ${runId}: ${cause}`);
    this.name = "CheckpointWriteError";
    this.runId = runId;
    this.key = key;
  }
}

export type CheckpointStore = {
  runId: string | null;
  /** Number of steps served from persisted state during this invocation. */
  readonly resumedSteps: number;
  /** Keys that were completed before this invocation started. */
  readonly restoredKeys: string[];
  /** Run `fn` unless this step already completed for this run. */
  step<T>(key: string, fn: () => Promise<T>, meta?: { phase?: string }): Promise<T>;
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
    get restoredKeys() {
      return [];
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

function unwrap<T>(stored: unknown): T {
  if (stored && typeof stored === "object" && "v" in (stored as Record<string, unknown>)) {
    return (stored as CheckpointEnvelope<T>).data;
  }
  // Tolerate pre-envelope rows so an in-flight run is never lost by a deploy.
  return stored as T;
}

export function createCheckpointStore(
  db: Db,
  runId: string | null,
  userId: string,
  radarId: string | null = null,
): CheckpointStore {
  if (!runId) return memoryCheckpointStore(null);
  const cache = new Map<string, unknown>();
  const restored: string[] = [];
  let loaded = false;
  let resumed = 0;

  const load = async () => {
    if (loaded) return;
    const { data, error } = await db
      .from("run_checkpoints")
      .select("key, value")
      .eq("run_id", runId);
    if (error) {
      // Reading is as critical as writing: without the persisted state a
      // continuation would silently repeat paid work.
      throw new CheckpointWriteError(runId, "*", `read failed — ${error.message}`);
    }
    loaded = true;
    for (const row of data ?? []) {
      cache.set(row.key, unwrap(row.value));
      restored.push(row.key);
    }
  };

  return {
    runId,
    get resumedSteps() {
      return resumed;
    },
    get restoredKeys() {
      return [...restored];
    },
    async step<T>(key: string, fn: () => Promise<T>, meta?: { phase?: string }): Promise<T> {
      await load();
      if (cache.has(key)) {
        resumed += 1;
        console.info(`[radar:checkpoint] run ${runId} resumed step "${key}"`);
        return cache.get(key) as T;
      }
      const value = await fn();
      const envelope: CheckpointEnvelope<T> = {
        v: CHECKPOINT_SCHEMA_VERSION,
        run_id: runId,
        radar_id: radarId,
        key,
        phase: meta?.phase ?? null,
        at: new Date().toISOString(),
        data: value,
      };
      const { data, error } = await db
        .from("run_checkpoints")
        .upsert(
          {
            run_id: runId,
            user_id: userId,
            radar_id: radarId,
            phase: meta?.phase ?? null,
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            key,
            value: envelope as never,
          },
          { onConflict: "run_id,key" },
        )
        .select("id");
      if (error || !data?.length) {
        // Loud and fatal: an unpersisted step means the run cannot honestly
        // claim to be resumable.
        console.error(
          JSON.stringify({
            event: "checkpoint_write_failed",
            run_id: runId,
            radar_id: radarId,
            key,
            phase: meta?.phase ?? null,
            error: error?.message ?? "no row returned",
          }),
        );
        throw new CheckpointWriteError(runId, key, error?.message ?? "no row returned");
      }
      cache.set(key, value);
      console.info(`[radar:checkpoint] run ${runId} persisted step "${key}"`);
      return value;
    },
    async read<T>(key: string): Promise<T | undefined> {
      await load();
      return cache.has(key) ? (cache.get(key) as T) : undefined;
    },
  };
}
