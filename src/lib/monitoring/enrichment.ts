/**
 * Deterministic enrichment — pure, model-free, category-agnostic.
 *
 * A candidate must never go straight from "URL found" to "unverified" just
 * because one AI text pass returned nothing. This module reads every piece of
 * evidence that was ALREADY retrieved (page text, title, meta/OpenGraph,
 * JSON-LD, index card, search snippet) and extracts what is literally written
 * there — no guessing, no inference, no fabrication.
 *
 * Anti-fabrication rules, enforced here:
 *  - a value is only produced when the string exists in a source;
 *  - every value carries source_url, source type and confidence;
 *  - free-body text can never confirm a token on its own — a token must appear
 *    in a title, a labelled field, or structured data;
 *  - merging never replaces stronger evidence with weaker evidence.
 */
import { moneyMatchesIn } from "../search/index-rows";
import { containsToken, type HardConstraint } from "./criteria";
import { normalizeAttribute, type AttributeSpec, type AttributeValue } from "./normalize";

export type EvidenceSourceType =
  | "jsonld"
  | "opengraph"
  | "meta"
  | "detail_field"
  | "detail_title"
  | "detail_text"
  | "index_card"
  | "search_snippet";

export interface EvidenceDoc {
  /** URL the evidence was read from. */
  url: string;
  sourceType: EvidenceSourceType;
  /** Page/card title, when this evidence carries one. */
  title?: string | null;
  /** Body text of the evidence. */
  text?: string;
  /** Label -> value pairs from structured data (JSON-LD, meta, spec tables). */
  fields?: Record<string, string>;
}

/** Structured signals lifted out of a served HTML document. */
export interface StructuredSignals {
  jsonld: Record<string, string>;
  og: Record<string, string>;
  meta: Record<string, string>;
  canonical: string | null;
  images: string[];
  /** "Label: value" pairs read from spec tables / definition lists. */
  fields: Record<string, string>;
}

/* ------------------------------------------------------------------ *
 * Structured HTML parsing
 * ------------------------------------------------------------------ */

function decode(text: string): string {
  return text
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function absolute(href: string, base: string): string | null {
  try {
    const u = new URL(href.replace(/&amp;/g, "&"), base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Flatten a JSON-LD graph into scalar leaf values keyed by their path tail. */
function flattenJsonLd(node: unknown, out: Record<string, string>, depth = 0): void {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) flattenJsonLd(child, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const k = key.replace(/^@/, "").toLowerCase();
    if (typeof value === "string" || typeof value === "number") {
      const v = String(value).trim();
      if (v && !out[k]) out[k] = v.slice(0, 300);
    } else {
      flattenJsonLd(value, out, depth + 1);
    }
  }
}

const IMAGE_EXT = /\.(jpe?g|png|webp|avif)(\?|$)/i;

/**
 * Read every structured signal a served HTML page exposes. Nothing here is
 * category-specific: it is the generic metadata layer of the modern web.
 */
export function parseStructured(html: string, pageUrl: string): StructuredSignals {
  const og: Record<string, string> = {};
  const meta: Record<string, string> = {};
  const jsonld: Record<string, string> = {};
  const fields: Record<string, string> = {};
  const images: string[] = [];

  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!name || !content) continue;
    const value = decode(content).slice(0, 500);
    if (!value) continue;
    if (name.startsWith("og:")) og[name.slice(3)] ??= value;
    else meta[name] ??= value;
  }

  for (const m of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      flattenJsonLd(JSON.parse(m[1]!.trim()), jsonld);
    } catch {
      /* malformed JSON-LD is ignored, never guessed at */
    }
  }

  const canonical = (() => {
    const href = html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i)?.[0]?.match(
      /href\s*=\s*["']([^"']+)["']/i,
    )?.[1];
    return href ? absolute(href, pageUrl) : null;
  })();

  // Images: OpenGraph, JSON-LD, then real <img> sources (incl. lazy attrs).
  const pushImage = (raw: string | undefined | null) => {
    if (!raw) return;
    const first = raw.split(/\s*,\s*/)[0]!.split(/\s+/)[0]!;
    const abs = absolute(first, pageUrl);
    if (!abs || images.includes(abs)) return;
    if (!IMAGE_EXT.test(abs) && !/image/i.test(abs)) return;
    images.push(abs);
  };
  pushImage(og["image"]);
  pushImage(og["image:secure_url"]);
  pushImage(meta["twitter:image"]);
  pushImage(jsonld["image"] ?? jsonld["contenturl"] ?? jsonld["thumbnailurl"]);
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src =
      tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bsrcset\s*=\s*["']([^"']+)["']/i)?.[1];
    pushImage(src);
    const alt = tag.match(/\balt\s*=\s*["']([^"']+)["']/i)?.[1];
    if (alt) {
      const text = decode(alt);
      if (text.length > 3 && !fields["image_alt"]) fields["image_alt"] = text.slice(0, 300);
    }
    if (images.length >= 12) break;
  }

  // Specification tables and definition lists: "Label: value" pairs.
  for (const m of html.matchAll(/<t[dh]\b[^>]*>([\s\S]{0,200}?)<\/t[dh]>\s*<t[dh]\b[^>]*>([\s\S]{0,200}?)<\/t[dh]>/gi)) {
    const label = decode(m[1]!.replace(/<[^>]+>/g, " "));
    const value = decode(m[2]!.replace(/<[^>]+>/g, " "));
    if (label && value && label.length < 60 && value.length < 120) fields[label.toLowerCase()] ??= value;
  }
  for (const m of html.matchAll(/<dt\b[^>]*>([\s\S]{0,200}?)<\/dt>\s*<dd\b[^>]*>([\s\S]{0,200}?)<\/dd>/gi)) {
    const label = decode(m[1]!.replace(/<[^>]+>/g, " "));
    const value = decode(m[2]!.replace(/<[^>]+>/g, " "));
    if (label && value && label.length < 60 && value.length < 120) fields[label.toLowerCase()] ??= value;
  }

  return { jsonld, og, meta, canonical, images: images.slice(0, 12), fields };
}

