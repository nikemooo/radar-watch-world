/**
 * Generic evidence engine — pure, model-free, category-agnostic.
 *
 * The extraction layer answers "what does this page say?". This layer answers
 * the harder question the user actually asks: *how well do we know it, and
 * why?* Every attribute ends up with:
 *
 *   - the individual records that support it (one per retrieved surface)
 *   - a status: VERIFIED / PROBABLE / CONFLICTED / UNKNOWN
 *   - a confidence score, derived only from evidence strength and agreement
 *   - an explanation naming the sources it came from
 *
 * Rules (identical for cars, watches, property, anything else):
 *   - a record is only ever created from a value literally read from a source;
 *   - structured data (JSON-LD, spec fields, meta) outranks page prose, which
 *     outranks an index card, which outranks a search snippet;
 *   - two factual sources that disagree produce CONFLICTED — never a silent
 *     pick of the "nicer" value;
 *   - visual (image) evidence is real evidence but can never reach VERIFIED,
 *     because a photo shows an appearance, not a fact.
 */
import { enrichFromEvidence, type EvidenceDoc, type EvidenceSourceType } from "./enrichment";
import {
  attributeSignature,
  normalizeAttribute,
  type AttributeSpec,
  type AttributeValue,
} from "./normalize";

export type EvidenceStrength = "structured" | "stated" | "visual" | "inferred";

export type EvidenceStatus = "verified" | "probable" | "conflicted" | "unknown";

/** One reading of one attribute from one surface. */
export interface EvidenceRecord {
  attribute: string;
  /** Verbatim value as the source wrote it. */
  raw: string;
  /** Comparable form used to detect agreement / conflict. */
  signature: string;
  sourceType: EvidenceSourceType | "image";
  sourceUrl: string | null;
  strength: EvidenceStrength;
}

export interface AttributeEvidence {
  attribute: string;
  status: EvidenceStatus;
  /** 0–1, derived from source strength, agreement and contradiction. */
  confidence: number;
  /** The value the rest of the pipeline should use. Null when unknown. */
  value: AttributeValue | null;
  records: EvidenceRecord[];
  /** Distinct readings that disagree with the chosen value. */
  conflicts: EvidenceRecord[];
  /** One short, human-readable explanation of the status. */
  explanation: string;
}

const SOURCE_WEIGHT: Record<EvidenceRecord["sourceType"], number> = {
  jsonld: 1,
  detail_field: 0.95,
  opengraph: 0.8,
  meta: 0.8,
  detail_title: 0.7,
  detail_text: 0.65,
  index_card: 0.5,
  search_snippet: 0.35,
  image: 0.4,
};

const STRENGTH_WEIGHT: Record<EvidenceStrength, number> = {
  structured: 1,
  stated: 0.8,
  visual: 0.5,
  inferred: 0.3,
};

function strengthOf(sourceType: EvidenceSourceType, confidence: AttributeValue["confidence"]): EvidenceStrength {
  if (confidence === "structured") return "structured";
  if (confidence === "inferred") return "inferred";
  return "stated";
}

