/**
 * Semantic criterion analysis — pure, model-free, category-agnostic.
 *
 * A user criterion is a phrase ("havsutsikt", "balcony", "garage"), not an
 * attribute key. Marketplaces express the same property a dozen ways, and —
 * critically — they also express NEARBY-but-different properties with very
 * similar words. "Sjönära" is not "sjöutsikt"; "gemensam takterrass" is not a
 * private balcony; "utsikt mot innergård" is a view of something else.
 *
 * This module answers, for one phrase and the surfaces already retrieved:
 *
 *   confirmed    — the listing states it, either literally or through a
 *                  meaning-equivalent formulation ("utsikt över Stockholms
 *                  inlopp" for havsutsikt)
 *   probable     — only a weaker or adjacent wording was found
 *   contradicted — the listing states the opposite, or negates the phrase
 *   unknown      — the listing never addresses it
 *   unfetchable  — the listing page could not be opened at all, so nothing
 *                  about the criterion was ever read. This is NEVER the same
 *                  thing as "the listing does not mention it".
 *
 * Everything is vocabulary + phrase patterns + negation windows, so it works
 * for any category and never fabricates: each verdict carries the exact
 * snippet it was decided from.
 */

export type SemanticStatus = "confirmed" | "probable" | "contradicted" | "unknown" | "unfetchable";

export interface SemanticSurface {
  url: string;
  /** How strong this surface is as a statement of fact. */
  kind: "jsonld" | "field" | "title" | "opengraph" | "description" | "heading" | "feature" | "image_metadata" | "text" | "snippet";
  text: string;
}

export interface SemanticVerdict {
  phrase: string;
  status: SemanticStatus;
  confidence: number;
  /** The wording that decided the verdict. */
  matched: string | null;
  /** Verbatim snippet from the source, so the user can check it. */
  snippet: string | null;
  source_url: string | null;
  source_kind: SemanticSurface["kind"] | null;
  reason: string;
  /** How the verdict was reached. */
  method?: "vocabulary" | "pattern" | "literal" | "ai" | "fetch_failure";
}

/**
 * Concept vocabulary. `strong` proves the concept, `weak` only suggests it
 * (adjacent or ambiguous wording), `against` disproves it, and `patterns` /
 * `againstPatterns` capture formulations that no word list can enumerate
 * ("utsikt över Stockholms inlopp"). This is language data, not category
 * logic — unknown phrases fall back to literal matching.
 */
interface Concept {
  key: string;
  strong: string[];
  weak: string[];
  against: string[];
  patterns?: RegExp[];
  againstPatterns?: RegExp[];
}

/** Words naming a body of water, used by the generic "view of X" patterns. */
const WATER =
  "hav|havet|havsband\\w*|sjo|sjon|sjoar\\w*|vatten|vattnet|fjard\\w*|inlopp\\w*|saltsjon|malaren|viken|vika\\w*|kanalen|hamnen|hamninlopp\\w*|strommen|skargard\\w*|bryggan|kajen|oceanen|riddarfjarden|sea|ocean|water|lake|bay|harbou?r|marina|river|fjord";

