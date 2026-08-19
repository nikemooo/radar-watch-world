/**
 * ISOLATED PROOF-OF-CONCEPT endpoint — server-driven multi-step OpenAI Web Search loop.
 * Not used by the Radar monitoring engine.
 */
import { createFileRoute } from "@tanstack/react-router";
import { LOOP_TEST_PROMPT, runOpenAiSearchLoop } from "@/lib/search/openai-search-loop.server";

export const Route = createFileRoute("/api/test/openai-search-loop")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let prompt = LOOP_TEST_PROMPT;
        try {
          const body = (await request.json()) as { prompt?: unknown };
          if (typeof body.prompt === "string" && body.prompt.trim().length > 0) prompt = body.prompt.trim();
        } catch {
          /* default prompt */
        }
        if (prompt.length > 6000) {
          return Response.json({ ok: false, error: "Prompt too long (max 6000 chars)." }, { status: 400 });
        }
        try {
          const result = await runOpenAiSearchLoop(prompt, undefined, request.signal);
          return Response.json(result, { status: result.ok ? 200 : result.configured ? 502 : 503 });
        } catch (err) {
          if ((err as Error).name === "AbortError") return new Response("Client aborted", { status: 499 });
          return Response.json({ ok: false, configured: true, error: (err as Error).message }, { status: 500 });
        }
      },
    },
  },
});