/** Values that compare equal for agreement purposes (case/space-insensitive). */
function signatureOf(value: AttributeValue): string {
  const sig = attributeSignature(value);
  return sig
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function factual(record: EvidenceRecord): boolean {
  return record.strength === "structured" || record.strength === "stated";
}

/**
 * Read every surface separately, so agreement between surfaces is observable
 * instead of being collapsed away by the "strongest source wins" merge.
 */
export function collectAttributeEvidence(
  specs: AttributeSpec[],
  docs: EvidenceDoc[],
): Record<string, AttributeEvidence> {
  const byAttribute = new Map<string, { records: EvidenceRecord[]; values: Map<string, AttributeValue> }>();
  for (const spec of specs) byAttribute.set(spec.key, { records: [], values: new Map() });

  for (const doc of docs) {
    const reading = enrichFromEvidence(specs, [doc]);
    for (const spec of specs) {
      const value = reading.attributes[spec.key];
      if (!value || value.confidence === "unknown" || !value.raw) continue;
      const bucket = byAttribute.get(spec.key)!;
      const signature = signatureOf(value);
      bucket.records.push({
        attribute: spec.key,
        raw: value.raw,
        signature,
        sourceType: doc.sourceType,
        sourceUrl: value.source_url,
        strength: strengthOf(doc.sourceType, value.confidence),
      });
      if (!bucket.values.has(signature)) bucket.values.set(signature, value);
    }
  }

  const out: Record<string, AttributeEvidence> = {};
  for (const spec of specs) {
    const bucket = byAttribute.get(spec.key)!;
    out[spec.key] = aggregateEvidence(spec, bucket.records, bucket.values);
  }
  return out;
}

/** Turn a set of records for ONE attribute into a status + confidence. */
export function aggregateEvidence(
  spec: AttributeSpec,
  records: EvidenceRecord[],
  values: Map<string, AttributeValue>,
): AttributeEvidence {
  if (records.length === 0) {
    return {
      attribute: spec.key,
      status: "unknown",
      confidence: 0,
      value: null,
      records: [],
      conflicts: [],
      explanation: `${spec.label} is not stated by any retrieved source`,
    };
  }

  // Score each distinct reading by the best evidence supporting it plus a
  // bonus for independent agreement across different surfaces.
  const groups = new Map<string, EvidenceRecord[]>();
  for (const r of records) {
    const list = groups.get(r.signature) ?? [];
    list.push(r);
    groups.set(r.signature, list);
  }

  const scored = Array.from(groups.entries()).map(([signature, group]) => {
    const best = Math.max(
      ...group.map((r) => STRENGTH_WEIGHT[r.strength] * SOURCE_WEIGHT[r.sourceType]),
    );
    const distinctSources = new Set(group.map((r) => r.sourceType)).size;
    return { signature, group, score: best + (distinctSources - 1) * 0.1 };
  });
  scored.sort((a, b) => b.score - a.score);

  const winner = scored[0]!;
  const chosen = values.get(winner.signature) ?? null;
  const conflicts = scored
    .slice(1)
    .filter((s) => s.group.some(factual) && winner.group.some(factual))
    .flatMap((s) => s.group);

  const hasStructured = winner.group.some((r) => r.strength === "structured");
  const agreeingSources = new Set(winner.group.filter(factual).map((r) => r.sourceType)).size;
  const onlyVisual = winner.group.every((r) => r.strength === "visual");

  let status: EvidenceStatus;
  if (conflicts.length > 0) status = "conflicted";
  else if (onlyVisual) status = "probable";
  else if (hasStructured || agreeingSources >= 2) status = "verified";
  else if (agreeingSources === 1) status = "probable";
  else status = "unknown";

  let confidence = Math.min(1, winner.score);
  if (status === "conflicted") confidence = Math.min(confidence, 0.45);
  if (status === "probable") confidence = Math.min(confidence, 0.75);

  const sources = Array.from(new Set(winner.group.map((r) => r.sourceType))).join(", ");
  const explanation =
    status === "conflicted"
      ? `sources disagree on ${spec.label}: "${winner.group[0]!.raw}" (${sources}) vs "${conflicts[0]!.raw}" (${conflicts[0]!.sourceType})`
      : status === "verified"
        ? `${spec.label} confirmed by ${sources}`
        : status === "probable"
          ? `${spec.label} read from ${sources} only — not independently confirmed`
          : `${spec.label} is not stated by any retrieved source`;

  return {
    attribute: spec.key,
    status,
    confidence: Number(confidence.toFixed(2)),
    value: status === "unknown" ? null : chosen,
    records,
    conflicts,
    explanation,
  };
}

/**
 * Fold image observations into an existing evidence map.
 * A photo can fill a gap (UNKNOWN -> PROBABLE) and can contradict a stated
 * value (-> CONFLICTED), but it can never make anything VERIFIED.
 */
export function applyVisualEvidence(
  evidence: Record<string, AttributeEvidence>,
  specs: AttributeSpec[],
  observations: { attribute: string; value: string | null; confidence: "high" | "low" | "none"; image_url: string }[],
): Record<string, AttributeEvidence> {
  const specByKey = new Map(specs.map((s) => [s.key, s]));
  const out: Record<string, AttributeEvidence> = { ...evidence };

  for (const observation of observations) {
    if (observation.confidence === "none" || !observation.value) continue;
    const spec = specByKey.get(observation.attribute);
    const current = out[observation.attribute];
    if (!spec || !current) continue;

    const value = normalizeAttribute(spec, observation.value, "inferred", observation.image_url);
    const record: EvidenceRecord = {
      attribute: spec.key,
      raw: observation.value,
      signature: signatureOf(value),
      sourceType: "image",
      sourceUrl: observation.image_url,
      strength: "visual",
    };
    const records = [...current.records, record];

    if (current.status === "unknown") {
      out[spec.key] = {
        ...current,
        status: "probable",
        confidence: observation.confidence === "high" ? 0.5 : 0.3,
        value,
        records,
        explanation: `${spec.label} not stated in text — read from the listing's own photo (${observation.confidence} confidence)`,
      };
      continue;
    }

    const agrees = current.records.some((r) => r.signature === record.signature);
    if (!agrees && current.records.some(factual)) {
      out[spec.key] = {
        ...current,
        status: "conflicted",
        confidence: Math.min(current.confidence, 0.45),
        records,
        conflicts: [...current.conflicts, record],
        explanation: `text states ${spec.label} "${current.value?.raw ?? "?"}" but the photo looks like "${observation.value}"`,
      };
      continue;
    }

    out[spec.key] = {
      ...current,
      confidence: Math.min(1, current.confidence + 0.05),
      records,
      explanation: `${current.explanation}; consistent with the listing's photo`,
    };
  }

  return out;
}

/** Compact form persisted on the finding — enough for the UI to explain itself. */
export interface StoredEvidence {
  attribute: string;
  status: EvidenceStatus;
  confidence: number;
  raw: string | null;
  explanation: string;
  sources: { type: string; url: string | null }[];
  conflict: string | null;
}

export function storableEvidence(evidence: Record<string, AttributeEvidence>): StoredEvidence[] {
  return Object.values(evidence).map((e) => ({
    attribute: e.attribute,
    status: e.status,
    confidence: e.confidence,
    raw: e.value?.raw ?? null,
    explanation: e.explanation,
    sources: Array.from(
      new Map(e.records.map((r) => [`${r.sourceType}|${r.sourceUrl}`, { type: r.sourceType, url: r.sourceUrl }])).values(),
    ).slice(0, 6),
    conflict: e.conflicts[0] ? `${e.conflicts[0].raw} (${e.conflicts[0].sourceType})` : null,
  }));
}

export function storedEvidenceOf(value: unknown): StoredEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is StoredEvidence =>
      !!e && typeof e === "object" && typeof (e as StoredEvidence).attribute === "string",
  );
}