const CONCEPTS: Concept[] = [
  {
    key: "sea_view",
    strong: [
      "havsutsikt",
      "sjoutsikt",
      "vattenutsikt",
      "utsikt over havet",
      "utsikt over vattnet",
      "utsikt mot vattnet",
      "sea view",
      "ocean view",
      "water view",
      "lake view",
      "waterfront view",
      "panoramautsikt over havet",
    ],
    // "Utsikt över <något som är vatten>" — the object of the view decides it.
    patterns: [
      new RegExp(`utsikt(?:en)?\\s+(?:over|mot|ut over|at|upp over)\\s+[^.,;!?]{0,40}?\\b(?:${WATER})\\b`, "i"),
      new RegExp(`(?:fri|fantastisk|hanforande|magisk|vidstrackt|obruten|storslagen)\\s+utsikt[^.,;!?]{0,40}?\\b(?:${WATER})\\b`, "i"),
      new RegExp(`\\b(?:${WATER})\\b[^.,;!?]{0,25}\\butsikt`, "i"),
      new RegExp(`views?\\s+(?:of|over|across|onto|towards?)\\s+[^.,;!?]{0,40}?\\b(?:${WATER})\\b`, "i"),
      new RegExp(`overlook(?:s|ing)\\s+[^.,;!?]{0,30}?\\b(?:${WATER})\\b`, "i"),
    ],
    weak: [
      "havsnara",
      "sjonara",
      "vattennara",
      "nara havet",
      "nara vattnet",
      "utsikt",
      "waterfront",
      "close to the sea",
      "by the water",
      "seaside",
      "vid kajen",
      "nara kajen",
    ],
    against: ["ingen utsikt", "no view"],
    againstPatterns: [
      /utsikt(?:en)?\s+(?:over|mot|ut over)\s+(?:den\s+|de\s+|sin\s+)?(?:lummiga\s+|grona\s+)?(?:innergard\w*|garden|gatan|parken|skogen|takasen|granngard\w*)/i,
      /views?\s+(?:of|over)\s+the\s+(?:courtyard|street|park|garden|rooftops)/i,
    ],
  },
  {
    key: "balcony",
    // A balcony is a balcony. A terrace, patio or shared roof deck is NOT a
    // balcony — it is adjacent evidence at best.
    strong: ["balkong", "egen balkong", "inglasad balkong", "stor balkong", "fransk balkong", "balcony", "balkony", "juliet balcony"],
    patterns: [/\bbalkong(?:en|er|erna)?\b/i, /\bbalcon(?:y|ies)\b/i],
    weak: [
      "terrass",
      "takterrass",
      "gemensam takterrass",
      "uteplats",
      "altan",
      "patio",
      "terrace",
      "shared terrace",
      "communal roof terrace",
      "loggia",
    ],
    against: ["ingen balkong", "saknar balkong", "no balcony", "without balcony", "utan balkong"],
  },
  {
    // Dwelling type. A flat is a flat whether the listing calls it "lägenhet",
    // "bostadsrätt" or "apartment"; a house or a plot is a different thing.
    key: "apartment",
    strong: [
      "lagenhet",
      "lagenheten",
      "bostadsratt",
      "bostadsratten",
      "brf",
      "apartment",
      "flat",
      "condo",
      "condominium",
      "etagelagenhet",
      "hornlagenhet",
    ],
    patterns: [/\blagenhet\w*\b/i, /\bbostadsratt\w*\b/i, /\bapartments?\b/i],
    weak: ["boende", "bostad", "hem", "residence", "home"],
    against: ["villa", "radhus", "kedjehus", "fritidshus", "tomt", "parhus", "detached house", "townhouse", "plot"],
  },
  {
    key: "elevator",
    strong: ["hiss", "elevator", "lift", "aufzug"],
    weak: ["hiss planeras", "hiss kan installeras", "elevator planned"],
    against: ["ingen hiss", "saknar hiss", "no elevator", "no lift", "utan hiss"],
  },
  {
    key: "parking",
    strong: ["garage", "parkeringsplats", "p-plats", "carport", "parking space", "private parking", "garageplats"],
    weak: ["parkering i narheten", "boendeparkering", "gatuparkering", "street parking", "parking nearby", "parkering kan hyras"],
    against: ["ingen parkering", "saknar parkering", "no parking"],
  },
  {
    key: "furnished",
    strong: ["moblerad", "fullt moblerad", "furnished", "fully furnished"],
    weak: ["delvis moblerad", "partly furnished", "semi-furnished"],
    against: ["omoblerad", "unfurnished"],
  },
  {
    key: "fireplace",
    strong: ["oppen spis", "kakelugn", "braskamin", "fireplace", "wood stove"],
    weak: ["eldstad finns i foreningen", "kamin kan installeras"],
    against: ["ingen eldstad", "no fireplace"],
  },
  {
    key: "garden",
    strong: ["tradgard", "egen tradgard", "garden", "private garden", "tomt"],
    weak: ["gemensam tradgard", "innergard", "shared garden", "communal garden", "courtyard"],
    against: ["ingen tradgard", "no garden"],
  },
  {
    key: "new_condition",
    strong: ["nyskick", "oanvand", "helt ny", "brand new", "mint condition", "unused", "sealed"],
    weak: ["mycket gott skick", "gott skick", "very good condition", "like new", "excellent condition"],
    against: ["begagnad", "sliten", "defekt", "for delar", "damaged", "for parts", "faulty"],
  },
  {
    key: "warranty",
    strong: ["garanti", "kvitto finns", "warranty", "receipt included", "under warranty"],
    weak: ["garanti kan finnas", "warranty may apply"],
    against: ["ingen garanti", "utan kvitto", "no warranty", "no receipt"],
  },
  {
    key: "service_history",
    strong: ["fullstandig servicehistorik", "servicebok", "full service history", "komplett servicehistorik"],
    weak: ["delvis servicehistorik", "service utford", "partial service history", "recently serviced"],
    against: ["ingen servicehistorik", "no service history"],
  },
];

/** Surfaces that state facts rather than describe them. */
const STRONG_SURFACES: SemanticSurface["kind"][] = ["jsonld", "field", "title", "opengraph", "heading", "feature"];
/** The listing's own body copy — a first-class source, not a fallback. */
const BODY_SURFACES: SemanticSurface["kind"][] = ["description", "text"];

