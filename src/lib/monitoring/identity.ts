/**
 * Canonical product identity — pure, category-agnostic, testable.
 *
 * The user writes what they want in ONE way ("Apple AirPods Pro 2",
 * "BMW M340i", "Rolex Submariner Date 126610LN"). The market writes the same
 * thing in a dozen ways ("AirPods Pro (2nd Generation)", "M340i xDrive
 * Touring", "Submariner Date 126610LN Black"). A single literal text match on
 * one field therefore says almost nothing: it produces UNKNOWN for items that
 * are obviously the right thing, and it never notices that "AirPods Pro 3" is
 * provably the WRONG thing.
 *
 * This module turns a free-text product name into a canonical identity — brand
 * slot, core words, model codes, generation, year — and then resolves that
 * identity against every surface Radar retrieved for a listing. It answers with
 * evidence, not a boolean:
 *
 *   verified   — every part of the identity is stated, by structured data or by
 *                two independent surfaces, and nothing contradicts it.
 *   probable   — the family is stated but the generation or the model code was
 *                never written down.
 *   conflicted — a surface states a DIFFERENT generation or model code.
 *   unknown    — the family itself was never stated on any surface.
 *
 * Nothing here knows what a car, a watch or a pair of earbuds is. It only
 * reasons about how product names are written.
 */

export type IdentityStatus = "verified" | "probable" | "conflicted" | "unknown";

export interface CanonicalIdentity {
  /** The user's original wording, untouched. */
  raw: string;
  /** Positional brand slot — the first plain word. Never required on its own. */
  brand: string | null;
  /** Distinguishing words that must be stated ("airpods", "pro", "submariner"). */
  words: string[];
  /** Model codes: alphanumeric or long numeric tokens ("m340i", "126610ln"). */
  codes: string[];
  /** Generation/mark/series number when the name carries one. */
  generation: number | null;
  /** Model year when the name carries one. */
  year: number | null;
  /** Stable comparison key. */
  key: string;
}

export interface IdentitySource {
  /** Where the text came from: jsonld, og, detail_title, detail_text, index_card… */
  sourceType: string;
  url: string | null;
  text: string;
}

export interface IdentityResolution {
  status: IdentityStatus;
  confidence: number;
  /** Identity parts that some surface actually stated. */
  matched: string[];
  /** Identity parts nothing stated. */
  missing: string[];
  /** Identity parts a surface stated DIFFERENTLY. */
  conflicts: string[];
  /** Surfaces that supported the identity. */
  sources: { sourceType: string; url: string | null }[];
  explanation: string;
  canonical: string;
}

/** Surfaces whose statements are strong enough to verify on their own. */
const STRUCTURED_SOURCES = new Set(["jsonld", "og", "meta", "detail_field", "identifier"]);

/** Words that carry no identity: they appear in every listing. */
const STOPWORDS = new Set([
  "the", "and", "with", "for", "new", "used", "sale", "sales", "buy", "shop",
  "och", "med", "till", "for", "ny", "nya", "begagnad", "begagnat", "saljes", "kop", "kopa",
  "der", "die", "das", "und", "mit", "neu", "gebraucht",
  "de", "la", "le", "el", "und", "van", "een",
]);

const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9 };

/** Explicit "generation" wordings, written the way real listings write them. */
const GEN_PATTERNS: RegExp[] = [
  // "2nd generation", "2:a generationen", "2 gen"
  /\b(\d{1,2})\s*(?:st|nd|rd|th|:a|:e)?\s*(?:generation|generationen|gen)\b/giu,
  // "generation 2", "gen. 2", "mk2", "mark II", "series 3", "version 2"
  /\b(?:generation|generationen|gen|mark|mk|series|serie|version|ver)\s*[.:]?\s*(\d{1,2})\b/giu,
];
const ROMAN_PATTERN = /\b(?:mark|mk|generation|gen|serie|series)\s*[.:]?\s*(ii|iii|iv|vi|vii|viii|ix)\b/giu;

export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenize(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function isYear(token: string): boolean {
  return /^(19|20)\d{2}$/.test(token);
}

function isCode(token: string): boolean {
  if (!/\d/.test(token)) return false;
  if (isYear(token)) return false;
  if (/[a-z]/.test(token) && token.length >= 3) return true;
  return /^\d{4,}$/.test(token);
}

/** Read every generation number an arbitrary piece of text explicitly states. */
export function statedGenerations(text: string): Set<number> {
  const found = new Set<number>();
  for (const pattern of GEN_PATTERNS) {
    for (const m of fold(text).matchAll(pattern)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n < 30) found.add(n);
    }
  }
  for (const m of fold(text).matchAll(ROMAN_PATTERN)) {
    const n = ROMAN[m[1]!.toLowerCase()];
    if (n) found.add(n);
  }
  return found;
}

/**
 * A bare number is only a generation when it sits immediately after the last
 * distinguishing word of the identity ("AirPods Pro 2"). Anywhere else on a
 * page a bare number is a price, a count or a phone number.
 */
