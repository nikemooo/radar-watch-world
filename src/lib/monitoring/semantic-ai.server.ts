/**
 * AI reading of a listing's own description, for criteria that word lists
 * cannot settle.
 *
 * This runs ONLY after the deterministic reader (semantic.ts) has been given
 * the page, and ONLY for the phrases it left as unknown/probable. The model is
 * never allowed to invent evidence: every verdict must quote a snippet that
 * appears verbatim in the text we sent, otherwise the verdict is discarded and
 * the criterion stays exactly as the deterministic reader left it.
 *
 * It is category-agnostic — the prompt talks about "the listing" and "the
 * requirement", never about apartments, cars or watches.
 */
import { chatJson, MODELS } from "../ai/gateway.server";
import { fold, type SemanticSurface, type SemanticVerdict } from "./semantic";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phrase", "status", "quote", "explanation"],
        properties: {
          phrase: { type: "string" },
          status: { type: "string", enum: ["confirmed", "probable", "contradicted", "unknown"] },
          quote: { type: "string" },
          explanation: { type: "string" },
        },
      },
    },
  },
} as const;

const SYSTEM = [
  "You verify requirements against the text of ONE listing.",
  "You read meaning, not keywords: a formulation that means the same thing counts as stated.",
  "Rules you must never break:",
  '- "confirmed" only when the listing itself states the property, in any wording.',
  '- "probable" when the text only suggests something adjacent (e.g. proximity to water is NOT a water view; a shared terrace is NOT a private balcony).',
  '- "contradicted" when the listing states the opposite, or states a different variant of the same property (e.g. a view of the courtyard when a sea view is required).',
  '- "unknown" when the listing simply does not address it.',
  "- quote must be copied CHARACTER FOR CHARACTER from the listing text provided. Never paraphrase, never translate, never invent. If you have no exact quote, use status unknown with an empty quote.",
  "- Answer in the language of the listing for the quote; keep the explanation short and factual.",
].join("\n");

export interface AiSemanticInput {
  url: string;
  /** Phrases the deterministic reader could not settle. */
  phrases: string[];
  /** Every surface read from the item's own page, description first. */
  surfaces: SemanticSurface[];
}

function corpus(surfaces: SemanticSurface[]): string {
  return surfaces
    .filter((s) => s.text.trim().length > 0)
    .map((s) => `[${s.kind}]\n${s.text.slice(0, 6000)}`)
    .join("\n\n")
    .slice(0, 14000);
}

/** Loose verbatim check: ignores case, accents and whitespace runs. */
function quotedVerbatim(quote: string, haystack: string): boolean {
  const q = fold(quote).replace(/\s+/g, " ").trim();
  if (q.length < 8) return false;
  return fold(haystack).replace(/\s+/g, " ").includes(q);
}

/**
 * Read the listing with a model and return one verdict per phrase it could
 * actually evidence. Phrases without a usable, verbatim-checked answer are
 * simply omitted, so the caller keeps its deterministic verdict.
 */
export async function readCriteriaWithAi(input: AiSemanticInput): Promise<SemanticVerdict[]> {
  const text = corpus(input.surfaces);
  if (!text || input.phrases.length === 0) return [];

  const result = await chatJson<{
    verdicts: { phrase: string; status: "confirmed" | "probable" | "contradicted" | "unknown"; quote: string; explanation: string }[];
  }>({
    model: MODELS.fast,
    system: SYSTEM,
    schemaName: "criteria_verdicts",
    schema,
    user: [
      `Listing URL: ${input.url}`,
      "",
      "Requirements to judge (one verdict each):",
      ...input.phrases.map((p) => `- ${p}`),
      "",
      "Listing content:",
      text,
    ].join("\n"),
  });

  const wanted = new Map(input.phrases.map((p) => [fold(p.trim()), p]));
  const out: SemanticVerdict[] = [];
  const seen = new Set<string>();
  const descriptionSurface = input.surfaces.find((s) => s.kind === "description") ?? input.surfaces[0];

  for (const v of result.verdicts ?? []) {
    const key = fold(String(v.phrase ?? "").trim());
    const phrase = wanted.get(key);
    if (!phrase || seen.has(key)) continue;
    if (v.status === "unknown") continue;
    const quote = String(v.quote ?? "").trim();
    // Anti-hallucination: an unquotable verdict is not evidence.
    if (!quotedVerbatim(quote, text)) continue;
    seen.add(key);
    const source = input.surfaces.find((s) => quotedVerbatim(quote, s.text)) ?? descriptionSurface;
    out.push({
      phrase,
      status: v.status,
      confidence: v.status === "confirmed" ? 0.85 : v.status === "contradicted" ? 0.8 : 0.5,
      matched: quote.slice(0, 120),
      snippet: quote.slice(0, 300),
      source_url: source?.url ?? input.url,
      source_kind: source?.kind ?? "description",
      reason: String(v.explanation ?? "").slice(0, 300) || `read from the listing text: "${quote.slice(0, 120)}"`,
      method: "ai",
    });
  }
  return out;
}
