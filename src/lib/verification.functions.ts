import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Re-verify a radar's already-stored findings against evidence already
 * retrieved. No discovery sweep, no new criteria — only better reading.
 */
export const reverifyRadar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { radarId: string; useImages?: boolean }) => {
    if (!input?.radarId) throw new Error("Missing radar id.");
    return { radarId: input.radarId, useImages: input.useImages === true };
  })
  .handler(async ({ data, context }) => {
    const { reverifyRadarFindings } = await import("./monitoring/reverify.server");
    const { data: radar, error } = await context.supabase
      .from("radars")
      .select("*")
      .eq("id", data.radarId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!radar) throw new Error("Radar not found.");
    return reverifyRadarFindings(context.supabase, radar, {
      useImages: data.useImages,
      imageBudget: 10,
    });
  });
