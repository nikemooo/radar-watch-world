import { createClient } from "@supabase/supabase-js";
const db = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, { auth: { persistSession: false } });
for (const id of process.argv.slice(2)) {
  const { error } = await db.from("radars").update({ next_run_at: new Date().toISOString(), active_run_id: null }).eq("id", id);
  console.log(id, error?.message ?? "due now");
}
