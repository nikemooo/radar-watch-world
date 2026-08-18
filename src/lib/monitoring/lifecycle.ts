/**
 * Run lifecycle rules — pure, testable, no database and no network.
 *
 * A sweep may take minutes, so "slow" and "dead" cannot be told apart by
 * elapsed time alone. A live worker writes a heartbeat; the absence of a
 * heartbeat is what proves the worker is gone.
 */

/** How often a live worker writes heartbeat_at. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long a run may go without a heartbeat before it is considered dead.
 * Comfortably larger than the heartbeat interval (so a slow phase or a
 * transient write failure never kills a live run), short enough that a user
 * never stares at "Söker igenom marknaden…" for more than ~2 minutes after the
 * worker actually died.
 */
export const HEARTBEAT_STALE_MS = 120_000;

/** Absolute ceiling: even a heartbeating run is abandoned after this long. */
export const MAX_RUN_MS = 20 * 60_000;

export type RunPhase =
  | "initializing"
  | "query_planning"
  | "searching_sources"
  | "expanding_indexes"
  | "extracting_candidates"
  | "fetching_details"
  | "extracting_attributes"
  | "analyzing_images"
  | "evaluating_criteria"
  | "building_comparables"
  | "persisting_results"
  | "completed";

export type FailureReason = "worker_lost" | "heartbeat_timeout" | "run_timeout" | "start_failed";

export type LifecycleRun = {
  id: string;
  status: string | null;
  started_at: string;
  heartbeat_at?: string | null;
};

export type StaleVerdict = { stale: false } | { stale: true; reason: FailureReason };

/**
 * Is this run dead? Only running rows can be stale, and a run that reported a
 * heartbeat inside the window is always left alone.
 */
export function staleVerdict(run: LifecycleRun, now: number = Date.now()): StaleVerdict {
  if (run.status !== "running") return { stale: false };
  const started = new Date(run.started_at).getTime();
  const beat = run.heartbeat_at ? new Date(run.heartbeat_at).getTime() : null;
  if (Number.isFinite(started) && now - started > MAX_RUN_MS) {
    return { stale: true, reason: "run_timeout" };
  }
  if (beat !== null && Number.isFinite(beat)) {
    return now - beat > HEARTBEAT_STALE_MS ? { stale: true, reason: "heartbeat_timeout" } : { stale: false };
  }
  // Never heartbeated: the worker died before its first beat (typically a
  // server restart moments after the run was claimed).
  return now - started > HEARTBEAT_STALE_MS ? { stale: true, reason: "worker_lost" } : { stale: false };
}

export function isStaleRun(run: LifecycleRun, now: number = Date.now()): boolean {
  return staleVerdict(run, now).stale;
}

/** Human phase labels for the UI — deliberately non-technical. */
export const PHASE_LABELS: Record<RunPhase, string> = {
  initializing: "Förbereder sökningen",
  query_planning: "Planerar sökningen",
  searching_sources: "Söker igenom marknaden",
  expanding_indexes: "Hittar aktuella annonser",
  extracting_candidates: "Hittar aktuella annonser",
  fetching_details: "Läser annonsdetaljer",
  extracting_attributes: "Läser annonsdetaljer",
  analyzing_images: "Analyserar bilder",
  evaluating_criteria: "Verifierar kriterier",
  building_comparables: "Jämför marknadspriser",
  persisting_results: "Sammanställer resultatet",
  completed: "Klar",
};

export function phaseLabel(phase: string | null | undefined): string {
  return PHASE_LABELS[(phase ?? "initializing") as RunPhase] ?? "Söker igenom marknaden";
}
