/**
 * Deterministic geographic relevance.
 *
 * When a radar says "in Sweden", a listing published in GBP on a UK site is not
 * a Swedish match — but currency alone is never proof of anything, and a fact
 * that was never stated is never invented here. This module derives the market
 * a listing belongs to from EXPLICIT evidence only:
 *
 *   1. the source host's country code top-level domain,
 *   2. an address country stated in structured data (JSON-LD / meta),
 *   3. the country name written out in the page's own text.
 *
 * Currency is recorded as *supporting* evidence and can never, on its own,
 * establish or refute a market. Anything unproven stays unknown, which the
 * criteria gate turns into "needs verification" — never into a match.
 */
import type { AttributeValue } from "./normalize";
import type { HardConstraint } from "./criteria";

export interface Market {
  code: string;
  /** Canonical English name, used as the constraint token. */
  name: string;
  /** Names/adjectives the market uses for itself and common translations. */
  aliases: string[];
  /** Country-code TLDs that unambiguously belong to this market. */
  tlds: string[];
  /** Currencies commonly used here — supporting evidence only. */
  currencies: string[];
}

export const MARKETS: Market[] = [
  { code: "SE", name: "Sweden", aliases: ["sverige", "swedish", "svensk", "svenska"], tlds: [".se"], currencies: ["SEK"] },
  { code: "NO", name: "Norway", aliases: ["norge", "norwegian", "norsk"], tlds: [".no"], currencies: ["NOK"] },
  { code: "DK", name: "Denmark", aliases: ["danmark", "danish", "dansk"], tlds: [".dk"], currencies: ["DKK"] },
  { code: "FI", name: "Finland", aliases: ["suomi", "finnish", "finsk"], tlds: [".fi"], currencies: ["EUR"] },
  { code: "DE", name: "Germany", aliases: ["deutschland", "tyskland", "german", "deutsch"], tlds: [".de"], currencies: ["EUR"] },
  { code: "GB", name: "United Kingdom", aliases: ["uk", "england", "britain", "british", "storbritannien"], tlds: [".uk", ".co.uk"], currencies: ["GBP"] },
  { code: "NL", name: "Netherlands", aliases: ["nederland", "dutch", "holland"], tlds: [".nl"], currencies: ["EUR"] },
  { code: "FR", name: "France", aliases: ["frankrike", "french", "français"], tlds: [".fr"], currencies: ["EUR"] },
  { code: "ES", name: "Spain", aliases: ["españa", "spanien", "spanish"], tlds: [".es"], currencies: ["EUR"] },
  { code: "IT", name: "Italy", aliases: ["italia", "italien", "italian"], tlds: [".it"], currencies: ["EUR"] },
  { code: "PL", name: "Poland", aliases: ["polska", "polen", "polish"], tlds: [".pl"], currencies: ["PLN"] },
  { code: "BE", name: "Belgium", aliases: ["belgie", "belgique", "belgien"], tlds: [".be"], currencies: ["EUR"] },
  { code: "AT", name: "Austria", aliases: ["österreich", "austrian"], tlds: [".at"], currencies: ["EUR"] },
  { code: "CH", name: "Switzerland", aliases: ["schweiz", "suisse", "swiss"], tlds: [".ch"], currencies: ["CHF"] },
  { code: "IE", name: "Ireland", aliases: ["irland", "irish", "eire"], tlds: [".ie"], currencies: ["EUR"] },
  { code: "US", name: "United States", aliases: ["usa", "america", "american", "förenta staterna"], tlds: [], currencies: ["USD"] },
  { code: "CA", name: "Canada", aliases: ["canadian", "kanada"], tlds: [".ca"], currencies: ["CAD"] },
  { code: "AU", name: "Australia", aliases: ["australian", "australien"], tlds: [".au", ".com.au"], currencies: ["AUD"] },
  { code: "NZ", name: "New Zealand", aliases: ["nya zeeland"], tlds: [".nz", ".co.nz"], currencies: ["NZD"] },
];

const byCode = new Map(MARKETS.map((m) => [m.code, m]));

function fold(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Whole-word match, accent- and case-insensitive. */
function mentions(haystack: string, token: string): boolean {
  const t = fold(token).trim();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "u").test(fold(haystack));
}

