/**
 * Generic listing understanding — pure, model-free, category-agnostic.
 *
 * Turns the surfaces Radar already retrieved (JSON-LD, OpenGraph, meta, spec
 * tables, title, page text) into a small set of GENERIC listing facts:
 *
 *   - what kind of thing is offered (item_type)
 *   - where it is (address, locality, region, postal code, country)
 *   - measurable quantities the page states (rooms, area, floor, size, …)
 *   - whether the offer is active, sold, reserved or upcoming
 *
 * No site-specific rules exist here. What IS encoded is vocabulary: which
 * words on a page introduce which fact, in the languages Radar supports. A
 * fact is only produced when it is literally written in a source, and it always
 * carries the layer it came from so the UI can explain itself.
 */

export type FactLayer = "jsonld" | "opengraph" | "meta" | "field" | "title" | "text";

export type FactConfidence = "structured" | "stated" | "inferred";

export interface ListingFact {
  key: string;
  /** Exactly what the source said. */
  raw: string;
  /** Parsed number when the fact is quantitative. */
  value: number | null;
  unit: string | null;
  layer: FactLayer;
  confidence: FactConfidence;
  source_url: string;
}

export type ListingStatus = "active" | "sold" | "reserved" | "upcoming" | "unknown";

export interface StatusEvidence {
  status: ListingStatus;
  /** The phrase that decided it, verbatim. */
  evidence: string | null;
  layer: FactLayer | null;
  confidence: FactConfidence | "unknown";
}

export interface LocationFacts {
  address: ListingFact | null;
  locality: ListingFact | null;
  region: ListingFact | null;
  postal_code: ListingFact | null;
  country: ListingFact | null;
}

export interface ListingExtraction {
  facts: Record<string, ListingFact>;
  location: LocationFacts;
  status: StatusEvidence;
  item_type: string | null;
}

export interface ListingSurfaces {
  url: string;
  title?: string | null | undefined;
  text?: string | undefined;
  jsonld?: Record<string, string> | undefined;
  og?: Record<string, string> | undefined;
  meta?: Record<string, string> | undefined;
  fields?: Record<string, string> | undefined;
}

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

interface MeasureSpec {
  key: string;
  labels: string[];
  /** Units accepted after the number; the first is the canonical one. */
  units?: string[];
  /** Allow a bare number when the label is unambiguous. */
  bareNumber?: boolean;
  max?: number;
}

const MEASURES: MeasureSpec[] = [
  { key: "rooms", labels: ["antal rum", "rum", "rooms", "number of rooms", "zimmer", "pièces"], units: ["rum", "rok", "rooms"], bareNumber: true, max: 40 },
  { key: "bedrooms", labels: ["sovrum", "bedrooms", "beds", "schlafzimmer"], bareNumber: true, max: 30 },
  { key: "bathrooms", labels: ["badrum", "bathrooms", "baths", "wc"], bareNumber: true, max: 20 },
  {
    key: "area",
    labels: ["boarea", "boyta", "bostadsyta", "yta", "living area", "area", "size", "storlek", "wohnfläche", "surface"],
    units: ["m²", "kvm", "m2", "sqm", "sq ft", "ft²"],
    max: 100000,
  },
  { key: "plot_area", labels: ["tomtarea", "tomt", "plot", "lot size", "grundstück"], units: ["m²", "kvm", "m2", "ha"], max: 10000000 },
  { key: "floor", labels: ["våning", "floor", "etage", "stock"], bareNumber: true, max: 200 },
  { key: "year_built", labels: ["byggår", "byggnadsår", "built", "year built", "baujahr"], bareNumber: true, max: 2100 },
  { key: "monthly_fee", labels: ["avgift", "månadsavgift", "hoa", "service charge", "fee"], units: ["kr", "sek", "eur", "€", "$"], max: 1000000 },
  { key: "operating_cost", labels: ["driftkostnad", "driftskostnad", "operating cost", "utilities"], units: ["kr", "sek", "eur"], max: 10000000 },
  { key: "mileage", labels: ["miltal", "mätarställning", "mileage", "körsträcka", "odometer"], units: ["mil", "km", "miles", "mi"], max: 5000000 },
  { key: "engine_power", labels: ["hästkrafter", "effekt", "horsepower", "power", "hk", "bhp", "kw"], units: ["hk", "hp", "bhp", "kw"], max: 5000 },
  { key: "capacity", labels: ["kapacitet", "capacity", "volym", "volume"], units: ["l", "ml", "gb", "tb", "kwh"], max: 1000000 },
];

/** Words that introduce an address-like fact. */
const LOCATION_LABELS: Record<keyof LocationFacts, string[]> = {
  address: ["adress", "gatuadress", "address", "street address", "streetaddress", "belägenhet"],
  locality: ["ort", "stad", "kommun", "område", "stadsdel", "locality", "city", "town", "addresslocality"],
  region: ["region", "län", "landskap", "state", "province", "addressregion", "county"],
  postal_code: ["postnummer", "postal code", "postcode", "zip", "postalcode"],
  country: ["land", "country", "addresscountry", "nation"],
};