/* ------------------------------------------------------------------ *
 * Label vocabulary
 * ------------------------------------------------------------------ */

/**
 * Multilingual label synonyms. This is vocabulary, not category logic: it only
 * tells the parser which words on a page introduce which attribute key.
 */
const LABEL_SYNONYMS: Record<string, string[]> = {
  price: ["pris", "price", "begärt pris", "utpris", "asking price", "preis", "prix"],
  model: ["modell", "model", "variant", "utförande", "version", "typ"],
  make: ["märke", "make", "brand", "fabrikat", "tillverkare", "manufacturer"],
  variant: ["variant", "utförande", "version", "trim"],
  year: ["årsmodell", "årsmodel", "modellår", "år", "year", "model year", "byggår", "tillverkningsår"],
  model_year: ["årsmodell", "modellår", "model year", "år"],
  registration_year: ["registreringsår", "i trafik", "första registrering", "first registration", "reg. år"],
  mileage: ["miltal", "mätarställning", "mileage", "körsträcka", "odometer", "km"],
  color: ["färg", "colour", "color", "kulör", "exteriörfärg", "exterior colour", "exterior color", "lack"],
  exterior_color: ["färg", "kulör", "exteriörfärg", "exterior colour", "exterior color", "lack"],
  interior_color: ["inredning", "interiör", "interior", "klädsel", "upholstery"],
  fuel: ["bränsle", "drivmedel", "fuel", "fuel type", "kraftkälla"],
  transmission: ["växellåda", "transmission", "gearbox", "växel"],
  drivetrain: ["drivning", "drivhjul", "drive", "drivetrain", "fyrhjulsdrift", "awd", "4wd"],
  horsepower: ["hästkrafter", "effekt", "hk", "horsepower", "power", "bhp"],
  body_style: ["karosseri", "biltyp", "kaross", "body", "body style", "body type"],
  location: ["ort", "plats", "location", "stad", "region", "kommun"],
  seller: ["säljare", "seller", "handlare", "dealer", "företag"],
  condition: ["skick", "condition", "status"],
  area: ["boarea", "yta", "storlek", "area", "size", "kvm"],
  rooms: ["rum", "antal rum", "rooms"],
};

