import { createClient } from "@supabase/supabase-js";
import { observedValue, valueAttributeKey } from "@/lib/monitoring/comparables";
import { asAttributeMap } from "@/lib/monitoring/attributes.server";
import { asConfig } from "@/lib/radar-types";
import { runRadarCycle } from "@/lib/monitoring/engine.server";
const db: any = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, { auth: { persistSession: false } });
const names = ["[TEST CAR]", "[TEST WATCH]", "[TEST REALESTATE]"];
async function snap(r: any) {
  const { data: f } = await db.from("findings").select("*").eq("radar_id", r.id);
  const vk = valueAttributeKey(asConfig(r.config).attribute_schema ?? []);
  const obs = (f ?? []).map((x: any) => ({ fingerprint: x.fingerprint, title: x.title, url: x.url, attributes: asAttributeMap(x.attributes) ?? {}, numericValue: x.numeric_value===null?null:Number(x.numeric_value), currency: x.currency, observedAt: x.last_seen_at, detailFetched: x.detail_status === "fetched" }));
  const usable = obs.filter((o: any) => observedValue(o, vk) !== null).length;
  return { total: obs.length, usable, coverage: obs.length ? +(usable/obs.length*100).toFixed(1) : 0,
    detailFetched: (f??[]).filter((x:any)=>x.detail_status==="fetched").length,
    computed: (f??[]).filter((x:any)=>x.baseline_status==="computed").length,
    insufficient: (f??[]).filter((x:any)=>x.baseline_status==="insufficient_comparables").length };
}
const mode = process.argv[2];
for (const n of names) {
  const { data: r } = await db.from("radars").select("*").like("name", n + "%").limit(1).maybeSingle();
  if (mode === "before" || mode === "after") { console.log(mode, r.name, JSON.stringify(await snap(r))); continue; }
  const res: any = await runRadarCycle(db, r);
  console.log("RUN", r.name, JSON.stringify({ budget: res.detailFetchBudget, reason: res.budgetReason, attempted: res.detailFetchesAttempted, ok: res.detailFetchesOk, failed: res.detailFetchesFailed, backoff: res.detailFetchesSkippedBackoff, usable: res.usableComparables, coverage: res.comparableCoverage, computed: res.baselinesComputed, backfilled: res.baselinesBackfilled, insufficient: res.baselinesInsufficient, cost: res.costEstimate, ceiling: res.costCeiling }));
}
