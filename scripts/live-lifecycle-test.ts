import { createClient } from "@supabase/supabase-js";
import { startRadarSweep } from "../src/lib/monitoring/sweep.server";
import { readSweepStatus } from "../src/lib/monitoring/sweep.server";

const db = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
  auth: { persistSession: false },
});
const RADAR = "b3b3bc87-b3fe-419a-872c-d4a0be6bf175";
const { data: radar } = await db.from("radars").select("*").eq("id", RADAR).single();
console.log("before:", radar!.scan_state, "lock:", radar!.active_run_id);

const start = await startRadarSweep(db as any, radar as any, { maxDetailFetches: 20 });
console.log("start:", start.state, start.runId);

// concurrency probe: a second start must not create a second run
try {
  await startRadarSweep(db as any, radar as any, {});
  console.log("CONCURRENCY: second start ALLOWED (bad)");
} catch (e) {
  console.log("CONCURRENCY: blocked ->", (e as Error).message);
}

let last = "";
for (let i = 0; i < 60; i++) {
  const { data: r } = await db.from("monitor_runs").select("status,current_phase,heartbeat_at,sources_retrieved,candidates_discovered,detail_fetches_ok,criteria_matched,criteria_unverified,criteria_rejected,persisted_findings,cost_estimate,failure_reason,started_at,finished_at").eq("id", start.runId!).single();
  const line = `${r!.status} | ${r!.current_phase} | hb ${r!.heartbeat_at} | src ${r!.sources_retrieved} cand ${r!.candidates_discovered} det ${r!.detail_fetches_ok}`;
  if (line !== last) { console.log(new Date().toISOString(), line); last = line; }
  if (r!.status !== "running") { console.log("FINAL:", JSON.stringify(r, null, 1)); break; }
  await new Promise((r) => setTimeout(r, 10000));
}
const { data: after } = await db.from("radars").select("scan_state,active_run_id,baseline_completed,initial_listings_count").eq("id", RADAR).single();
console.log("after radar:", JSON.stringify(after));
console.log("status fn:", JSON.stringify(await readSweepStatus(db as any, RADAR)));
