import { createClient } from "@supabase/supabase-js";
import { runRadarCycle } from "@/lib/monitoring/engine.server";

const db = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
  auth: { persistSession: false },
}) as never;

const { data: radars } = await (db as any).from("radars").select("*").order("created_at");
const want = ["[TEST CAR]", "[TEST WATCH]", "[TEST REALESTATE]"];
for (const key of want) {
  const radar = (radars ?? []).find((r: any) => r.name.startsWith(key));
  if (!radar) { console.log("no radar for", key); continue; }
  console.log("\n=== ", key, radar.name);
  const res = await runRadarCycle(db, radar);
  console.log(JSON.stringify(res, null, 1));
  const { data: f } = await (db as any)
    .from("findings")
    .select("title,baseline_status,baseline_confidence,anomaly_score,opportunity_score,baseline,numeric_value,currency")
    .eq("radar_id", radar.id);
  const computed = (f ?? []).filter((x: any) => x.baseline_status === "computed");
  const insuff = (f ?? []).filter((x: any) => x.baseline_status === "insufficient_comparables");
  console.log("findings:", f?.length, "computed:", computed.length, "insufficient:", insuff.length,
    "no_value:", (f ?? []).filter((x:any)=>x.baseline_status==="no_value").length);
  const best = computed.sort((a: any, b: any) => (b.opportunity_score ?? 0) - (a.opportunity_score ?? 0))[0];
  if (best) console.log("example:", best.title, "|", best.baseline.statement, "| conf", best.baseline_confidence);
}