export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Negations that flip a nearby positive mention. */
const NEGATORS = /\b(ingen|inget|inga|utan|saknar|ej|inte|no|not|without|lacks|missing)\b/i;

interface Hit {
  index: number;
  snippet: string;
  matched: string;
}

function snippetAround(haystack: string, at: number, length: number): string {
  return haystack.slice(Math.max(0, at - 90), Math.min(haystack.length, at + length + 90)).trim();
}

function findPhrase(haystack: string, phrase: string): Hit | null {
  const h = fold(haystack);
  const p = fold(phrase).trim();
  if (!p) return null;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(p)}([^\\p{L}\\p{N}]|$)`, "u");
  const m = h.match(re);
  if (!m || m.index === undefined) return null;
  const at = m.index + (m[1]?.length ?? 0);
  return { index: at, snippet: snippetAround(haystack, at, p.length), matched: haystack.slice(at, at + p.length) };
}

/** Patterns are matched on the folded text, snippets are cut from the original. */
function findPattern(haystack: string, pattern: RegExp): Hit | null {
  const h = fold(haystack);
  const m = h.match(pattern);
  if (!m || m.index === undefined) return null;
  return {
    index: m.index,
    snippet: snippetAround(haystack, m.index, m[0].length),
    matched: haystack.slice(m.index, m.index + m[0].length),
  };
}

/** True when the words immediately before the hit negate it. */
function negatedAt(haystack: string, index: number): boolean {
  const before = haystack.slice(Math.max(0, index - 40), index);
  return NEGATORS.test(before);
}

export function conceptFor(phrase: string): Concept | null {
  const p = fold(phrase);
  for (const c of CONCEPTS) {
    if (c.strong.some((s) => p.includes(fold(s)) || fold(s).includes(p))) return c;
    if (c.weak.some((s) => p === fold(s))) return c;
  }
  return null;
}

function surfaceRank(kind: SemanticSurface["kind"]): number {
  if (STRONG_SURFACES.includes(kind)) return 3;
  if (BODY_SURFACES.includes(kind)) return 2;
  return 1; // search snippet — weakest, and never the only basis when a page was read
}

function surfaceLabel(kind: SemanticSurface["kind"]): string {
  switch (kind) {
    case "field":
      return "specification field";
    case "jsonld":
      return "structured listing data";
    case "opengraph":
      return "page metadata";
    case "title":
      return "listing title";
    case "description":
      return "listing description";
    case "heading":
      return "listing heading";
    case "feature":
      return "feature or specification";
    case "image_metadata":
      return "listing image metadata";
    case "snippet":
      return "search snippet";
    default:
      return "listing page text";
  }
}

/** The verdict to use when the listing page itself could never be opened. */
export function unfetchableVerdict(phrase: string, url: string, reason: string): SemanticVerdict {
  return {
    phrase,
    status: "unfetchable",
    confidence: 0,
    matched: null,
    snippet: null,
    source_url: url,
    source_kind: null,
    reason: `could not verify — the listing page could not be opened (${reason})`,
    method: "fetch_failure",
  };
}

/**
 * Evaluate one user phrase against every retrieved surface for one listing.
 * Structured surfaces are read first, then the listing's own body copy, and a
 * negation always wins over a positive mention of the same wording.
 */
export function evaluateSemanticCriterion(phrase: string, surfaces: SemanticSurface[]): SemanticVerdict {
  const clean = phrase.trim();
  const base: SemanticVerdict = {
    phrase: clean,
    status: "unknown",
    confidence: 0,
    matched: null,
    snippet: null,
    source_url: null,
    source_kind: null,
    reason: `the listing never mentions "${clean}"`,
    method: "literal",
  };
  if (!clean || surfaces.length === 0) return base;

  const concept = conceptFor(clean);
  const strongTerms = Array.from(new Set([clean, ...(concept?.strong ?? [])]));
  const strongPatterns = concept?.patterns ?? [];
  const weakTerms = concept?.weak ?? [];
  const againstTerms = concept?.against ?? [];
  const againstPatterns = concept?.againstPatterns ?? [];

  const ordered = [...surfaces]
    .filter((s) => s.text && s.text.trim().length > 0)
    .sort((a, b) => surfaceRank(b.kind) - surfaceRank(a.kind));

  let probable: SemanticVerdict | null = null;
  let negation: SemanticVerdict | null = null;

  // 1. Positive statements — literal wording first, then meaning-equivalent
  //    formulations. A negation of the same wording contradicts instead.
  for (const s of ordered) {
    for (const term of strongTerms) {
      const hit = findPhrase(s.text, term);
      if (!hit) continue;
      if (negatedAt(s.text, hit.index)) {
        negation ??= {
          phrase: clean,
          status: "contradicted",
          confidence: 0.85,
          matched: term,
          snippet: hit.snippet,
          source_url: s.url,
          source_kind: s.kind,
          reason: `the listing negates "${term}"`,
          method: "vocabulary",
        };
        continue;
      }
      return {
        phrase: clean,
        status: "confirmed",
        confidence: STRONG_SURFACES.includes(s.kind) ? 0.95 : 0.9,
        matched: term,
        snippet: hit.snippet,
        source_url: s.url,
        source_kind: s.kind,
        reason: `stated as "${term}" in the ${surfaceLabel(s.kind)}`,
        method: "vocabulary",
      };
    }
    for (const pattern of strongPatterns) {
      const hit = findPattern(s.text, pattern);
      if (!hit || negatedAt(s.text, hit.index)) continue;
      return {
        phrase: clean,
        status: "confirmed",
        confidence: STRONG_SURFACES.includes(s.kind) ? 0.95 : 0.88,
        matched: hit.matched,
        snippet: hit.snippet,
        source_url: s.url,
        source_kind: s.kind,
        reason: `the ${surfaceLabel(s.kind)} states "${hit.matched.trim()}"`,
        method: "pattern",
      };
    }
  }

  // 2. Explicit contradiction — either a stated opposite or a negated mention.
  for (const s of ordered) {
    for (const term of againstTerms) {
      const hit = findPhrase(s.text, term);
      if (!hit) continue;
      return {
        phrase: clean,
        status: "contradicted",
        confidence: STRONG_SURFACES.includes(s.kind) ? 0.95 : 0.8,
        matched: term,
        snippet: hit.snippet,
        source_url: s.url,
        source_kind: s.kind,
        reason: `the listing states "${term}"`,
        method: "vocabulary",
      };
    }
    for (const pattern of againstPatterns) {
      const hit = findPattern(s.text, pattern);
      if (!hit) continue;
      return {
        phrase: clean,
        status: "contradicted",
        confidence: 0.85,
        matched: hit.matched,
        snippet: hit.snippet,
        source_url: s.url,
        source_kind: s.kind,
        reason: `the listing states "${hit.matched.trim()}", which is a different ${clean}`,
        method: "pattern",
      };
    }
  }
  if (negation) return negation;

  // 3. Adjacent wording only — never a confirmation.
  for (const s of ordered) {
    for (const term of weakTerms) {
      const hit = findPhrase(s.text, term);
      if (!hit || negatedAt(s.text, hit.index)) continue;
      probable ??= {
        phrase: clean,
        status: "probable",
        confidence: 0.5,
        matched: term,
        snippet: hit.snippet,
        source_url: s.url,
        source_kind: s.kind,
        reason: `the listing says "${term}", which is close to but not the same as "${clean}"`,
        method: "vocabulary",
      };
    }
  }

  return probable ?? base;
}

/** Evaluate several phrases at once. */
export function evaluateSemanticCriteria(phrases: string[], surfaces: SemanticSurface[]): SemanticVerdict[] {
  const seen = new Set<string>();
  const out: SemanticVerdict[] = [];
  for (const phrase of phrases) {
    const key = fold(phrase.trim());
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(evaluateSemanticCriterion(phrase, surfaces));
  }
  return out;
}

/** Storable, UI-safe shape. */
export interface StoredSemantic {
  phrase: string;
  status: SemanticStatus;
  confidence: number;
  snippet: string | null;
  source_url: string | null;
  reason: string;
  /** Which part of the page the evidence came from. */
  source_kind?: SemanticSurface["kind"] | null;
  source_label?: string | null;
  method?: SemanticVerdict["method"];
  interpretation?: string | null;
}

export function storableSemantics(verdicts: SemanticVerdict[]): StoredSemantic[] {
  return verdicts.map((v) => ({
    phrase: v.phrase,
    status: v.status,
    confidence: Math.round(v.confidence * 100) / 100,
    snippet: v.snippet ? v.snippet.slice(0, 240) : null,
    source_url: v.source_url,
    reason: v.reason.slice(0, 300),
    source_kind: v.source_kind ?? null,
    source_label: v.source_kind ? surfaceLabel(v.source_kind) : null,
    method: v.method ?? "vocabulary",
    interpretation: v.matched ? `“${v.matched.trim()}” supports ${v.phrase}` : null,
  }));
}

export function storedSemanticsOf(value: unknown): StoredSemantic[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is StoredSemantic =>
      !!v && typeof v === "object" && typeof (v as StoredSemantic).phrase === "string",
  );
}