function anchoredGeneration(text: string, anchor: string | null): number | null {
  if (!anchor) return null;
  const escaped = fold(anchor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = fold(text).match(new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}[\\s\\-]*(\\d{1,2})(?![\\d.,:])`, "u"));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n < 30 ? n : null;
}

/** Turn a free-text product name into a canonical identity. */
export function parseIdentity(raw: string): CanonicalIdentity {
  const generations = statedGenerations(raw);
  let stripped = fold(raw);
  for (const pattern of GEN_PATTERNS) stripped = stripped.replace(pattern, " ");
  stripped = stripped.replace(ROMAN_PATTERN, " ");

  const tokens = tokenize(stripped);
  const words: string[] = [];
  const codes: string[] = [];
  let year: number | null = null;
  let bare: number | null = null;

  for (const token of tokens) {
    if (isYear(token)) {
      year ??= Number(token);
      continue;
    }
    if (isCode(token)) {
      if (!codes.includes(token)) codes.push(token);
      continue;
    }
    if (/^\d{1,2}$/.test(token)) {
      // A short bare number in the NAME is the generation ("AirPods Pro 2").
      bare = Number(token);
      continue;
    }
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    if (!words.includes(token)) words.push(token);
  }

  const generation = generations.size > 0 ? [...generations][0]! : bare;
  const brand = words.length > 1 ? words[0]! : null;
  const core = brand ? words.slice(1) : words;

  return {
    raw: raw.trim(),
    brand,
    words: core,
    codes,
    generation: generation ?? null,
    year,
    key: [brand ?? "", ...core, ...codes, generation ? `g${generation}` : "", year ? `y${year}` : ""]
      .filter(Boolean)
      .join("-"),
  };
}

function statesWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Whole word, but also tolerant of glued spellings ("airpodspro").
  return (
    new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "u").test(text) || text.includes(word)
  );
}

function statesCode(text: string, code: string): boolean {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "u").test(text)) return true;
  // Codes are frequently written with separators: "126610-ln", "M 340 i".
  const loose = code.split("").join("[\\s.\\-/]*");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${loose}([^\\p{L}\\p{N}]|$)`, "u").test(text);
}


/** Sources short enough that a model code in them is about the item itself. */
const NAMING_SOURCES = new Set(["detail_title", "og", "jsonld", "meta", "index_card", "extracted_item", "detail_field"]);
const PRICE_CONTEXT = /(kr|sek|eur|usd|gbp|nok|dkk|:-|,-|\$|€|£)/;

/**
 * Model codes the SOURCE states, so a different code in the same numbering
 * scheme can be reported as a contradiction instead of a silent gap. Numbers
 * written next to a currency are prices, never model codes.
 */
function statedCodes(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(^|[^\p{L}\p{N}])([\p{L}]*\d[\p{L}\d]{2,})(?=[^\p{L}\p{N}]|$)/gu)) {
    const token = m[2]!;
    if (isYear(token)) continue;
    if (!isCode(token)) continue;
    const tail = text.slice(m.index! + m[0].length, m.index! + m[0].length + 6);
    if (PRICE_CONTEXT.test(tail)) continue;
    if (!found.includes(token)) found.push(token);
  }
  return found;
}

function digitsOf(token: string): string {
  return token.replace(/\D/g, "");
}

interface SourceReading {
  source: IdentitySource;
  covered: string[];
  missing: string[];
  conflicts: string[];
  brandSeen: boolean;
}

function readSource(target: CanonicalIdentity, source: IdentitySource): SourceReading {
  const text = fold(source.text ?? "");
  const covered: string[] = [];
  const missing: string[] = [];
  const conflicts: string[] = [];

  for (const word of target.words) {
    if (statesWord(text, word)) covered.push(word);
    else missing.push(word);
  }
  for (const code of target.codes) {
    if (statesCode(text, code)) covered.push(code);
    else missing.push(code);
  }
  // A source that names a DIFFERENT code from the same numbering scheme is
  // describing a different model, not merely omitting the one we asked for.
  if (target.codes.length > 0 && !target.codes.some((c) => covered.includes(c)) && NAMING_SOURCES.has(source.sourceType)) {
    for (const candidate of statedCodes(text)) {
      const clash = target.codes.find((c) => digitsOf(c).length === digitsOf(candidate).length && c !== candidate);
      if (clash) {
        conflicts.push(`model ${candidate} ≠ ${clash}`);
        break;
      }
    }
  }


  if (target.generation !== null) {
    const anchor = target.words.length > 0 ? target.words[target.words.length - 1]! : target.brand;
    const stated = statedGenerations(source.text ?? "");
    const anchored = anchoredGeneration(source.text ?? "", anchor);
    if (anchored !== null) stated.add(anchored);
    if (stated.has(target.generation)) covered.push(`generation ${target.generation}`);
    else if (stated.size > 0) conflicts.push(`generation ${[...stated].join("/")} ≠ ${target.generation}`);
    else missing.push(`generation ${target.generation}`);
  }

  return {
    source,
    covered,
    missing,
    conflicts,
    brandSeen: target.brand ? statesWord(text, target.brand) : true,
  };
}

