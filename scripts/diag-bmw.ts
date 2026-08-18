import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { interpretRequest } from "@/lib/ai/interpret.server";
import { runRadarCycle } from "@/lib/monitoring/engine.server";

const db = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const REQUEST = "Hitta svarta BMW M340i xDrive, årsmodell 2021 eller nyare, under 600 000 SEK i Sverige.";

const { data: users } = await db.from("profiles").select("id").limit(1);
const userId = users![0]!.id;

const interpreted = await interpretRequest(REQUEST);
console.log("INTERPRETED:", JSON.stringify(interpreted, null, 2));

const { data: radar, error } = await db
  .from("radars")
  .insert({
    user_id: userId,
    name: interpreted.name,
    raw_request: REQUEST,
    category: interpreted.category,
    frequency: interpreted.suggested_frequency,
    monitoring_window: interpreted.monitoring_window,
    recency_days: interpreted.recency_days,
    config: interpreted.config as never,
  })
  .select("*")
  .single();
if (error) throw error;
console.log("RADAR", radar.id);

const t0 = Date.now();
const result = await runRadarCycle(db as never, radar);
console.log("DURATION_S", ((Date.now() - t0) / 1000).toFixed(1));
console.log("RESULT", JSON.stringify(result, null, 2));
console.log("RADAR_ID", radar.id);