/** Availability vocabulary. Order matters: the strongest signal wins. */
const STATUS_PATTERNS: { status: ListingStatus; re: RegExp }[] = [
  { status: "sold", re: /\b(sålt|såld|slutsåld|utgången annons|avslutad annons|sold\s?out|sold|no longer available|discontinued|expired|removed|out of stock|outofstock|soldout)\b/i },
  { status: "reserved", re: /\b(reserverad|bokad|budgivning pågår|under kontrakt|pending|reserved|under offer|sale pending|deposit taken)\b/i },
  { status: "upcoming", re: /\b(kommande|snart till salu|förhandsvisning|coming soon|pre[-\s]?order|preorder|upcoming|preview)\b/i },
  { status: "active", re: /\b(till salu|till försäljning|tillgänglig|i lager|aktiv annons|for sale|available|in stock|instock|forsale|active listing|open for bids)\b/i },
];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseNumber(raw: string): number | null {
  const cleaned = raw
    .replace(/[\s\u00a0']/g, "")
    .replace(/(\d)[.,](?=\d{3}\b)/g, "$1")
    .replace(",", ".");
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function labelledIn(text: string, labels: string[]): { raw: string; label: string } | null {
  for (const label of labels) {
    const re = new RegExp(`(?:^|[^\\p{L}])${escapeRe(label)}\\s*[:：\\-–—]?\\s*([^\\n|·•;]{1,80})`, "iu");
    const m = text.match(re);
    const raw = m?.[1]?.trim();
    if (raw && /[\p{L}\p{N}]/u.test(raw)) return { raw: raw.replace(/\s{2,}.*$/, "").slice(0, 120), label };
  }
  return null;
}

/** "3 rum", "72 m²", "1 250 000 kr" — value BEFORE its unit. */
function unitBefore(text: string, units: string[]): string | null {
  for (const unit of units) {
    const re = new RegExp(`(\\d[\\d\\s.,']{0,12})\\s?${escapeRe(unit)}(?![\\p{L}])`, "iu");
    const m = text.match(re);
    if (m) return `${m[1]!.trim()} ${unit}`;
  }
  return null;
}

function fieldLookup(
  fields: Record<string, string> | undefined,
  labels: string[],
): { key: string; value: string } | null {
  if (!fields) return null;
  for (const [key, value] of Object.entries(fields)) {
    const k = key.toLowerCase().replace(/[_\s-]+/g, " ").trim();
    if (!value || !/[\p{L}\p{N}]/u.test(value)) continue;
    if (labels.some((l) => k === l || k.endsWith(` ${l}`) || k.includes(l))) return { key, value: value.slice(0, 160) };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

function measureFrom(spec: MeasureSpec, surfaces: ListingSurfaces): ListingFact | null {
  const layers: { layer: FactLayer; confidence: FactConfidence; fields?: Record<string, string>; text?: string }[] = [
    { layer: "jsonld", confidence: "structured", fields: surfaces.jsonld },
    { layer: "field", confidence: "structured", fields: surfaces.fields },
    { layer: "opengraph", confidence: "stated", fields: surfaces.og },
    { layer: "meta", confidence: "stated", fields: surfaces.meta },
    { layer: "title", confidence: "stated", text: surfaces.title ?? "" },
    { layer: "text", confidence: "stated", text: (surfaces.text ?? "").slice(0, 12000) },
  ];

  for (const l of layers) {
    let raw: string | null = null;
    if (l.fields) raw = fieldLookup(l.fields, spec.labels)?.value ?? null;
    else if (l.text) {
      raw = labelledIn(l.text, spec.labels)?.raw ?? null;
      if (!raw && spec.units) raw = unitBefore(l.text, spec.units);
    }
    if (!raw) continue;
    const value = parseNumber(raw);
    if (value === null) continue;
    if (!spec.bareNumber && !spec.units) continue;
    if (spec.max !== undefined && Math.abs(value) > spec.max) continue;
    const unit = spec.units?.find((u) => new RegExp(escapeRe(u), "i").test(raw!)) ?? spec.units?.[0] ?? null;
    return {
      key: spec.key,
      raw,
      value,
      unit,
      layer: l.layer,
      confidence: l.confidence,
      source_url: surfaces.url,
    };
  }
  return null;
}

function locationFrom(key: keyof LocationFacts, surfaces: ListingSurfaces): ListingFact | null {
  const labels = LOCATION_LABELS[key];
  const structured =
    fieldLookup(surfaces.jsonld, labels) ??
    fieldLookup(surfaces.fields, labels) ??
    fieldLookup(surfaces.og, labels) ??
    fieldLookup(surfaces.meta, labels);
  if (structured) {
    return {
      key,
      raw: structured.value,
      value: key === "postal_code" ? parseNumber(structured.value) : null,
      unit: null,
      layer: surfaces.jsonld && structured.key in surfaces.jsonld ? "jsonld" : "field",
      confidence: "structured",
      source_url: surfaces.url,
    };
  }
  const text = `${surfaces.title ?? ""}\n${(surfaces.text ?? "").slice(0, 6000)}`;
  const labelled = labelledIn(text, labels);
  if (labelled) {
    return {
      key,
      raw: labelled.raw,
      value: null,
      unit: null,
      layer: "text",
      confidence: "stated",
      source_url: surfaces.url,
    };
  }
  return null;
}

function statusFrom(surfaces: ListingSurfaces): StatusEvidence {
  const structuredValue =
    fieldLookup(surfaces.jsonld, ["availability", "itemcondition", "offerstatus", "status"])?.value ??
    fieldLookup(surfaces.fields, ["status", "annonsstatus", "availability", "tillgänglighet"])?.value ??
    null;
  if (structuredValue) {
    for (const p of STATUS_PATTERNS) {
      if (p.re.test(structuredValue)) {
        return { status: p.status, evidence: structuredValue, layer: "jsonld", confidence: "structured" };
      }
    }
  }
  const head = `${surfaces.title ?? ""}\n${(surfaces.text ?? "").slice(0, 3000)}`;
  for (const p of STATUS_PATTERNS) {
    const m = head.match(p.re);
    if (m) {
      return { status: p.status, evidence: m[0], layer: surfaces.title && p.re.test(surfaces.title) ? "title" : "text", confidence: "stated" };
    }
  }
  return { status: "unknown", evidence: null, layer: null, confidence: "unknown" };
}

function itemTypeFrom(surfaces: ListingSurfaces): string | null {
  const raw =
    surfaces.jsonld?.["type"] ??
    fieldLookup(surfaces.jsonld, ["category", "producttype", "propertytype", "type"])?.value ??
    fieldLookup(surfaces.fields, ["bostadstyp", "objektstyp", "typ", "kategori", "property type", "type", "category"])?.value ??
    surfaces.og?.["type"] ??
    null;
  if (!raw) return null;
  const cleaned = raw.replace(/^https?:\/\/schema\.org\//i, "").trim();
  return cleaned && cleaned.toLowerCase() !== "website" && cleaned.toLowerCase() !== "article"
    ? cleaned.slice(0, 60)
    : null;
}

/** Read every generic listing fact this page states. Never guesses. */
export function extractListingFacts(surfaces: ListingSurfaces): ListingExtraction {
  const facts: Record<string, ListingFact> = {};
  for (const spec of MEASURES) {
    const fact = measureFrom(spec, surfaces);
    if (fact) facts[fact.key] = fact;
  }
  const location: LocationFacts = {
    address: locationFrom("address", surfaces),
    locality: locationFrom("locality", surfaces),
    region: locationFrom("region", surfaces),
    postal_code: locationFrom("postal_code", surfaces),
    country: locationFrom("country", surfaces),
  };
  for (const fact of Object.values(location)) if (fact) facts[fact.key] = fact;

  return { facts, location, status: statusFrom(surfaces), item_type: itemTypeFrom(surfaces) };
}

/* ------------------------------------------------------------------ *
 * Place verification
 * ------------------------------------------------------------------ */

export type PlaceStatus = "confirmed" | "probable" | "contradicted" | "unknown";

export interface PlaceVerdict {
  status: PlaceStatus;
  reason: string;
  matched: string | null;
  layer: FactLayer | null;
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function hasPhrase(haystack: string, phrase: string): boolean {
  const h = fold(haystack);
  const p = fold(phrase).trim();
  if (!p) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(p)}([^\\p{L}\\p{N}]|$)`, "u").test(h);
}

/**
 * Does this listing live in the place the user asked for?
 *
 * A structured address field naming the place CONFIRMS it. A mention anywhere
 * in the page body only makes it PROBABLE (marketing copy names neighbours and
 * nearby areas). A structured address that names a different locality without
 * mentioning the requested one CONTRADICTS it. Anything else is unknown —
 * never a pass.
 */
export function verifyPlace(
  wanted: string,
  extraction: ListingExtraction,
  pageText: string,
): PlaceVerdict {
  const place = wanted.trim();
  if (!place) return { status: "unknown", reason: "no place was requested", matched: null, layer: null };

  const addressFacts = [
    extraction.location.address,
    extraction.location.locality,
    extraction.location.region,
    extraction.location.country,
  ].filter((f): f is ListingFact => !!f);

  for (const fact of addressFacts) {
    if (hasPhrase(fact.raw, place)) {
      return {
        status: "confirmed",
        reason: `the listing's stated ${fact.key.replace(/_/g, " ")} is "${fact.raw}"`,
        matched: fact.raw,
        layer: fact.layer,
      };
    }
  }

  const locality = extraction.location.locality ?? extraction.location.address;
  if (locality && !hasPhrase(`${locality.raw} ${pageText.slice(0, 2000)}`, place)) {
    return {
      status: "contradicted",
      reason: `the listing states another location ("${locality.raw}") and never mentions ${place}`,
      matched: locality.raw,
      layer: locality.layer,
    };
  }

  if (hasPhrase(pageText, place)) {
    return {
      status: "probable",
      reason: `${place} is mentioned on the listing page but not in a stated address field`,
      matched: place,
      layer: "text",
    };
  }

  return { status: "unknown", reason: `the listing never states where it is`, matched: null, layer: null };
}
