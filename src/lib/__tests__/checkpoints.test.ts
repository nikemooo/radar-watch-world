import { describe, expect, it } from "vitest";
import {
  CheckpointWriteError,
  createCheckpointStore,
} from "@/lib/monitoring/checkpoints.server";

/**
 * A minimal stand-in for the checkpoint table. It behaves like the real one in
 * the only two ways that matter here: rows survive between "workers", and a
 * denied write returns an error instead of silently succeeding.
 */
function fakeDb(options: { denyWrite?: boolean; denyRead?: boolean } = {}) {
  const rows: { run_id: string; key: string; value: unknown }[] = [];
  let writes = 0;
  const db = {
    rows,
    get writes() {
      return writes;
    },
    from() {
      return {
        select() {
          return {
            eq: async (_col: string, runId: string) =>
              options.denyRead
                ? { data: null, error: { message: "permission denied" } }
                : { data: rows.filter((r) => r.run_id === runId), error: null },
          };
        },
        upsert(row: { run_id: string; key: string; value: unknown }) {
          return {
            select: async () => {
              if (options.denyWrite) {
                return { data: null, error: { message: "new row violates row-level security policy" } };
              }
              writes += 1;
              const existing = rows.find((r) => r.run_id === row.run_id && r.key === row.key);
              if (existing) existing.value = row.value;
              else rows.push({ run_id: row.run_id, key: row.key, value: row.value });
              return { data: [{ id: "row" }], error: null };
            },
          };
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db as any;
}

const RUN = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const RADAR = "33333333-3333-3333-3333-333333333333";

describe("checkpoints", () => {
  it("persists a completed step and stores full recovery metadata", async () => {
    const db = fakeDb();
    const store = createCheckpointStore(db, RUN, USER, RADAR);
    await store.step("query_planning", async () => ["q1", "q2"], { phase: "query_planning" });

    expect(db.rows).toHaveLength(1);
    const env = db.rows[0]!.value as Record<string, unknown>;
    expect(env["v"]).toBe(1);
    expect(env["run_id"]).toBe(RUN);
    expect(env["radar_id"]).toBe(RADAR);
    expect(env["key"]).toBe("query_planning");
    expect(env["phase"]).toBe("query_planning");
    expect(typeof env["at"]).toBe("string");
    expect(env["data"]).toEqual(["q1", "q2"]);
  });

  it("a new worker reads the checkpoint instead of redoing the work", async () => {
    const db = fakeDb();
    await createCheckpointStore(db, RUN, USER, RADAR).step("query_planning", async () => ["q1"]);

    const next = createCheckpointStore(db, RUN, USER, RADAR);
    expect(await next.read<string[]>("query_planning")).toEqual(["q1"]);
    expect(next.restoredKeys).toEqual(["query_planning"]);
  });

  it("resumes at the first uncheckpointed step without repeating paid work", async () => {
    const db = fakeDb();
    // Worker 1: planning completes, then the worker dies during research.
    const first = createCheckpointStore(db, RUN, USER, RADAR);
    await first.step("query_planning", async () => ["q1"]);

    // Worker 2: same run, continuation.
    let planningCalls = 0;
    let researchCalls = 0;
    const second = createCheckpointStore(db, RUN, USER, RADAR);
    await second.step("query_planning", async () => {
      planningCalls += 1;
      return ["q1"];
    });
    await second.step("research", async () => {
      researchCalls += 1;
      return { sources: 12 };
    });

    expect(planningCalls).toBe(0); // no duplicate provider spend
    expect(researchCalls).toBe(1); // the step that never completed is retried
    expect(second.resumedSteps).toBe(1);
    expect(db.rows.map((r) => r.key)).toEqual(["query_planning", "research"]);
  });

  it("re-running an already checkpointed step never writes again", async () => {
    const db = fakeDb();
    const a = createCheckpointStore(db, RUN, USER, RADAR);
    await a.step("research", async () => 1);
    const writesAfterFirst = db.writes;
    const b = createCheckpointStore(db, RUN, USER, RADAR);
    await b.step("research", async () => 2);
    expect(db.writes).toBe(writesAfterFirst);
  });

  it("throws instead of pretending to be resumable when the write is denied", async () => {
    const db = fakeDb({ denyWrite: true });
    const store = createCheckpointStore(db, RUN, USER, RADAR);
    await expect(store.step("research", async () => 1)).rejects.toBeInstanceOf(
      CheckpointWriteError,
    );
    expect(db.rows).toHaveLength(0);
  });

  it("throws when the checkpoint state cannot even be read", async () => {
    const db = fakeDb({ denyRead: true });
    const store = createCheckpointStore(db, RUN, USER, RADAR);
    await expect(store.step("research", async () => 1)).rejects.toBeInstanceOf(
      CheckpointWriteError,
    );
  });

  it("tolerates pre-envelope rows written by an older worker", async () => {
    const db = fakeDb();
    db.rows.push({ run_id: RUN, key: "query_planning", value: ["legacy"] });
    const store = createCheckpointStore(db, RUN, USER, RADAR);
    expect(await store.read<string[]>("query_planning")).toEqual(["legacy"]);
  });
});
