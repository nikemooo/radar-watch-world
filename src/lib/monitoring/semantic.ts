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
 *   confirmed    — the page states it, in a strong surface (title/field/JSON-LD)
 *                  or with an exact synonym in the body
 *   probable     — only a weaker or adjacent wording was found
 *   contradicted — the page states the opposite, or negates the phrase
 *   unknown      — the page never addresses it
 *
 * Everything is vocabulary + negation windows, so it works for any category and
 * never fabricates: each verdict carries the exact snippet it was decided from.
 */

export type SemanticStatus = "confirmed" | "probable" | "contradicted" | "unknown";

export interface SemanticSurface {
  url: string;
  /** How strong this surface is as a statement of fact. */
  kind: "jsonld" | "field" | "title" | "opengraph" | "text" | "snippet";
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
}

/**
 * Concept vocabulary. `strong` proves the concept, `weak` only suggests it
 * (adjacent or ambiguous wording), `against` disproves it. This is language
 * data, not category logic — unknown phrases fall back to literal matching.
 */
interface Concept {
  key: string;
  strong: string[];
  weak: string[];
  against: string[];
}

const CONCEPTS: Concept[] = [
  {
    key: "sea_view",
    strong: ["havsutsikt", "sjöutsikt", "utsikt över havet", "utsikt över vattnet", "vattenutsikt", "sea view", "ocean view", "water view", "lake view", "panoramautsikt över havet"],
    weak: ["havsnära", "sjönära", "vattennära", "nära havet", "nära vattnet", "utsikt", "waterfront", "close to the sea", "by the water", "seaside"],
    against: ["utsikt mot innergård", "utsikt över gården", "ingen utsikt", "no view", "courtyard view"],
  },
  {
    key: "balcony",
    strong: ["balkong", "egen balkong", "inglasad balkong", "fransk balkong", "balcony", "terrass", "terrace", "uteplats", "patio", "altan"],
    weak: ["gemensam takterrass", "gemensam uteplats", "shared terrace", "communal roof terrace", "juliet balcony"],
    against: ["ingen balkong", "saknar balkong", "no balcony", "without balcony"],
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
    weak: ["parkering i närheten", "boendeparkering", "gatuparkering", "street parking", "parking nearby", "parkering kan hyras"],
    against: ["ingen parkering", "saknar parkering", "no parking"],
  },
  {
    key: "furnished",
    strong: ["möblerad", "fullt möblerad", "furnished", "fully furnished"],
    weak: ["delvis möblerad", "partly furnished", "semi-furnished"],
    against: ["omöblerad", "unfurnished"],
  },
  {
    key: "fireplace",
    strong: ["öppen spis", "kakelugn", "braskamin", "fireplace", "wood stove"],
    weak: ["eldstad finns i föreningen", "kamin kan installeras"],
    against: ["ingen eldstad", "no fireplace"],
  },
  {
    key: "garden",
    strong: ["trädgård", "egen trädgård", "garden", "private garden", "tomt"],
    weak: ["gemensam trädgård", "innergård", "shared garden", "communal garden", "courtyard"],
    against: ["ingen trädgård", "no garden"],
  },
  {
    key: "new_condition",
    strong: ["nyskick", "oanvänd", "helt ny", "brand new", "mint condition", "unused", "sealed"],
    weak: ["mycket gott skick", "gott skick", "very good condition", "like new", "excellent condition"],
    against: ["begagnad", "sliten", "defekt", "för delar", "damaged", "for parts", "faulty"],
  },
  {
    key: "warranty",
    strong: ["garanti", "kvitto finns", "warranty", "receipt included", "under warranty"],
    weak: ["garanti kan finnas", "warranty may apply"],
    against: ["ingen garanti", "utan kvitto", "no warranty", "no receipt"],
  },
  {
    key: "service_history",
    strong: ["fullständig servicehistorik", "servicebok", "full service history", "komplett servicehistorik"],
    weak: ["delvis servicehistorik", "service utförd", "partial service history", "recently serviced"],
    against: ["ingen servicehistorik", "no service history"],
  },
];

const STRONG_SURFACES: SemanticSurface["kind"][] = ["jsonld", "field", "title", "opengraph"];