function labelVariants(spec: AttributeSpec): string[] {
  const fromKey = spec.key.split(/[_\s]+/).filter(Boolean);
  const variants = new Set<string>([
    spec.key.replace(/_/g, " "),
    spec.label.toLowerCase(),
    ...(LABEL_SYNONYMS[spec.key] ?? []),
    ...fromKey.flatMap((part) => LABEL_SYNONYMS[part] ?? []),
  ]);
  return Array.from(variants).filter((v) => v.length >= 2);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Årsmodell: 2022" / "Färg – Svart" / "Miltal 6 000 mil" anywhere in text. */
function labelledValueIn(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(`(?:^|[^\\p{L}])${escapeRe(label)}\\s*[:：\\-–—]?\\s*([^\\n|·•;]{1,60})`, "iu");
    const m = text.match(re);
    const value = m?.[1]?.trim();
    if (value && /[\p{L}\p{N}]/u.test(value)) return value.replace(/\s{2,}.*$/, "").trim().slice(0, 120);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Kind-specific deterministic readers
 * ------------------------------------------------------------------ */

const CURRENT_YEAR = new Date().getUTCFullYear();

/** Unqualified money strings only — leasing/VAT/previous prices are skipped. */
export function readMoney(text: string): string | null {
  const matches = moneyMatchesIn(text).filter((m) => !m.qualified);
  if (matches.length === 0) return null;
  const distinct = Array.from(new Set(matches.map((m) => m.raw)));
  if (distinct.length !== 1) return null;
  return distinct[0]!;
}

/** A 4-digit year that a page states as a model/build year. */
export function readYear(text: string, labels: string[]): string | null {
  const labelled = labelledValueIn(text, labels);
  const fromLabel = labelled?.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  if (fromLabel && Number(fromLabel) <= CURRENT_YEAR + 1) return fromLabel;
  const inline = text.match(/\b(?:årsmodell|modellår|årsm\.?|model year|year)\D{0,6}(19\d{2}|20\d{2})\b/i)?.[1];
  if (inline && Number(inline) <= CURRENT_YEAR + 1) return inline;
  return null;
}

/** A distance written with its unit ("6 000 mil", "45 000 km", "12,000 miles"). */
export function readDistance(text: string, labels: string[]): string | null {
  const labelled = labelledValueIn(text, labels);
  if (labelled && /\d/.test(labelled)) return labelled;
  const m = text.match(/\b\d[\d\s.,']{1,9}\s?(km|mil|miles|mi)\b/i);
  return m ? m[0].trim() : null;
}

/* ------------------------------------------------------------------ *
 * Evidence collection and merging
 * ------------------------------------------------------------------ */

const CONFIDENCE_RANK: Record<AttributeValue["confidence"], number> = {
  structured: 3,
  stated: 2,
  inferred: 1,
  unknown: 0,
};

const SOURCE_RANK: Record<EvidenceSourceType, number> = {
  jsonld: 6,
  detail_field: 5,
  opengraph: 4,
  meta: 4,
  detail_title: 3,
  detail_text: 3,
  index_card: 2,
  search_snippet: 1,
};

export interface EvidenceCandidate {
  value: AttributeValue;
  sourceType: EvidenceSourceType;
}

/** Stronger evidence wins; equal strength keeps the value already held. */
export function strongerEvidence(a: EvidenceCandidate | null, b: EvidenceCandidate): EvidenceCandidate {
  if (!a) return b;
  const rankA = CONFIDENCE_RANK[a.value.confidence] * 10 + SOURCE_RANK[a.sourceType];
  const rankB = CONFIDENCE_RANK[b.value.confidence] * 10 + SOURCE_RANK[b.sourceType];
  return rankB > rankA ? b : a;
}

/**
 * Merge two attribute maps without ever downgrading a value. Used to combine
 * the deterministic pass with the AI pass and with previously stored data.
 */
export function mergeAttributeMaps(
  base: Record<string, AttributeValue>,
  incoming: Record<string, AttributeValue>,
): { merged: Record<string, AttributeValue>; merges: number } {
  const merged: Record<string, AttributeValue> = { ...base };
  let merges = 0;
  for (const [key, value] of Object.entries(incoming)) {
    const current = merged[key];
    if (!current) {
      merged[key] = value;
      if (value.confidence !== "unknown") merges += 1;
      continue;
    }
    if (CONFIDENCE_RANK[value.confidence] > CONFIDENCE_RANK[current.confidence]) {
      merged[key] = value;
      merges += 1;
    }
  }
  return { merged, merges };
}

export interface EnrichmentTelemetry {
  sourcesUsed: EvidenceSourceType[];
  attributesFound: number;
  attributesMissing: number;
  tokensConfirmed: number;
  mergeCount: number;
}

export interface EnrichmentResult {
  attributes: Record<string, AttributeValue>;
  telemetry: EnrichmentTelemetry;
}

function fieldValue(fields: Record<string, string> | undefined, labels: string[]): string | null {
  if (!fields) return null;
  for (const [key, value] of Object.entries(fields)) {
    const k = key.toLowerCase();
    if (labels.some((l) => k === l || k.includes(l))) {
      if (value && /[\p{L}\p{N}]/u.test(value)) return value.slice(0, 120);
    }
  }
  return null;
}

/**
 * Deterministic extraction over every collected evidence document.
 * Returns only values that are literally present in a source.
 */
export function enrichFromEvidence(
  specs: AttributeSpec[],
  evidence: EvidenceDoc[],
  constraints: HardConstraint[] = [],
): EnrichmentResult {
  const best = new Map<string, EvidenceCandidate>();
  const usedSources = new Set<EvidenceSourceType>();
  let merges = 0;

  const offer = (spec: AttributeSpec, raw: string | null, doc: EvidenceDoc, confidence: AttributeValue["confidence"]) => {
    if (!raw || !raw.trim()) return;
    const value = normalizeAttribute(spec, raw, confidence, doc.url);
    // A normalized numeric kind that produced no number is not usable evidence.
    if ((spec.kind === "money" || spec.kind === "year" || spec.kind === "number") && value.value === null) return;
    const before = best.get(spec.key) ?? null;
    const winner = strongerEvidence(before, { value, sourceType: doc.sourceType });
    if (winner !== before) {
      best.set(spec.key, winner);
      usedSources.add(doc.sourceType);
      merges += 1;
    }
  };

  for (const doc of evidence) {
    const text = [doc.title ?? "", doc.text ?? ""].filter(Boolean).join("\n");
    if (!text && !doc.fields) continue;
    const structural = doc.sourceType === "jsonld" || doc.sourceType === "detail_field" || doc.sourceType === "meta" || doc.sourceType === "opengraph";
    const confidence: AttributeValue["confidence"] = structural ? "structured" : "stated";

    for (const spec of specs) {
      const labels = labelVariants(spec);
      const structuredHit = fieldValue(doc.fields, labels);
      if (structuredHit) offer(spec, structuredHit, doc, "structured");

      if (!text) continue;
      switch (spec.kind) {
        case "money":
          offer(spec, labelledValueIn(text, labels) ?? readMoney(text), doc, confidence);
          break;
        case "year":
          offer(spec, readYear(text, labels), doc, confidence);
          break;
        case "distance":
          offer(spec, readDistance(text, labels), doc, confidence);
          break;
        case "url":
          offer(spec, doc.url, doc, "structured");
          break;
        default:
          offer(spec, labelledValueIn(text, labels), doc, confidence);
      }
    }
  }

  // Token confirmation: a required term counts as read only when it appears in
  // a title, a structured field or an index card headline — never from a
  // random sentence deep in the body text.
  let tokensConfirmed = 0;
  const specByKey = new Map(specs.map((s) => [s.key, s]));
  for (const constraint of constraints) {
    if (constraint.op !== "includes") continue;
    const spec = specByKey.get(constraint.attribute);
    if (!spec) continue;
    const existing = best.get(spec.key);
    if (existing && existing.value.confidence !== "unknown") continue;
    const tokens = [String(constraint.value), ...(constraint.aliases ?? [])].filter(Boolean);
    for (const doc of evidence) {
      const surfaces = [
        doc.title ?? "",
        ...Object.values(doc.fields ?? {}),
        doc.sourceType === "index_card" || doc.sourceType === "jsonld" ? (doc.text ?? "") : "",
      ].filter(Boolean);
      const hit = tokens.find((t) => surfaces.some((s) => containsToken(s, t)));
      if (!hit) continue;
      offer(spec, hit, doc, doc.sourceType === "jsonld" ? "structured" : "stated");
      tokensConfirmed += 1;
      break;
    }
  }

  const attributes: Record<string, AttributeValue> = {};
  let found = 0;
  for (const spec of specs) {
    const candidate = best.get(spec.key);
    attributes[spec.key] = candidate
      ? candidate.value
      : normalizeAttribute(spec, null, "unknown", null);
    if (candidate) found += 1;
  }

  return {
    attributes,
    telemetry: {
      sourcesUsed: Array.from(usedSources),
      attributesFound: found,
      attributesMissing: specs.length - found,
      tokensConfirmed,
      mergeCount: merges,
    },
  };
}

/** Attribute keys that still have no value — the only ones worth an AI call. */
export function missingKeys(specs: AttributeSpec[], attributes: Record<string, AttributeValue>): string[] {
  return specs.filter((s) => (attributes[s.key]?.confidence ?? "unknown") === "unknown").map((s) => s.key);
}

/** Human-readable reason a listing could not be fully verified. */
export function unverifiedReason(missing: string[], labels: Record<string, string>): string {
  if (missing.length === 0) return "";
  return `saknad information: ${missing.map((k) => labels[k] ?? k).join(", ")}`;
}