/* ------------------------------------------------------------------ *
 * Price evidence — every category that can be bought needs a price.
 * ------------------------------------------------------------------ */

const PRICE_FIELD_KEYS = [
  "price",
  "lowprice",
  "highprice",
  "offers.price",
  "product:price:amount",
  "og:price:amount",
  "pricespecification",
  "amount",
];

const CURRENCY_FIELD_KEYS = ["pricecurrency", "currency", "product:price:currency", "og:price:currency"];

/**
 * Read a price out of structured metadata even when the prose never states
 * one — the common case on client-rendered marketplaces.
 */
export function structuredPrice(
  fields: Record<string, string>,
): { raw: string; currency: string | null } | null {
  const lower = new Map(Object.entries(fields).map(([k, v]) => [k.toLowerCase(), v]));
  let amount: string | null = null;
  for (const key of PRICE_FIELD_KEYS) {
    const value = lower.get(key);
    if (value && /\d/.test(value)) {
      amount = value.trim();
      break;
    }
  }
  if (!amount) return null;
  let currency: string | null = null;
  for (const key of CURRENCY_FIELD_KEYS) {
    const value = lower.get(key);
    if (value && /^[A-Za-z]{3}$/.test(value.trim())) {
      currency = value.trim().toUpperCase();
      break;
    }
  }
  return { raw: currency && !/[A-Za-z]/.test(amount) ? `${amount} ${currency}` : amount, currency };
}

/* ------------------------------------------------------------------ *
 * Image evidence — provenance for what the user sees
 * ------------------------------------------------------------------ */

export type ImageStatus = "from_listing" | "unavailable";

export interface ImageEvidence {
  status: ImageStatus;
  primary: string | null;
  images: string[];
  sourceUrl: string | null;
  /** How the imagery was located, for the "why does this look like this" panel. */
  method: "opengraph_or_gallery" | "none";
}

export function imageEvidence(input: {
  pageUrl: string;
  primary: string | null | undefined;
  images: (string | null | undefined)[];
  sourceUrl?: string | null;
}): ImageEvidence {
  const images = Array.from(
    new Set([input.primary, ...input.images].filter((i): i is string => typeof i === "string" && i.length > 0)),
  ).slice(0, 8);
  if (images.length === 0) {
    return { status: "unavailable", primary: null, images: [], sourceUrl: input.pageUrl, method: "none" };
  }
  return {
    status: "from_listing",
    primary: images[0]!,
    images,
    sourceUrl: input.sourceUrl ?? input.pageUrl,
    method: "opengraph_or_gallery",
  };
}