/**
 * Resolve one canonical identity against every surface retrieved for a listing.
 * Signals are UNIONED across surfaces — one source may state the family and
 * another the generation — while a contradiction on any factual surface is
 * decisive.
 */
export function resolveIdentity(target: CanonicalIdentity, sources: IdentitySource[]): IdentityResolution {
  const canonical = target.raw;
  const required = [
    ...target.words,
    ...target.codes,
    ...(target.generation !== null ? [`generation ${target.generation}`] : []),
  ];

  if (required.length === 0) {
    return {
      status: "unknown",
      confidence: 0,
      matched: [],
      missing: [],
      conflicts: [],
      sources: [],
      explanation: `"${canonical}" carries no distinguishing terms to verify`,
      canonical,
    };
  }

  const readings = sources.filter((s) => (s.text ?? "").trim().length > 0).map((s) => readSource(target, s));
  if (readings.length === 0) {
    return {
      status: "unknown",
      confidence: 0,
      matched: [],
      missing: required,
      conflicts: [],
      sources: [],
      explanation: `no retrieved source mentions "${canonical}"`,
      canonical,
    };
  }

  const coveredUnion = new Set<string>();
  const supporting: SourceReading[] = [];
  const conflicts = new Set<string>();
  let brandSeen = false;
  let structuredSupport = false;

  for (const reading of readings) {
    for (const c of reading.covered) coveredUnion.add(c);
    if (reading.conflicts.length > 0) for (const c of reading.conflicts) conflicts.add(c);
    if (reading.brandSeen) brandSeen = true;
    if (reading.covered.length > 0) {
      supporting.push(reading);
      if (STRUCTURED_SOURCES.has(reading.source.sourceType)) structuredSupport = true;
    }
  }

  const missing = required.filter((r) => !coveredUnion.has(r));
  const matched = required.filter((r) => coveredUnion.has(r));
  const wordsCovered = target.words.every((w) => coveredUnion.has(w));
  const usedSources = supporting.map((s) => ({ sourceType: s.source.sourceType, url: s.source.url }));
  const distinct = new Set(supporting.map((s) => s.source.sourceType)).size;

  if (conflicts.size > 0 && wordsCovered) {
    return {
      status: "conflicted",
      confidence: 0.25,
      matched,
      missing,
      conflicts: [...conflicts],
      sources: usedSources,
      explanation: `the listing states a different variant of "${canonical}": ${[...conflicts].join(", ")}`,
      canonical,
    };
  }

  if (missing.length === 0) {
    const strong = structuredSupport || distinct >= 2;
    return {
      status: strong ? "verified" : "probable",
      confidence: strong ? (brandSeen ? 0.95 : 0.85) : 0.7,
      matched,
      missing,
      conflicts: [],
      sources: usedSources,
      explanation: strong
        ? `"${canonical}" is stated by ${distinct} source${distinct === 1 ? "" : "s"} (${matched.join(", ")})`
        : `"${canonical}" is stated by a single source (${matched.join(", ")})`,
      canonical,
    };
  }

  // PROBABLE is only honest when the missing part is the generation, or when
  // the family itself is distinctive enough (two or more naming words) that a
  // missing model code is an omission rather than a different product.
  const onlyGenerationMissing = missing.every((m) => m.startsWith("generation "));
  const distinctiveFamily = target.words.length >= 2 && target.words.every((w) => coveredUnion.has(w));
  if (wordsCovered && matched.length > 0 && (onlyGenerationMissing || distinctiveFamily)) {

    return {
      status: "probable",
      confidence: structuredSupport || distinct >= 2 ? 0.65 : 0.5,
      matched,
      missing,
      conflicts: [...conflicts],
      sources: usedSources,
      explanation: `"${canonical}" matches the listing, but ${missing.join(", ")} is never stated`,
      canonical,
    };
  }

  return {
    status: "unknown",
    confidence: 0.1,
    matched,
    missing,
    conflicts: [...conflicts],
    sources: usedSources,
    explanation: `nothing on the listing states ${missing.join(", ")} of "${canonical}"`,
    canonical,
  };
}

/**
 * True when two identities may be compared as the same market segment. Used to
 * keep a market value from being computed across different generations.
 */
export function comparableIdentity(a: CanonicalIdentity, b: CanonicalIdentity): boolean {
  if (a.generation !== null && b.generation !== null && a.generation !== b.generation) return false;
  const shared = a.words.filter((w) => b.words.includes(w));
  if (a.words.length > 0 && shared.length === 0) return false;
  if (a.codes.length > 0 && b.codes.length > 0) return a.codes.some((c) => b.codes.includes(c));
  return true;
}
