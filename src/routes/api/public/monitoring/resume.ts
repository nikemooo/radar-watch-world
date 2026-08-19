/**
 * Generic continuation endpoint.
 *
 * A sweep is long-running work in a runtime that does not guarantee background
 * execution, so it is built to be resumable: every expensive step is
 * checkpointed and a quiet run can be picked up again from where it stopped,
 * without paying any provider twice. This endpoint lets an external scheduler
 * (or an operator) drive those continuations for every radar, so recovery does
 * not depend on a user having a radar page open.
 *
 * It only touches runs that are genuinely quiet and still resumable — a live,
 * heartbeating sweep is never disturbed, and no history is ever deleted.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/monitoring/resume")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["MONITORING_REAP_SECRET"];
        if (secret) {
          const provided =
            request.headers.get("x-reap-secret") ??
            request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
            "";
          if (provided !== secret) return new Response("Unauthorized", { status: 401 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { resumeInterruptedRuns } = await import("@/lib/monitoring/continuation.server");
        const { reapStaleRuns } = await import("@/lib/monitoring/reaper.server");

        const resumed = await resumeInterruptedRuns(supabaseAdmin);
        // Whatever could not be resumed any more is closed honestly as failed.
        const reaped = await reapStaleRuns(supabaseAdmin);
        return Response.json({
          resumed: resumed.length,
          runs: resumed,
          reaped: reaped.length,
        });
      },
    },
  },
});
