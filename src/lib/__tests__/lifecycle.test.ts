/**
 * Run-lifecycle regression suite.
 *
 * Covers the rules that keep a sweep from ever getting stuck: atomic claim,
 * heartbeat, stale detection, reaping, radar-state recovery and retry. No
 * network and no search provider is involved — the database is an in-memory
 * fake, so these tests can be run as often as needed for free.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_STALE_MS,
  isStaleRun,
  phaseLabel,
  staleVerdict,
} from "../monitoring/lifecycle";

// ---------------------------------------------------------------------------
// Minimal in-memory Supabase stand-in (only the operations the lifecycle uses).
// ---------------------------------------------------------------------------
type Row = Record<string, any>;

class Query implements PromiseLike<{ data: any; error: any }> {
  private filters: { col: string; val: any; op: "eq" | "is" }[] = [];
  private orExpr: string | null = null;
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row | Row[] | null = null;
  private wantsRows = false;
  private single = false;
  private limitN: number | null = null;

  constructor(
    private store: Record<string, Row[]>,
    private table: string,
  ) {}

  select(_cols?: string) {
    if (this.mode === "select") this.wantsRows = true;
    else this.wantsRows = true;
    return this;
  }
  insert(payload: Row | Row[]) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  eq(col: string, val: any) {
    this.filters.push({ col, val, op: "eq" });
    return this;
  }
  is(col: string, val: any) {
    this.filters.push({ col, val, op: "is" });
    return this;
  }
  or(expr: string) {
    this.orExpr = expr;
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    this.wantsRows = true;
    return this;
  }

  private matches(row: Row): boolean {
    const base = this.filters.every((f) =>
      f.op === "is" ? (row[f.col] ?? null) === f.val : row[f.col] === f.val,
    );
    if (!base) return false;
    if (!this.orExpr) return true;
    return this.orExpr.split(",").some((clause) => {
      const [col, op, val] = clause.split(".");
      if (op === "is") return (row[col!] ?? null) === null;
      return row[col!] === val;
    });
  }

  private run() {
    const rows = (this.store[this.table] ??= []);
    if (this.mode === "insert") {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload!];
      rows.push(...items.map((i) => ({ ...i })));
      return { data: this.wantsRows ? items : null, error: null };
    }
    if (this.mode === "update") {
      const hit = rows.filter((r) => this.matches(r));
      for (const r of hit) Object.assign(r, this.payload);
      return { data: this.wantsRows ? hit : null, error: null };
    }
    let hit = rows.filter((r) => this.matches(r));
    if (this.limitN !== null) hit = hit.slice(0, this.limitN);
    return { data: this.single ? (hit[0] ?? null) : hit, error: null };
  }

  then<T1 = { data: any; error: any }, T2 = never>(
    resolve?: ((v: { data: any; error: any }) => T1 | PromiseLike<T1>) | null,
    reject?: ((r: any) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(resolve, reject);
  }
}

function fakeDb(store: Record<string, Row[]>) {
  return { from: (table: string) => new Query(store, table) } as any;
}

const RADAR = {
  id: "radar-1",
  user_id: "user-1",
  baseline_completed: false,
  scan_state: "initial_scan_pending",
  active_run_id: null,
} as any;

let store: Record<string, Row[]>;
beforeEach(() => {
  store = { radars: [{ ...RADAR }], monitor_runs: [] };
});

const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------

describe("stale detection", () => {
  const now = Date.now();

  it("never marks a non-running run stale", () => {
    expect(isStaleRun({ id: "1", status: "completed", started_at: iso(0) }, now)).toBe(false);
  });

  it("protects a run that is actively heartbeating", () => {
    const run = { id: "1", status: "running", started_at: iso(now - 600_000), heartbeat_at: iso(now - 5_000) };
    expect(staleVerdict(run, now)).toEqual({ stale: false });
  });

  it("reaps a run whose heartbeat went quiet", () => {
    const run = {
      id: "1",
      status: "running",
      started_at: iso(now - 600_000),
      heartbeat_at: iso(now - HEARTBEAT_STALE_MS - 1_000),
    };
    expect(staleVerdict(run, now)).toEqual({ stale: true, reason: "heartbeat_timeout" });
  });

  it("reaps a run that never heartbeated once past the threshold", () => {
    const fresh = { id: "1", status: "running", started_at: iso(now - 10_000), heartbeat_at: null };
    const dead = { id: "2", status: "running", started_at: iso(now - HEARTBEAT_STALE_MS - 1), heartbeat_at: null };
    expect(isStaleRun(fresh, now)).toBe(false);
    expect(staleVerdict(dead, now)).toEqual({ stale: true, reason: "worker_lost" });
  });

  it("abandons a run that exceeds the absolute ceiling even while heartbeating", () => {
    const run = { id: "1", status: "running", started_at: iso(now - 21 * 60_000), heartbeat_at: iso(now) };
    expect(staleVerdict(run, now)).toEqual({ stale: true, reason: "run_timeout" });
  });

  it("maps phases to human labels", () => {
    expect(phaseLabel("fetching_details")).toBe("Läser annonsdetaljer");
    expect(phaseLabel(null)).toBe("Förbereder sökningen");
  });
});

describe("beginRun", () => {
  it("creates a running run and flips the radar immediately", async () => {
    const { beginRun } = await import("../monitoring/engine.server");
    const db = fakeDb(store);
    const claim = await beginRun(db, store["radars"]![0] as any);

    expect(claim.runId).toBeTruthy();
    const run = store["monitor_runs"]![0]!;
    expect(run["status"]).toBe("running");
    expect(run["current_phase"]).toBe("initializing");
    expect(run["heartbeat_at"]).toBeTruthy();
    expect(store["radars"]![0]!["scan_state"]).toBe("INITIAL_SCAN_RUNNING");
    expect(store["radars"]![0]!["active_run_id"]).toBe(claim.runId);
  });

  it("refuses a second concurrent run (double click) and points at the live one", async () => {
    const { beginRun, ActiveRunError } = await import("../monitoring/engine.server");
    const db = fakeDb(store);
    const first = await beginRun(db, store["radars"]![0] as any);
    await expect(beginRun(db, { ...RADAR } as any)).rejects.toBeInstanceOf(ActiveRunError);
    expect(store["monitor_runs"]!.length).toBe(1);
    expect(store["radars"]![0]!["active_run_id"]).toBe(first.runId);
  });

  it("reaps a dead run and lets a retry start", async () => {
    const { beginRun } = await import("../monitoring/engine.server");
    const db = fakeDb(store);
    const first = await beginRun(db, store["radars"]![0] as any);
    // Simulate a worker/server death: no heartbeat for longer than the window.
    const stale = iso(Date.now() - HEARTBEAT_STALE_MS - 60_000);
    // Quiet AND out of continuations: the run can no longer be resumed, so a
    // fresh run is allowed to take over.
    Object.assign(store["monitor_runs"]![0]!, {
      started_at: stale,
      heartbeat_at: stale,
      attempt: MAX_RUN_ATTEMPTS,
    });

    const second = await beginRun(db, { ...RADAR } as any);
    expect(second.runId).not.toBe(first.runId);
    expect(store["monitor_runs"]!.length).toBe(2);
    const dead = store["monitor_runs"]![0]!;
    expect(dead["status"]).toBe("failed");
    expect(dead["failure_reason"]).toBe("heartbeat_timeout");
    expect(dead["failed_at"]).toBeTruthy();
    expect(dead["started_at"]).toBe(stale); // history intact
  });
});

describe("reaper", () => {
  it("closes the dead run and restores a radar without a baseline", async () => {
    const { reapStaleRuns } = await import("../monitoring/reaper.server");
    const stale = iso(Date.now() - HEARTBEAT_STALE_MS - 60_000);
    store["monitor_runs"]!.push({
      id: "run-dead",
      radar_id: "radar-1",
      user_id: "user-1",
      status: "running",
      started_at: stale,
      heartbeat_at: stale,
      attempt: MAX_RUN_ATTEMPTS,
      current_phase: "searching_sources",
    });
    store["radars"]![0]!["scan_state"] = "INITIAL_SCAN_RUNNING";
    store["radars"]![0]!["active_run_id"] = "run-dead";

    const reaped = await reapStaleRuns(fakeDb(store));
    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.reason).toBe("heartbeat_timeout");
    expect(reaped[0]!.lastPhase).toBe("searching_sources");
    expect(store["radars"]![0]!["scan_state"]).toBe("initial_scan_pending");
    expect(store["radars"]![0]!["active_run_id"]).toBeNull();
  });

  it("returns a baselined radar to monitoring", async () => {
    const { reapStaleRuns } = await import("../monitoring/reaper.server");
    const stale = iso(Date.now() - HEARTBEAT_STALE_MS - 60_000);
    store["radars"]![0] = {
      ...RADAR,
      baseline_completed: true,
      scan_state: "INITIAL_SCAN_RUNNING",
      active_run_id: "run-dead",
    };
    store["monitor_runs"]!.push({
      id: "run-dead",
      radar_id: "radar-1",
      user_id: "user-1",
      status: "running",
      started_at: stale,
      heartbeat_at: stale,
      attempt: MAX_RUN_ATTEMPTS,
      current_phase: "fetching_details",
    });

    await reapStaleRuns(fakeDb(store));
    expect(store["radars"]![0]!["scan_state"]).toBe("MONITORING");
  });

  it("leaves healthy runs — and other radars' runs — untouched", async () => {
    const { reapStaleRuns } = await import("../monitoring/reaper.server");
    const stale = iso(Date.now() - HEARTBEAT_STALE_MS - 60_000);
    store["radars"]!.push({ ...RADAR, id: "radar-2", active_run_id: "run-live" });
    store["monitor_runs"]!.push(
      {
        id: "run-dead",
        radar_id: "radar-1",
        user_id: "user-1",
        status: "running",
        started_at: stale,
        heartbeat_at: stale,
        attempt: MAX_RUN_ATTEMPTS,
        current_phase: "searching_sources",
      },
      {
        id: "run-live",
        radar_id: "radar-2",
        user_id: "user-1",
        status: "running",
        started_at: iso(Date.now() - 30_000),
        heartbeat_at: iso(Date.now() - 3_000),
        current_phase: "fetching_details",
      },
    );

    const reaped = await reapStaleRuns(fakeDb(store), { radarId: "radar-1" });
    expect(reaped.map((r) => r.runId)).toEqual(["run-dead"]);
    const live = store["monitor_runs"]!.find((r) => r["id"] === "run-live")!;
    expect(live["status"]).toBe("running");
    expect(store["radars"]![1]!["active_run_id"]).toBe("run-live");
  });

  it("does not reap a quiet run that can still be resumed", async () => {
    const { reapStaleRuns } = await import("../monitoring/reaper.server");
    const quiet = iso(Date.now() - HEARTBEAT_STALE_MS - 60_000);
    store["monitor_runs"]!.push({
      id: "run-quiet",
      radar_id: "radar-1",
      user_id: "user-1",
      status: "running",
      started_at: quiet,
      heartbeat_at: quiet,
      attempt: 1,
      current_phase: "fetching_details",
    });
    expect(await reapStaleRuns(fakeDb(store))).toHaveLength(0);
    expect(store["monitor_runs"]!.find((r) => r["id"] === "run-quiet")!["status"]).toBe("running");
  });

  it("is idempotent — an already-failed run is not reaped twice", async () => {
    const { reapStaleRuns } = await import("../monitoring/reaper.server");
    const stale = iso(Date.now() - HEARTBEAT_STALE_MS - 60_000);
    store["monitor_runs"]!.push({
      id: "run-dead",
      radar_id: "radar-1",
      user_id: "user-1",
      status: "running",
      started_at: stale,
      heartbeat_at: stale,
      attempt: MAX_RUN_ATTEMPTS,
      current_phase: "query_planning",
    });
    const db = fakeDb(store);
    expect((await reapStaleRuns(db)).length).toBe(1);
    expect((await reapStaleRuns(db)).length).toBe(0);
  });
});

describe("heartbeat", () => {
  it("writes phase transitions and periodic beats, and stops cleanly", async () => {
    vi.useFakeTimers();
    const { startRunHeartbeat } = await import("../monitoring/heartbeat.server");
    store["monitor_runs"]!.push({ id: "run-1", radar_id: "radar-1", status: "running" });
    const db = fakeDb(store);
    const tracker = startRunHeartbeat(db, "run-1");

    await tracker.phase("searching_sources");
    const row = store["monitor_runs"]![0]!;
    expect(row["current_phase"]).toBe("searching_sources");
    const firstBeat = row["heartbeat_at"];

    await vi.advanceTimersByTimeAsync(40_000);
    expect(row["heartbeat_at"]).not.toBe(firstBeat);

    const lastBeat = row["heartbeat_at"];
    tracker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(row["heartbeat_at"]).toBe(lastBeat);
    vi.useRealTimers();
  });

  it("a beating run survives every reaper pass", async () => {
    const { startRunHeartbeat } = await import("../monitoring/heartbeat.server");
    const { reapStaleRuns } = await import("../monitoring/reaper.server");
    const started = iso(Date.now() - 10 * 60_000);
    store["monitor_runs"]!.push({
      id: "run-1",
      radar_id: "radar-1",
      user_id: "user-1",
      status: "running",
      started_at: started,
      heartbeat_at: started,
      current_phase: "fetching_details",
    });
    const db = fakeDb(store);
    const tracker = startRunHeartbeat(db, "run-1");
    await tracker.beat();
    expect(await reapStaleRuns(db)).toHaveLength(0);
    tracker.stop();
  });
});