function fold(text: string): string {
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

function findPhrase(haystack: string, phrase: string): { index: number; snippet: string } | null {
  const h = fold(haystack);
  const p = fold(phrase).trim();
  if (!p) return null;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(p)}([^\\p{L}\\p{N}]|$)`, "u");
  const m = h.match(re);
  if (!m || m.index === undefined) return null;
  const at = m.index + (m[1]?.length ?? 0);
  const snippet = haystack.slice(Math.max(0, at - 70), Math.min(haystack.length, at + p.length + 70)).trim();
  return { index: at, snippet };
}

/** True when the words immediately before the hit negate it. */
function negatedAt(haystack: string, index: number): boolean {
  const before = haystack.slice(Math.max(0, index - 40), index);
  return NEGATORS.test(before);
}

function conceptFor(phrase: string): Concept | null {
  const p = fold(phrase);
  for (const c of CONCEPTS) {
    if (c.strong.some((s) => p.includes(fold(s)) || fold(s).includes(p))) return c;
    if (c.weak.some((s) => p === fold(s))) return c;
  }
  return null;
}

/**
 * Evaluate one user phrase against every retrieved surface for one listing.
 * Strong surfaces are checked before body text, and a negation always wins
 * over a positive mention of the same wording.
 */
export function evaluateSemanticCriterion(phrase: string, surfaces: SemanticSurface[]): SemanticVerdict {
  const base: SemanticVerdict = {
    phrase,
    status: "unknown",
    confidence: 0,
    matched: null,
    snippet: null,
    source_url: null,
    source_kind: null,
    reason: `the listing never mentions "${phrase}"`,
  };
  const clean = phrase.trim();
  if (!clean || surfaces.length === 0) return base;

  const concept = conceptFor(clean);
  const strongTerms = Array.from(new Set([clean, ...(concept?.strong ?? [])]));
  const weakTerms = concept?.weak ?? [];
  const againstTerms = concept?.against ?? [];

  const ordered = [...surfaces].sort(
    (a, b) => Number(STRONG_SURFACES.includes(b.kind)) - Number(STRONG_SURFACES.includes(a.kind)),
  );

  // 1. Explicit contradiction anywhere is decisive.
  for (const s of ordered) {
    for (const term of againstTerms) {
      const hit = findPhrase(s.text, term);
      if (hit) {
        return {
          phrase: clean,
          status: "contradicted",
          confidence: STRONG_SURFACES.includes(s.kind) ? 0.95 : 0.8,
          matched: term,
          snippet: hit.snippet,
          source_url: s.url,
          source_kind: s.kind,
          reason: `the listing states "${term}"`,
        };
      }
    }
  }

  // 2. Positive wording — negation-aware.
  let probable: SemanticVerdict | null = null;
  for (const s of ordered) {
    for (const term of strongTerms) {
      const hit = findPhrase(s.text, term);
      if (!hit) continue;
      if (negatedAt(s.text, hit.index)) {
        return {
          phrase: clean,
          status: "contradicted",
          confidence: 0.85,
          matched: term,
          snippet: hit.snippet,
          source_url: s.url,
          source_kind: s.kind,
          reason: `the listing negates "${term}"`,
        };
      }
      const strongSurface = STRONG_SURFACES.includes(s.kind);
      const verdict: SemanticVerdict = {
        phrase: clean,
        status: strongSurface || term.length >= 6 ? "confirmed" : "probable",
        confidence: strongSurface ? 0.95 : 0.8,
        matched: term,
        snippet: hit.snippet,
        source_url: s.url,
        source_kind: s.kind,
        reason: strongSurface
          ? `stated as "${term}" in the listing's own ${s.kind === "field" ? "specification" : s.kind} data`
          : `the listing text states "${term}"`,
      };
      if (verdict.status === "confirmed") return verdict;
      probable ??= verdict;
    }
  }

  // 3. Adjacent wording only — never a confirmation.
  for (const s of ordered) {
    for (const term of weakTerms) {
      const hit = findPhrase(s.text, term);
      if (!hit || negatedAt(s.text, hit.index)) continue;
      const verdict: SemanticVerdict = {
        phrase: clean,
        status: "probable",
        confidence: 0.5,
        matched: term,
        snippet: hit.snippet,
        source_url: s.url,
        source_kind: s.kind,
        reason: `the listing says "${term}", which is close to but not the same as "${clean}"`,
      };
      probable ??= verdict;
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
}

export function storableSemantics(verdicts: SemanticVerdict[]): StoredSemantic[] {
  return verdicts.map((v) => ({
    phrase: v.phrase,
    status: v.status,
    confidence: Math.round(v.confidence * 100) / 100,
    snippet: v.snippet ? v.snippet.slice(0, 240) : null,
    source_url: v.source_url,
    reason: v.reason.slice(0, 300),
  }));
}

export function storedSemanticsOf(value: unknown): StoredSemantic[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is StoredSemantic =>
      !!v && typeof v === "object" && typeof (v as StoredSemantic).phrase === "string",
  );
}
