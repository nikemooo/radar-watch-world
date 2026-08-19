/**
 * Scheduling arithmetic — pure, category-agnostic, testable.
 *
 * A radar's cadence is expressed as a frequency, never as a timer living in a
 * browser tab. The scheduler asks this module when a radar is next due, so the
 * same answer is produced by the cron tick, by the engine after a run, and by
 * the UI when it renders "next run".
 */
import { frequencyToMinutes } from "../radar-types";

export type SchedulableRadar = {
  id: string;
  status: string | null;
  frequency: string;
  next_run_at: string | null;
  scheduled_start_at: string | null;
  last_run_at: string | null;
  active_run_id: string | null;
};

/** When should this radar run again after finishing a sweep at `from`? */
export function computeNextRunAt(
  frequency: string,
  from: Date | string = new Date(),
  status: string | null = "active",
): string | null {
  if (status !== "active") return null;
  const base = typeof from === "string" ? new Date(from) : from;
  const minutes = frequencyToMinutes(frequency);
  return new Date(base.getTime() + minutes * 60_000).toISOString();
}

/** Is the radar due to start a sweep right now? */
export function isDue(radar: SchedulableRadar, now: number = Date.now()): boolean {
  if (radar.status !== "active") return false;
  if (radar.active_run_id) return false; // a sweep already owns this radar
  const due = radar.next_run_at ?? radar.scheduled_start_at;
  if (!due) return false;
  const at = Date.parse(due);
  return Number.isFinite(at) && at <= now;
}
