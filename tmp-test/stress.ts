import { createClient } from "@supabase/supabase-js";
import { interpretRequest } from "../src/lib/ai/interpret.server";
import { runRadarCycle } from "../src/lib/monitoring/engine.server";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const { data: users } = await db.from("profiles").select("id").limit(1);
const userId = users![0]!.id;

const requests: [string, string][] = [
  ["CAR", "Find black BMW M340i cars from 2022 or newer in Sweden, maximum 600,000 SEK."],
  ["WATCH", "Find Rolex Submariner watches for sale in Europe under €12,000 that appear unusually attractive compared with comparable listings."],
  ["COMPANY", "Monitor NVIDIA for major developments that could materially affect the company, including earnings, products, regulation, major partnerships, competitors and significant news."],
  ["TRAVEL", "Monitor business-class flights from Stockholm to Dubai and identify unusually low fares."],
  ["REALESTATE", "Monitor Stockholm apartments below 5,000,000 SEK that appear significantly underpriced compared with comparable properties."],
];

for (const [label, req] of requests) {
  try {
    const interp = await interpretRequest(req);
    const { data: radar, error } = await db.from("radars").insert({
      user_id: userId,
      name: `[TEST ${label}] ${interp.name}`,
      raw_request: req,
      category: interp.category,
      config: interp.config as never,
      frequency: interp.suggested_frequency,
      status: "active",
    }).select("*").single();
    if (error) throw error;
    const result = await runRadarCycle(db as never, radar);
    const { data: srcs } = await db.from("research_sources").select("url").eq("radar_id", radar.id);
    const hosts = [...new Set((srcs ?? []).map((s) => new URL(s.url).hostname))];
    console.log(JSON.stringify({ label, radarId: radar.id, queries: interp.config.search_queries, result, hosts }, null, 1));
  } catch (e) {
    console.log(JSON.stringify({ label, FAILED: (e as Error).message }));
  }
}
