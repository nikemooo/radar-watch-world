import { createClient } from "@supabase/supabase-js";
import { runMarketCycle } from "../src/lib/market/engine.server";
const db = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, { auth: { persistSession: false } });
const { data: gold } = await db.from("radars").select("*").eq("id","c91e7167-92ae-4aa1-b1cf-df7bbccb6dc5").single();
const g:any = gold;
const { data: created, error } = await db.from("radars").insert({
  user_id: g.user_id, name: "[TEST BASELINE] Gold alert check", raw_request: g.raw_request,
  category: g.category, config: g.config, frequency: g.frequency, status: "active",
  baseline_completed: false, is_test: true, mode: g.mode, scan_state: "idle",
}).select("*").single();
if (error) throw error;
const res = await runMarketCycle(db as any, created as any);
console.log("RESULT", JSON.stringify(res));
const { data: alerts } = await db.from("alerts").select("title, importance, created_at").eq("radar_id", (created as any).id);
console.log("ALERTS", JSON.stringify(alerts, null, 1));
console.log("RADAR_ID", (created as any).id);
