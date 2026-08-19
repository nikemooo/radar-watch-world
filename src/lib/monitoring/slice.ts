/**
 * Time-sliced sweep execution.
 *
 * A sweep takes minutes; a serverless invocation may end as soon as its HTTP
 * response is sent. Relying on background execution therefore loses whichever
 * expensive call happened to be in flight — which is exactly how a run could
 * spend every attempt inside the same phase and never persist a checkpoint.
 *
 * The fix is to stop treating the sweep as "one long job that hopefully
 * survives". Instead each invocation does a bounded SLICE of work inside the
 * request it owns, and pauses cleanly on a deadline right after a checkpoint
 * was durably written. The run stays claimed and running; the next invocation
 * (scheduler tick or UI poll) resumes it from that checkpoint, paying nothing
 * twice.
 *
 * Nothing here is category-specific — it is pure execution control.
 */

/** Thrown when a slice hits its deadline between two checkpointed steps. */
export class SweepPaused extends Error {
  readonly phase: string;
  readonly completedStep: string;
  constructor(phase: string, completedStep: string) {
    super(`sweep paused after step "${completedStep}" (phase ${phase})`);
    this.name = "SweepPaused";
    this.phase = phase;
    this.completedStep = completedStep;
  }
}

export function isSweepPaused(err: unknown): err is SweepPaused {
  return err instanceof Error && err.name === "SweepPaused";
}

/** Default slice length for a request that a user is actively waiting on. */
export const UI_SLICE_MS = 18_000;

/** Slice length for the server-driven scheduler tick (no user waiting). */
export const TICK_SLICE_MS = 30_000;

export function deadlineFromNow(ms: number): number {
  return Date.now() + ms;
}
