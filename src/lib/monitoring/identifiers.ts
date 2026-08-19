/**
 * Generic identifier detection — pure and category-agnostic.
 *
 * Some categories publish a unique identifier for the exact physical item:
 * a VIN for a car, a reference + serial for a watch, an EAN/GTIN for a
 * product, a registration number for a property or vehicle. When one exists it
 * is by far the strongest identity signal available: the same identifier on
 * two pages means the same item, even when the wording, price and photos
 * differ.
 *
 * This module never guesses a category. It looks for identifier SHAPES and for
 * the labels that introduce them, and reports what it found with provenance.
 */

export type IdentifierType = "vin" | "registration" | "gtin" | "isbn" | "reference" | "serial" | "sku";

export interface Identifier {
  type: IdentifierType;
  value: string;
  /** Labelled identifiers are trustworthy; shape-only matches are weaker. */
  confidence: "labelled" | "shape";
  sourceUrl: string | null;
}

/** VIN: 17 characters, never I, O or Q. */
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/gi;
/** Swedish/European style plate: ABC123, ABC12A, AB-12-CD. */
const PLATE_RE = /\b[A-Z]{3}\s?[0-9]{2}[0-9A-Z]\b/g;
const GTIN_RE = /\b\d{8}|\b\d{12,14}\b/g;
const ISBN_RE = /\b97[89][\d-]{10,14}\b/g;

const LABELS: { type: IdentifierType; labels: string[] }[] = [
  { type: "vin", labels: ["vin", "chassinummer", "chassis number", "fahrgestellnummer"] },
  { type: "registration", labels: ["registreringsnummer", "reg.nr", "regnr", "registration number", "license plate"] },
  { type: "reference", labels: ["referens", "reference", "ref", "ref.", "referensnummer", "model reference"] },
  { type: "serial", labels: ["serienummer", "serial", "serial number", "serienr"] },
  { type: "sku", labels: ["artikelnummer", "sku", "mpn", "art.nr", "item number", "productid", "product id"] },
  { type: "gtin", labels: ["gtin", "ean", "upc", "gtin13", "gtin8"] },
  { type: "isbn", labels: ["isbn"] },
];

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 40);
}

function validVin(value: string): boolean {
  const v = value.toUpperCase();
  return v.length === 17 && !/[IOQ]/.test(v) && /\d/.test(v) && /[A-Z]/.test(v);
}

/**
 * Find identifiers in one retrieved surface. Labelled hits are preferred; a
 * bare shape match is only reported for VIN and ISBN, which are unambiguous
 * enough that a false positive is unlikely.
 */
export function detectIdentifiers(input: {
  url: string | null;
  text?: string;
  fields?: Record<string, string>;
}): Identifier[] {
  const found = new Map<string, Identifier>();
  const add = (id: Identifier) => {
    const key = `${id.type}:${id.value.toLowerCase()}`;
    const current = found.get(key);
    if (!current || (current.confidence === "shape" && id.confidence === "labelled")) found.set(key, id);
  };

  // 1. Labelled values from structured fields — the reliable path.
  for (const [rawKey, rawValue] of Object.entries(input.fields ?? {})) {
    const key = rawKey.toLowerCase();
    const value = clean(rawValue);
    if (!value || value.length < 4 || !/\d/.test(value)) continue;
    for (const { type, labels } of LABELS) {
      if (!labels.some((l) => key === l || key.includes(l))) continue;
      if (type === "vin" && !validVin(value.replace(/\s/g, ""))) continue;
      add({ type, value, confidence: "labelled", sourceUrl: input.url });
    }
  }

  const text = input.text ?? "";
  if (text) {
    // 2. Labelled values written in prose ("Chassinummer: WBA8E9...").
    for (const { type, labels } of LABELS) {
      for (const label of labels) {
        // The label must stand on its own word boundary, be followed by a real
        // separator, and introduce a value that carries at least one digit —
        // otherwise page scripts ("indexOf", "reference:") become identifiers.
        const re = new RegExp(
          `(?:^|[^\\p{L}\\p{N}])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:#]\\s*([A-Z0-9][A-Z0-9 \\-/]{3,30})`,
          "iu",
        );
        const m = text.match(re);
        const value = m?.[1] ? clean(m[1]) : null;
        if (!value) continue;
        if (!/\d/.test(value)) continue;
        if (type === "vin" && !validVin(value.replace(/[\s-]/g, ""))) continue;
        add({ type, value, confidence: "labelled", sourceUrl: input.url });
        break;
      }
    }

    // 3. Unambiguous shapes.
    for (const m of text.matchAll(VIN_RE)) {
      if (validVin(m[0])) add({ type: "vin", value: m[0].toUpperCase(), confidence: "shape", sourceUrl: input.url });
    }
    for (const m of text.matchAll(ISBN_RE)) {
      add({ type: "isbn", value: m[0], confidence: "shape", sourceUrl: input.url });
    }
  }

  return Array.from(found.values()).slice(0, 8);
}

/** Merge identifiers found across several surfaces of the same item. */
export function mergeIdentifiers(lists: Identifier[][]): Identifier[] {
  const merged = new Map<string, Identifier>();
  for (const list of lists) {
    for (const id of list) {
      const key = `${id.type}:${id.value.toLowerCase()}`;
      const current = merged.get(key);
      if (!current || (current.confidence === "shape" && id.confidence === "labelled")) merged.set(key, id);
    }
  }
  return Array.from(merged.values()).slice(0, 8);
}

/** True when two items provably describe the SAME physical thing. */
export function sameItem(a: Identifier[], b: Identifier[]): boolean {
  const strong: IdentifierType[] = ["vin", "registration", "serial", "isbn", "gtin"];
  return a.some(
    (x) => strong.includes(x.type) && b.some((y) => y.type === x.type && y.value.toLowerCase() === x.value.toLowerCase()),
  );
}

/** Unused shapes are noise: only report identifiers the page actually labels. */
export function presentableIdentifiers(ids: Identifier[]): Identifier[] {
  return ids.filter((i) => i.confidence === "labelled" || i.type === "vin");
}
