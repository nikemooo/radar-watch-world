/**
 * Unit and currency normalization — pure, category-agnostic, testable.
 *
 * Rule: the original source string is ALWAYS preserved. A normalized value is
 * only ever an *additional* field, never a replacement, and a currency is
 * never silently converted into another currency.
 */

export type AttributeConfidence = "stated" | "structured" | "inferred" | "unknown";

/** A single extracted attribute with provenance and normalization. */
export interface AttributeValue {
  /** Machine key from the radar's attribute spec, e.g. "price" or "mileage". */
  key: string;
  /** Verbatim string as it appears in the source, e.g. "€52,900". */
  raw: string | null;
  /** Normalized numeric value where the attribute is numeric. */
  value: number | null;
  /** ISO currency code for monetary attributes ("EUR"), else null. */
  currency: string | null;
  /** Canonical unit for measured attributes ("km", "m2"), else null. */
  unit: string | null;
  /** How well the source supports this value. */
  confidence: AttributeConfidence;
  /** The exact URL the value was read from. */
  source_url: string | null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  "€": "EUR",
  "$": "USD",
  "£": "GBP",
  "¥": "JPY",
  "kr": "SEK",
  "₹": "INR",
  "₣": "CHF",
};

const CURRENCY_CODES = [
  "SEK", "NOK", "DKK", "EUR", "USD", "GBP", "CHF", "JPY", "AED", "PLN", "CZK", "AUD", "CAD", "INR",
];

/** Best-effort ISO currency code from a raw price string. Null when unclear. */
export function detectCurrency(raw: string): string | null {
  const upper = raw.toUpperCase();
  for (const code of CURRENCY_CODES) {
    if (new RegExp(`\\b${code}\\b`).test(upper)) return code;
  }
  if (/\bKR\b|\bSEK\b|:-/.test(upper)) return "SEK";
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (raw.includes(symbol)) return code;
  }
  return null;
}

/**
 * Parse the first number out of a human-written amount.
 * Handles "52 900", "52,900", "52.900,00", "1.2M", "600 000 kr".
 */
export function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/\u00a0/g, " ").trim();
  const match = cleaned.match(/-?\d[\d\s.,']*\d|-?\d/);
  if (!match) return null;
  let token = match[0].replace(/[\s']/g, "");

  const lastComma = token.lastIndexOf(",");
  const lastDot = token.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // The right-most separator is the decimal separator.
    if (lastComma > lastDot) token = token.replace(/\./g, "").replace(",", ".");
    else token = token.replace(/,/g, "");
  } else if (lastComma > -1) {
    const decimals = token.length - lastComma - 1;
    token = decimals === 3 ? token.replace(/,/g, "") : token.replace(",", ".");
  } else if (lastDot > -1) {
    const decimals = token.length - lastDot - 1;
    if (decimals === 3) token = token.replace(/\./g, "");
  }

  let value = Number(token);
  if (!Number.isFinite(value)) return null;

  const suffix = cleaned.slice(cleaned.indexOf(match[0]) + match[0].length, cleaned.indexOf(match[0]) + match[0].length + 4).toLowerCase();
  if (/^\s*m\b/.test(suffix) || /^\s*mkr\b/.test(suffix)) value *= 1_000_000;
  else if (/^\s*k\b/.test(suffix)) value *= 1_000;
  return value;
}

/** Money: numeric amount plus currency, original string untouched. */
export function normalizeMoney(raw: string): { value: number | null; currency: string | null } {
  return { value: parseNumber(raw), currency: detectCurrency(raw) };
}

/** Distance normalized to kilometres (miles are converted, factor recorded by caller). */
export function normalizeDistance(raw: string): { value: number | null; unit: string | null } {
  const value = parseNumber(raw);
  if (value === null) return { value: null, unit: null };
  if (/\bmi(les?)?\b/i.test(raw)) return { value: Math.round(value * 1.609344), unit: "km" };
  if (/\bkm\b|\bmil\b/i.test(raw)) {
    // Swedish "mil" is 10 km; only apply when the unit is unambiguous.
    if (/\bmil\b/i.test(raw) && !/\bkm\b/i.test(raw)) return { value: Math.round(value * 10), unit: "km" };
    return { value: Math.round(value), unit: "km" };
  }
  return { value: Math.round(value), unit: "km" };
}

/** Area normalized to square metres. */
export function normalizeArea(raw: string): { value: number | null; unit: string | null } {
  const value = parseNumber(raw);
  if (value === null) return { value: null, unit: null };
  if (/\bsq\s?ft\b|\bft²\b|\bsqft\b/i.test(raw)) return { value: Math.round(value * 0.092903), unit: "m2" };
  return { value: Math.round(value), unit: "m2" };
}

export type AttributeKind = "text" | "number" | "money" | "distance" | "area" | "date" | "year" | "url";

/** Attribute definition produced by the radar's AI interpretation. */
export interface AttributeSpec {
  key: string;
  label: string;
  kind: AttributeKind;
}

/**
 * Apply the right normalization for the attribute kind while keeping the raw
 * string exactly as the source wrote it.
 */
export function normalizeAttribute(
  spec: AttributeSpec,
  raw: string | null,
  confidence: AttributeConfidence,
  sourceUrl: string | null,
): AttributeValue {
  const base: AttributeValue = {
    key: spec.key,
    raw: raw && raw.trim() ? raw.trim().slice(0, 300) : null,
    value: null,
    currency: null,
    unit: null,
    confidence: raw && raw.trim() ? confidence : "unknown",
    source_url: sourceUrl,
  };
  if (!base.raw) return base;

  switch (spec.kind) {
    case "money": {
      const { value, currency } = normalizeMoney(base.raw);
      return { ...base, value, currency };
    }
    case "distance": {
      const { value, unit } = normalizeDistance(base.raw);
      return { ...base, value, unit };
    }
    case "area": {
      const { value, unit } = normalizeArea(base.raw);
      return { ...base, value, unit };
    }
    case "year": {
      const n = parseNumber(base.raw);
      return { ...base, value: n !== null && n >= 1900 && n <= 2100 ? n : null };
    }
    case "number": {
      return { ...base, value: parseNumber(base.raw) };
    }
    case "date": {
      const t = Date.parse(base.raw);
      return { ...base, value: Number.isNaN(t) ? null : t };
    }
    default:
      return base;
  }
}

/** Only stated/structured values may be presented to the user as facts. */
export function isFactual(attribute: AttributeValue): boolean {
  return attribute.confidence === "stated" || attribute.confidence === "structured";
}

/** Compact comparable representation used for change detection. */
export function attributeSignature(attribute: AttributeValue): string {
  if (attribute.value !== null) return `${attribute.value}${attribute.currency ?? attribute.unit ?? ""}`;
  return attribute.raw ?? "";
}
