import { createClient } from "@supabase/supabase-js";
import { comparableSettings, similarity, comparabilityKeys, valueAttributeKey, observedValue, buildBaseline } from "@/lib/monitoring/comparables";
import { asConfig } from "@/lib/radar-types";
const db: any = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, { auth: { persistSession: false } });
for (const like of ["[TEST CAR]%", "[TEST WATCH]%", "[TEST REALESTATE]%"]) {
  const { data: r } = await db.from("radars").select("*").like("name", like).limit(1).maybeSingle();
  const { data: f } = await db.from("findings").select("*").eq("radar_id", r.id);
  const specs = asConfig(r.config).attribute_schema ?? [];
  const vk = valueAttributeKey(specs); const keys = comparabilityKeys(specs, vk);
  const obs = f.map((x: any) => ({ fingerprint: x.fingerprint, title: x.title, url: x.url, attributes: x.attributes ?? {}, numericValue: x.numeric_value===null?null:Number(x.numeric_value), currency: x.currency, observedAt: x.last_seen_at, detailFetched: x.detail_status === "fetched" }));
  const wv = obs.filter((o: any) => observedValue(o, vk));
  const cur: Record<string, number> = {};
  for (const o of wv) { const c = observedValue(o, vk)!.currency ?? "none"; cur[c] = (cur[c]??0)+1; }
  const s = comparableSettings({ minComparables: r.min_comparables }, r.recency_days);
  const counts = wv.map((subj: any) => wv.filter((o: any) => o.fingerprint !== subj.fingerprint && (observedValue(o,vk)!.currency ?? null) === (observedValue(subj,vk)!.currency ?? null) && similarity(subj,o,keys).score >= 0.6).length);
  console.log(r.name, "| withValue", wv.length, "| currencies", JSON.stringify(cur), "| max comparables per subject", Math.max(...counts), "| median", counts.sort((a:number,b:number)=>a-b)[Math.floor(counts.length/2)], "| maxAge", s.maxObservationAgeDays);
  const best = wv.map((subj:any)=>({subj, b: buildBaseline({subject:subj, population: wv, specs, settings: s})})).filter((x:any)=>x.b.status==="computed");
  console.log("  computed:", best.length);
}
