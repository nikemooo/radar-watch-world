/**
 * Scheduler tick — the one server-driven entry point that keeps Radar alive.
 *
 * Called by cron (every minute). One tick does three bounded things:
 *
 *   1. resumes quiet-but-resumable runs from their checkpoints (nothing paid twice),
 *   2. closes runs that can no longer be resumed, so nothing stays "running" forever,
 *   3. starts radars whose scheduled or recurring time has arrived.
 *
 * No user needs the page open for any of this.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/monitoring/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => handleTick(request),
      GET: async ({ request }) => handleTick(request),
    },
  },
});

async function handleTick(request: Request): Promise<Response> {
  const secret = process.env["MONITORING_REAP_SECRET"];
  if (secret) {
    const provided =
      request.headers.get("x-reap-secret") ??
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      "";
    if (provided !== secret) return new Response("Unauthorized", { status: 401 });
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ resumeInterruptedRuns }, { reapStaleRuns }, { startDueRadars }] = await Promise.all([
    import("@/lib/monitoring/continuation.server"),
    import("@/lib/monitoring/reaper.server"),
    import("@/lib/monitoring/scheduler.server"),
  ]);

  const resumed = await resumeInterruptedRuns(supabaseAdmin, { limit: 10 });
  const reaped = await reapStaleRuns(supabaseAdmin);
  const started = await startDueRadars(supabaseAdmin, { limit: 5 });

  return Response.json({
    at: new Date().toISOString(),
    resumed: resumed.length,
    reaped: reaped.length,
    started: started.length,
    runs: { resumed, reaped: reaped.map((r) => r.runId), started },
  });
}
