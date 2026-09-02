import { createClient } from "@supabase/supabase-js";
import { runMarketCycle } from "../src/lib/market/engine.server";
const id = process.argv[2]!;
const db = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
  auth: { persistSession: false },
});
const { data, error } = await db.from("radars").select("*").eq("id", id).single();
if (error) throw error;
const t = Date.now();
const res = await runMarketCycle(db as any, data as any);
console.log("ELAPSED_MS", Date.now() - t);
console.log("RESULT:", JSON.stringify(res, null, 1).slice(0, 4000));