/** Resolve free-text location wording ("Sverige", "SE", "Sweden") to a market. */
export function resolveMarket(text: string): Market | null {
  const t = fold(text).trim();
  if (!t) return null;
  const direct = byCode.get(t.toUpperCase());
  if (direct) return direct;
  return (
    MARKETS.find((m) => fold(m.name) === t || m.aliases.some((a) => fold(a) === t)) ??
    MARKETS.find((m) => mentions(text, m.name) || m.aliases.some((a) => mentions(text, a))) ??
    null
  );
}

/** Every market a radar's configured locations unambiguously name. */
export function requiredMarkets(locations: string[] | null | undefined): Market[] {
  const out: Market[] = [];
  for (const loc of locations ?? []) {
    const m = resolveMarket(String(loc));
    if (m && !out.some((x) => x.code === m.code)) out.push(m);
  }
  return out;
}

/** Market of a host, from its country-code TLD only. */
export function marketOfHost(host: string): Market | null {
  const h = host.replace(/^www\./, "").toLowerCase();
  let best: Market | null = null;
  for (const m of MARKETS) {
    for (const tld of m.tlds) {
      if (h.endsWith(tld) && (!best || tld.length > Math.max(...best.tlds.map((t) => t.length)))) best = m;
    }
  }
  return best;
}

export interface GeoEvidence {
  /** URL of the listing itself (its host TLD is structural evidence). */
  url?: string | null;
  /** Structured fields read from the page (JSON-LD, meta, spec tables). */
  fields?: Record<string, string> | undefined;
  /** Verbatim page text / title / index-card text. */
  text?: string | undefined;
  /** Currency read from the listing — supporting evidence only. */
  currency?: string | null | undefined;
}

export interface GeoVerdict {
  market: Market | null;
  /** structured = TLD or stated address country; stated = written in the text. */
  confidence: "structured" | "stated" | "unknown";
  /** Exactly what was read, for provenance. */
  evidence: string | null;
  source: string | null;
}

const COUNTRY_FIELD = /(addresscountry|country|countryname|land|nationality)/i;

/** Derive the market of one listing from explicit evidence. Never guesses. */
export function inferMarket(evidence: GeoEvidence): GeoVerdict {
  const fields = evidence.fields ?? {};
  for (const [key, value] of Object.entries(fields)) {
    if (!value || !COUNTRY_FIELD.test(key)) continue;
    const m = resolveMarket(String(value));
    if (m) return { market: m, confidence: "structured", evidence: `${key} = ${value}`, source: evidence.url ?? null };
  }

  if (evidence.url) {
    try {
      const host = new URL(evidence.url).host;
      const m = marketOfHost(host);
      if (m) return { market: m, confidence: "structured", evidence: host, source: evidence.url };
    } catch {
      /* not a URL — no structural evidence */
    }
  }

  const text = evidence.text ?? "";
  if (text) {
    for (const m of MARKETS) {
      const hit = [m.name, ...m.aliases].find((token) => mentions(text, token));
      if (hit) return { market: m, confidence: "stated", evidence: hit, source: evidence.url ?? null };
    }
  }

  return { market: null, confidence: "unknown", evidence: null, source: evidence.url ?? null };
}

/** The synthetic attribute key the criteria gate checks geography against. */
export const COUNTRY_ATTRIBUTE = "country";

/** Turn a geo verdict into a criteria-checkable attribute, or nothing. */
export function countryAttribute(verdict: GeoVerdict): AttributeValue | null {
  if (!verdict.market || verdict.confidence === "unknown") return null;
  return {
    key: COUNTRY_ATTRIBUTE,
    raw: verdict.market.name,
    value: null,
    unit: null,
    currency: null,
    confidence: verdict.confidence,
    source_url: verdict.source ?? null,
    origin: "detail",
  } as AttributeValue;
}

/**
 * The machine-checkable country requirement for a radar, when — and only when —
 * the radar itself named a market. Verified-wrong rejects, unknown stays
 * unverified; nothing here can turn an unproven listing into a match.
 */
export function countryConstraint(locations: string[] | null | undefined): HardConstraint | null {
  const markets = requiredMarkets(locations);
  if (markets.length !== 1) return null; // multi-market radars stay unconstrained
  const m = markets[0]!;
  return {
    attribute: COUNTRY_ATTRIBUTE,
    op: "includes",
    value: m.name,
    aliases: [m.code, ...m.aliases],
    label: `country = ${m.name}`,
  };
}

/** Currency that a market uses — used only to explain, never to prove. */
export function currencyMatchesMarket(currency: string | null | undefined, market: Market | null): boolean {
  if (!currency || !market) return false;
  return market.currencies.includes(currency.toUpperCase());
}
