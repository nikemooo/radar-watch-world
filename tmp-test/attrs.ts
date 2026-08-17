import { createClient } from "@supabase/supabase-js";
const db: any = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, { auth: { persistSession: false } });
for (const name of ["[TEST CAR]", "[TEST WATCH]", "[TEST REALESTATE]"]) {
  const { data: r } = await db.from("radars").select("id,name").like("name", name + "%").limit(1).maybeSingle();
  const { data: f } = await db.from("findings").select("title,attributes,currency,numeric_value,detail_status").eq("radar_id", r.id);
  const withAttrs = f.filter((x: any) => Object.values(x.attributes ?? {}).some((a: any) => a?.raw));
  console.log(r.name, "total", f.length, "withAttrs", withAttrs.length);
  for (const x of withAttrs.slice(0, 4)) console.log("  ", x.title.slice(0,60), "|", Object.entries(x.attributes).filter(([,a]:any)=>a?.raw).map(([k,a]:any)=>k+"="+a.raw).join(" ; ").slice(0,220));
}
