import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { chatJson, MODELS } from "../ai/gateway.server";

type Db = SupabaseClient<Database>;

export interface ReportContent {
  headline: string;
  narrative: string;
  counts: { critical: number; important: number; interesting: number; minor: number };
  items: {
    title: string;
    what_happened: string;
    why_it_matters: string;
    what_changed: string;
    importance: string;
    sources: { title: string; url: string }[];
  }[];
  trends: string[];
  fading: string[];
}

const reportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "narrative", "trends", "fading"],
  properties: {
    headline: { type: "string" },
    narrative: { type: "string" },
    trends: { type: "array", items: { type: "string" } },
    fading: { type: "array", items: { type: "string" } },
  },
} as const;

export async function generateReport(db: Db, userId: string, kind: "daily" | "weekly") {
  const days = kind === "weekly" ? 7 : 1;
  const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const periodEnd = new Date();

  const { data: alerts, error } = await db
    .from("alerts")
    .select("*, radars(name)")
    .gte("created_at", periodStart.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const rows = alerts ?? [];
  const counts = {
    critical: rows.filter((a) => a.importance === "critical").length,
    important: rows.filter((a) => a.importance === "important").length,
    interesting: rows.filter((a) => a.importance === "interesting").length,
    minor: rows.filter((a) => a.importance === "minor").length,
  };

  let headline = rows.length
    ? `Your world changed ${rows.length} ${rows.length === 1 ? "time" : "times"}.`
    : "No meaningful changes in this period.";
  let narrative =
    rows.length === 0
      ? "Radar monitored your interests and found nothing that met your relevance threshold."
      : "";
  let trends: string[] = [];
  let fading: string[] = [];

  if (rows.length > 0) {
    const synthesis = await chatJson<{
      headline: string;
      narrative: string;
      trends: string[];
      fading: string[];
    }>({
      model: kind === "weekly" ? MODELS.deep : MODELS.fast,
      schemaName: "intelligence_report",
      schema: reportSchema,
      system:
        "You write a concise personal intelligence briefing. Use only the supplied alerts; never invent facts or sources. " +
        "Be direct, analytical and calm — Bloomberg terminal, not marketing copy. " +
        (kind === "weekly"
          ? "Identify trends, repeated signals, new opportunities and topics that became less relevant."
          : "Summarise what happened and what changed since the previous report."),
      user: rows
        .map(
          (a) =>
            `[${a.importance}] ${a.title} (radar: ${(a as { radars?: { name?: string } }).radars?.name ?? "unknown"})\nsummary: ${a.summary}\nwhy: ${a.why_it_matters ?? ""}\nchanged: ${a.what_changed ?? ""}`,
        )
        .join("\n\n"),
    });
    headline = synthesis.headline;
    narrative = synthesis.narrative;
    trends = synthesis.trends;
    fading = synthesis.fading;
  }

  const content: ReportContent = {
    headline,
    narrative,
    counts,
    trends,
    fading,
    items: rows.slice(0, 25).map((a) => ({
      title: a.title,
      what_happened: a.summary,
      why_it_matters: a.why_it_matters ?? "",
      what_changed: a.what_changed ?? "",
      importance: a.importance,
      sources: Array.isArray(a.sources) ? (a.sources as unknown as { title: string; url: string }[]) : [],
    })),
  };

  const { data: saved, error: saveError } = await db
    .from("reports")
    .insert({
      user_id: userId,
      kind,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      content: content as never,
    })
    .select()
    .single();
  if (saveError) throw new Error(saveError.message);

  return { id: saved.id, kind, content };
}
