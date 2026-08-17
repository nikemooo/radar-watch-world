/**
 * Generic attribute extraction.
 *
 * The engine has no per-category knowledge. Each radar's AI interpretation
 * declares WHICH attributes matter (make/model/year for a car radar,
 * brand/reference/condition for a watch radar, area/rooms for real estate) and
 * this layer extracts exactly those keys from fetched detail pages.
 *
 * Every value carries provenance:
 *   stated     — written in plain text on the page
 *   structured — from structured metadata (JSON-LD, spec table, meta tags)
 *   inferred   — deduced, NOT presentable as fact
 *   unknown    — not available
 */
import { chatJson, MODELS } from "../ai/gateway.server";
import type { FetchedPage } from "../search/detail-fetch.server";
import {
  normalizeAttribute,
  type AttributeConfidence,
  type AttributeSpec,
  type AttributeValue,
} from "./normalize";

export interface ExtractedDetail {
  url: string;
  title: string | null;
  attributes: Record<string, AttributeValue>;
  availability: string | null;
  extracted: number;
  missing: number;
}

const confidences: AttributeConfidence[] = ["stated", "structured", "inferred", "unknown"];

function detailSchema(keys: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["url", "title", "availability", "attributes"],
          properties: {
            url: { type: "string" },
            title: { type: ["string", "null"] },
            availability: { type: ["string", "null"] },
            attributes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["key", "raw", "confidence"],
                properties: {
                  key: { type: "string", enum: keys },
                  raw: { type: ["string", "null"] },
                  confidence: { type: "string", enum: confidences },
                },
              },
            },
          },
        },
      },
    },
  } as const;
}

/**
 * Read the radar's declared attributes from a batch of fetched detail pages.
 * Anything the page does not state stays `unknown` — nothing is filled in.
 */
export async function extractDetailAttributes(
  pages: FetchedPage[],
  specs: AttributeSpec[],
  context: string,
): Promise<{ details: ExtractedDetail[]; failures: { url: string; reason: string }[] }> {
  if (pages.length === 0 || specs.length === 0) return { details: [], failures: [] };

  const keys = specs.map((s) => s.key);
  const specList = specs.map((s) => `${s.key} (${s.label}, ${s.kind})`).join("\n");

  let raw: { items: { url: string; title: string | null; availability: string | null; attributes: { key: string; raw: string | null; confidence: AttributeConfidence }[] }[] };
  try {
    raw = await chatJson({
      model: MODELS.fast,
      schemaName: "radar_detail_attributes",
      schema: detailSchema(keys),
      system:
        "You read individual item pages and extract ONLY the requested attributes. " +
        "raw must be the value exactly as written on the page, including its currency symbol or unit ('€52,900', '42 000 km', '68 m²'). " +
        "Never convert, round, translate or reformat the value, and never merge values from different items. " +
        "confidence: 'structured' when the value comes from a specification table or structured metadata, " +
        "'stated' when written in the page text, 'inferred' when you deduced it rather than read it, " +
        "'unknown' when the page does not provide it — then raw must be null. " +
        "Never invent a value. Omitting a key is treated as unknown. " +
        "availability is the item's current status in the page's own words (for example 'available', 'sold', 'reserved', 'expired') or null.",
      user: `Attributes to extract:
${specList}

Radar context (do not filter on it, extract regardless):
${context}

Pages:
${pages
  .map((p) => `URL: ${p.url}\nTITLE: ${p.title ?? "(none)"}\nCONTENT:\n${p.text.slice(0, 5000)}`)
  .join("\n\n---\n\n")}`,
    });
  } catch (err) {
    return {
      details: [],
      failures: pages.map((p) => ({ url: p.url, reason: `attribute extraction failed: ${(err as Error).message}` })),
    };
  }

  const specByKey = new Map(specs.map((s) => [s.key, s]));
  const details: ExtractedDetail[] = [];
  for (const item of raw.items ?? []) {
    const page = pages.find((p) => p.url === item.url || p.final_url === item.url);
    if (!page) continue;
    const attributes: Record<string, AttributeValue> = {};
    let extracted = 0;
    for (const spec of specs) {
      const found = item.attributes.find((a) => a.key === spec.key);
      const value = normalizeAttribute(
        spec,
        found?.raw ?? null,
        found?.confidence ?? "unknown",
        page.url,
      );
      attributes[spec.key] = value;
      if (value.confidence !== "unknown") extracted += 1;
    }
    details.push({
      url: page.url,
      title: item.title ?? page.title,
      attributes,
      availability: item.availability ? item.availability.slice(0, 60) : null,
      extracted,
      missing: specs.length - extracted,
    });
  }

  const failures = pages
    .filter((p) => !details.some((d) => d.url === p.url))
    .map((p) => ({ url: p.url, reason: "no attributes returned for this page" }));

  return { details, failures };
}

/** Diff two attribute maps — the basis of per-attribute change events. */
export function diffAttributes(
  previous: Record<string, AttributeValue> | null,
  next: Record<string, AttributeValue>,
): { attribute: string; previous: AttributeValue | null; next: AttributeValue }[] {
  if (!previous) return [];
  const changes: { attribute: string; previous: AttributeValue | null; next: AttributeValue }[] = [];
  for (const [key, value] of Object.entries(next)) {
    const before = previous[key];
    if (!before) continue;
    if (value.confidence === "unknown" || before.confidence === "unknown") continue;
    const a = before.value !== null ? String(before.value) : (before.raw ?? "");
    const b = value.value !== null ? String(value.value) : (value.raw ?? "");
    if (a !== b) changes.push({ attribute: key, previous: before, next: value });
  }
  return changes;
}

export function asAttributeMap(value: unknown): Record<string, AttributeValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => !!v && typeof v === "object" && "confidence" in (v as object),
  );
  if (entries.length === 0) return null;
  return Object.fromEntries(entries) as Record<string, AttributeValue>;
}

/**
 * Backfill: radars created before the attribute layer existed have no
 * attribute_schema. Infer one generically from the radar's own request so no
 * category is special-cased and older radars still get item-level facts.
 */
export async function inferAttributeSchema(request: string): Promise<AttributeSpec[]> {
  const result = await chatJson<{ attributes: AttributeSpec[] }>({
    model: MODELS.fast,
    schemaName: "radar_attribute_schema",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["attributes"],
      properties: {
        attributes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "label", "kind"],
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              kind: {
                type: "string",
                enum: ["text", "number", "money", "distance", "area", "date", "year", "url"],
              },
            },
          },
        },
      },
    },
    system:
      "List 5-10 item-level attributes that matter for the described monitoring subject. " +
      "snake_case keys. kind: 'money' for prices, 'distance' for mileage/range, 'area' for size, " +
      "'year' for model/build years, 'date' for dates, 'number' for counts, 'url' for links, 'text' otherwise. " +
      "Always include a price attribute when the subject can be bought, and a listing_url attribute for marketplace subjects.",
    user: request,
  });
  return result.attributes ?? [];
}
