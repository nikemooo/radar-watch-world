/**
 * Generic recovery endpoint.
 *
 * Reaping must not depend on a user opening a radar page. An external
 * scheduler (or an operator) can call this to close every run whose worker has
 * gone quiet, across all radars. It only closes stale runs — a live,
 * heartbeating sweep is never touched — and it never deletes history.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/monitoring/reap")({
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
        const { reapStaleRuns } = await import("@/lib/monitoring/reaper.server");
        const reaped = await reapStaleRuns(supabaseAdmin);
        return Response.json({ reaped: reaped.length, runs: reaped });
      },
    },
  },
});
