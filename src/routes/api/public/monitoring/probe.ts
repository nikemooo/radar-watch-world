/** TEMPORARY diagnostic route — background-worker survival probe. */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/monitoring/probe")({
  server: {
    handlers: {
      GET: async () => {
        const { keepRuntimeAlive } = await import("@/lib/runtime-context.server");
        const started = Date.now();
        const task = (async () => {
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            console.info(`[probe] tick ${i} at +${Date.now() - started}ms`);
          }
        })();
        const attached = keepRuntimeAlive(task);
        await new Promise((r) => setTimeout(r, 3000));
        return Response.json({ attached });
      },
    },
  },
});
