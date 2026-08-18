/**
 * AI layer — single point of contact with the Lovable AI Gateway.
 * Swapping or adding models happens here, never in feature code.
 */
const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

export const MODELS = {
  /** Fast structured reasoning: request parsing, relevance scoring. */
  fast: "google/gemini-3.6-flash",
  /** Deeper synthesis: weekly intelligence, deep research. */
  deep: "google/gemini-2.5-pro",
} as const;

export class AiGatewayError extends Error {
  status: number;
  retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
}

export async function chatJson<T>(opts: {
  model?: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  /** Optional image URLs sent alongside the text prompt (vision input). */
  images?: string[];
}): Promise<T> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new AiGatewayError(401, "AI is not configured (missing LOVABLE_API_KEY).");

  const userContent: string | ContentBlock[] =
    opts.images && opts.images.length > 0
      ? [
          { type: "text" as const, text: opts.user },
          ...opts.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ]
      : opts.user;

  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: userContent },
  ];


  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? MODELS.fast,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      message = parsed.error?.message ?? parsed.message ?? text;
    } catch {
      /* keep raw text */
    }
    if (response.status === 402) {
      message = message || "AI credits exhausted. Add credits to continue monitoring.";
    }
    if (response.status === 429) {
      message = message || "AI rate limit reached. Monitoring will retry on the next run.";
    }
    throw new AiGatewayError(response.status, message);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new AiGatewayError(502, "Empty response from AI model.");
  return JSON.parse(content) as T;
}
