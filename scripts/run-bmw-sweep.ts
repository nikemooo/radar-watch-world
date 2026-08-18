import { createClient } from "@supabase/supabase-js";
import { runRadarCycle } from "../src/lib/monitoring/engine.server";
const db = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
  auth: { persistSession: false },
});
const { data } = await db.from("radars").select("*").eq("id", "58b9f6ee-2a37-4655-85ff-fea810d54d7e").single();
const res = await runRadarCycle(db as any, data as any, { maxDetailFetches: 20 });
console.log("RESULT:", JSON.stringify(res, null, 1).slice(0, 6000));
