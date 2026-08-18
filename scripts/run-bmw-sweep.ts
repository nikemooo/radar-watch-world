import { createClient } from "@supabase/supabase-js";
import { runRadarCycle } from "../src/lib/monitoring/engine.server";
const db = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
  auth: { persistSession: false },
});
const { data } = await db.from("radars").select("*").eq("id", "c21942d3-4e4c-4e74-9010-47672aba8fa1").single();
const res = await runRadarCycle(db as any, data as any, { maxDetailFetches: 20 });
console.log("RESULT:", JSON.stringify(res, null, 1).slice(0, 6000));
