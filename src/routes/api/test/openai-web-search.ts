/**
 * ISOLATED PROOF-OF-CONCEPT endpoint. Not used by the Radar monitoring engine.
 * POST { prompt: string } -> structured OpenAI web-search result + telemetry.
 */
import { createFileRoute } from "@tanstack/react-router";
import { ROLEX_TEST_PROMPT, runOpenAiWebSearchPoc } from "@/lib/search/openai-web-search.server";

export const Route = createFileRoute("/api/test/openai-web-search")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let prompt = ROLEX_TEST_PROMPT;
        try {
          const body = (await request.json()) as { prompt?: unknown };
          if (typeof body.prompt === "string" && body.prompt.trim().length > 0) {
            prompt = body.prompt.trim();
          }
        } catch {
          /* default prompt */
        }

        if (prompt.length > 6000) {
          return Response.json({ ok: false, error: "Prompt too long (max 6000 chars)." }, { status: 400 });
        }

        try {
          const result = await runOpenAiWebSearchPoc(prompt, request.signal);
          return Response.json(result, { status: result.ok ? 200 : result.configured ? 502 : 503 });
        } catch (err) {
          if ((err as Error).name === "AbortError") return new Response("Client aborted", { status: 499 });
          return Response.json(
            { ok: false, configured: true, error: (err as Error).message, result: null },
            { status: 500 },
          );
        }
      },
    },
  },
});
