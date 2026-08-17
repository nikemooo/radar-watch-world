import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Turn a natural-language request into a structured monitoring configuration. */
export const interpretRadarRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { request: string }) => {
    if (!input?.request || input.request.trim().length < 8) {
      throw new Error("Describe what you want Radar to monitor (at least a sentence).");
    }
    return { request: input.request.trim().slice(0, 2000) };
  })
  .handler(async ({ data }) => {
    const { interpretRequest } = await import("./ai/interpret.server");
    return interpretRequest(data.request);
  });

/** Run one monitoring cycle for a radar the caller owns. */
export const runRadarNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { radarId: string }) => {
    if (!input?.radarId) throw new Error("Missing radar id.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { runRadarCycle } = await import("./monitoring/engine.server");
    const { data: radar, error } = await context.supabase
      .from("radars")
      .select("*")
      .eq("id", data.radarId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!radar) throw new Error("Radar not found.");
    return runRadarCycle(context.supabase, radar);
  });

/** Which research providers are wired up (nothing is faked when none are). */
export const getResearchStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { providerStatus } = await import("./search/providers.server");
    return { providers: providerStatus() };
  });

/** Build a daily or weekly intelligence report from real stored alerts. */
export const buildIntelligenceReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { kind: "daily" | "weekly" }) => ({
    kind: input?.kind === "weekly" ? ("weekly" as const) : ("daily" as const),
  }))
  .handler(async ({ data, context }) => {
    const { generateReport } = await import("./intelligence/report.server");
    return generateReport(context.supabase, context.userId, data.kind);
  });
