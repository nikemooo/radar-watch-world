import { createClient } from "@supabase/supabase-js";
import { comparableSettings, buildBaseline, similarity, comparabilityKeys, valueAttributeKey, observedValue } from "@/lib/monitoring/comparables";
import { asConfig } from "@/lib/radar-types";
const db: any = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, { auth: { persistSession: false } });
const { data: radars } = await db.from("radars").select("*");
for (const r of radars) {
  const { data: f } = await db.from("findings").select("*").eq("radar_id", r.id);
  const specs = asConfig(r.config).attribute_schema ?? [];
  const obs = (f ?? []).map((x: any) => ({ fingerprint: x.fingerprint, title: x.title, url: x.url, attributes: x.attributes ?? {}, numericValue: x.numeric_value === null ? null : Number(x.numeric_value), currency: x.currency, observedAt: x.last_seen_at, detailFetched: x.detail_status === "fetched" }));
  const vk = valueAttributeKey(specs);
  const keys = comparabilityKeys(specs, vk);
  const withValue = obs.filter((o: any) => observedValue(o, vk));
  console.log(`\n${r.name} | findings ${obs.length} | specs ${specs.map((s:any)=>s.key+":"+s.kind).join(",")} | valueKey ${vk} | withValue ${withValue.length}`);
  if (withValue.length < 2) continue;
  const s = comparableSettings({ minComparables: r.min_comparables }, r.recency_days);
  const subj = withValue[0];
  const sims = withValue.slice(1).map((o: any) => similarity(subj, o, keys));
  console.log(" currencies:", [...new Set(withValue.map((o:any)=>observedValue(o,vk)!.currency))].join("/"));
  console.log(" sim scores:", sims.map((x:any)=>x.score.toFixed(2)).join(" "), "| matchedOn ex:", sims[0]?.matchedOn.join(","));
  console.log(" ->", buildBaseline({ subject: subj, population: withValue, specs, settings: s }).statement.slice(0,180));
}
