/**
 * Generic price extraction engine — pure, model-free, site-agnostic.
 *
 * A price is a *fact stated by a page*, written in one of a hundred different
 * shapes. This module reads those shapes without knowing anything about the
 * site, the country or the category: no `if (domain === "hemnet.se")` exists
 * here, and none may be added.
 *
 * Pipeline (each step only runs when the previous one produced nothing):
 *   1. structured data — JSON-LD / schema.org Offer, OpenGraph, meta, microdata
 *      and labelled spec fields;
 *   2. page text — money tokens read with their semantic context ("utgångspris",
 *      "accepterat pris", "nu", "ord. pris", "/mån");
 *   3. index-card text — the same reading applied to the card the item was
 *      discovered in (weaker provenance, recorded as such).
 *
 * Anti-fabrication rules:
 *   - a number is only ever a price when the page marks it as one (currency
 *     token, money multiplier, or an explicit price label);
 *   - phone numbers, postal codes, years, reference/article numbers, areas,
 *     room counts, power, mileage and percentages are never prices;
 *   - a currency is never guessed from a bare number unless the page's own
 *     market states it, and that downgrades confidence;
 *   - when several unlabelled, equally plausible values compete, the result is
 *     UNKNOWN with a reason — never a coin flip.
 */
import { marketOfHost } from "./geo";

export type PriceType =
  | "asking_price"
  | "starting_price"
  | "sale_price"
  | "original_price"
  | "current_price"
  | "auction_price"
  | "monthly_price"
  | "rent"
  | "fee"
  | "unknown";

export type PriceSourceLocation =
  | "structured_data"
  | "meta"
  | "detail_field"
  | "page_text"
  | "index_card"
  | "semantic_model";

/** Canonical internal price shape used by the rest of the pipeline. */
export interface ExtractedPrice {
  amount: number;
  /** ISO-4217, or null when the page never stated one. */
  currency: string | null;
  original_text: string;
  price_type: PriceType;
  /** 0–1, from source strength, labelling and currency certainty. */
  confidence: number;
  evidence: string;
  source_location: PriceSourceLocation;
}

export interface PriceExtractionResult {
  /** The value the pipeline should use, or null when nothing is certain. */
  primary: ExtractedPrice | null;
  /** Every price the page states, including fees, rents and former prices. */
  all: ExtractedPrice[];
  /** Present when no primary price could be established, explaining why. */
  reason?: string;
}

/* ------------------------------------------------------------------ *
 * Vocabulary (market-level, never site-level)
 * ------------------------------------------------------------------ */

const CURRENCY_BY_TOKEN: Record<string, string> = {
  kr: "SEK", // refined by market below
  sek: "SEK",
  nok: "NOK",
  dkk: "DKK",
  isk: "ISK",
  eur: "EUR",
  usd: "USD",
  gbp: "GBP",
  chf: "CHF",
  jpy: "JPY",
  pln: "PLN",
  czk: "CZK",
  huf: "HUF",
  cad: "CAD",
  aud: "AUD",
  nzd: "NZD",
  aed: "AED",
  inr: "INR",
  "€": "EUR",
  $: "USD",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  "kč": "CZK",
  "zł": "PLN",
  ":-": "SEK",
};

const CURRENCY_ALT = "sek|nok|dkk|isk|eur|usd|gbp|chf|jpy|pln|czk|huf|cad|aud|nzd|aed|inr|kr|:-|€|\\$|£|¥|₹|kč|zł";

const MULTIPLIERS: { token: string; factor: number }[] = [
  { token: "mdkr", factor: 1e9 },
  { token: "miljarder", factor: 1e9 },
  { token: "miljard", factor: 1e9 },
  { token: "mnkr", factor: 1e6 },
  { token: "msek", factor: 1e6 },
  { token: "meur", factor: 1e6 },
  { token: "musd", factor: 1e6 },
  { token: "mkr", factor: 1e6 },
  { token: "miljoner", factor: 1e6 },
  { token: "miljon", factor: 1e6 },
  { token: "mio", factor: 1e6 },
  { token: "mn", factor: 1e6 },
  { token: "m", factor: 1e6 },
  { token: "tsek", factor: 1e3 },
  { token: "tkr", factor: 1e3 },
  { token: "tusen", factor: 1e3 },
  { token: "k", factor: 1e3 },
];

const MULT_ALT = MULTIPLIERS.map((m) => m.token).join("|");

/** Words that introduce a price, mapped to what kind of price it is. */
const PRICE_LABELS: { re: RegExp; type: PriceType }[] = [
  { re: /(utgångspris|utgangspris|startpris|budstart|bud\s*från|from\s+only|starting\s+(?:at|price)|ab\s+preis)/i, type: "starting_price" },
  { re: /(accepterat\s*pris|begärt\s*pris|begart\s*pris|asking\s*price|prisid[ée]|förhandspris)/i, type: "asking_price" },
  { re: /(slutpris|såld\s*för|sold\s*for|hammer\s*price|auktion|auction|budgivning|current\s*bid|högsta\s*bud)/i, type: "auction_price" },
  { re: /(ord(?:inarie)?\.?\s*pris|tidigare\s*pris|f[öo]rr|was\b|list\s*price|rek\.?\s*pris|jämförpris)/i, type: "original_price" },
  { re: /(\brea(?:pris)?\b|nu\s*(?:endast|bara)?|kampanjpris|erbjudande|sale\s*price|now\b|discounted)/i, type: "sale_price" },
  { re: /(hyra|hyres(?:kostnad)?|månadshyra|rent\b|per\s*month|\/\s*m[åa]n|\/\s*mo\b|kr\/m[åa]n)/i, type: "rent" },
  { re: /(månadsavgift|m[åa]nadsavg|avgift|driftkostnad|driftskostnad|service\s*charge|monthly\s*fee|hoa)/i, type: "fee" },
  { re: /(pris|price|preis|prix|precio|prezzo|prijs|koster|cost)/i, type: "asking_price" },
];

/** Wording after a value that makes it periodic rather than a total. */
const PERIODIC_AFTER = /^\s*(?:\/\s*(?:m[åa]n(?:ad)?|mo|month|mth|år|year|vecka|week|dag|day|natt|night)|per\s+(?:m[åa]nad|month|år|year|vecka|week|dygn|natt)|\/\s?m[²2]|m[åa]n(?:ad)?\b)/i;

/**
 * Numeric attributes that are emphatically NOT prices. Checked as the unit
 * written directly after the number, and as the label written before it.
 */
const NON_PRICE_UNIT_AFTER =
  /^\s*(?:kvm|kvadratmeter|m²|m2|sqm|sq\s?ft|ft²|rum|rok|r\.o\.k|hk|hp|bhp|kw|nm|km\/h|mph|km|mil\b|miles|mi\b|tum|mm|cm|st\b|kg|g\b|liter|l\b|%|år\b|years?\b|hastigheter|watt|w\b|ah|kwh|mah|px|dpi|mm\b)/i;

const NON_PRICE_LABEL_BEFORE =
  /(telefon|tel\.?|mobil|phone|kontakt(?:a)?|ring\b|fax|postnummer|post\s*nr|postal\s*code|zip|org\.?\s*nr|organisationsnummer|person\s*nr|vin\b|chassi(?:nummer)?|serienummer|serial|referens(?:nummer)?|reference|ref\.?\s*nr|artikel(?:nummer)?|art\.?\s*nr|sku|ean|isbn|gtin|objekt(?:s?nummer|id)|annons(?:id|nummer)|modell(?:nummer)?|model\s*(?:no|number)|årsmodell|modellår|model\s*year|byggår|registreringsnummer|reg\.?\s*nr|boarea|boyta|yta|area|storlek|[a-zåäöé]*nummer|andel(?:stal)?|f[öo]reningen|insats|nettoskuld|antal\s*rum|rum\b|våning|floor|miltal|mätarställning|mileage|effekt|hästkrafter|bredd|höjd|längd|vikt|weight|zoom|kod|code)\s*[:：\-–—]?\s*$/i;

const PHONE_LIKE = /(?:\+\d{1,3}[\s-]?)?(?:0\d{1,3}[\s-]?)\d{2,3}[\s-]?\d{2}[\s-]?\d{2}$/;

/* ------------------------------------------------------------------ *
 * Number parsing
 * ------------------------------------------------------------------ */

/** Parse the numeric part of a money token, honouring a multiplier suffix. */
export function parseMoneyNumber(raw: string, multiplier = 1): number | null {
  let token = raw.replace(/[\s\u00a0']/g, "");
  if (!/\d/.test(token)) return null;
  const commas = (token.match(/,/g) ?? []).length;
  const dots = (token.match(/\./g) ?? []).length;

  if (multiplier > 1) {
    // With a multiplier a single separator is always decimal: "3,495 Mkr".
    if (commas + dots === 1) token = token.replace(",", ".");
    else token = token.replace(/[.,](?=\d{3}\b)/g, "").replace(",", ".");
  } else if (commas > 0 && dots > 0) {
    if (token.lastIndexOf(",") > token.lastIndexOf(".")) token = token.replace(/\./g, "").replace(",", ".");
    else token = token.replace(/,/g, "");
  } else if (commas > 0 || dots > 0) {
    const sep = commas > 0 ? "," : ".";
    const parts = token.split(sep);
    const tail = parts[parts.length - 1]!;
    // "3.495.000" and "3,495,000" are group separators; "1234,50" is decimal.
    if (parts.length > 2 || tail.length === 3) token = token.split(sep).join("");
    else token = `${parts.slice(0, -1).join("")}.${tail}`;
  }
  const value = Number(token);
  if (!Number.isFinite(value)) return null;
  return value * multiplier;
}

function multiplierFor(token: string | undefined): number {
  if (!token) return 1;
  const t = token.toLowerCase().replace(/\./g, "");
  return MULTIPLIERS.find((m) => m.token === t)?.factor ?? 1;
}

function currencyFor(token: string | undefined, marketCurrency: string | null): string | null {
  if (!token) return null;
  const t = token.toLowerCase();
  if ((t === "kr" || t === ":-") && marketCurrency && ["SEK", "NOK", "DKK", "ISK"].includes(marketCurrency)) {
    return marketCurrency;
  }
  return CURRENCY_BY_TOKEN[t] ?? null;
}

/** The currency a page's own market uses — supporting evidence only. */
export function marketCurrencyForUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const market = marketOfHost(new URL(url).hostname);
    return market?.currencies[0] ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Text scanning
 * ------------------------------------------------------------------ */

const NUMBER = "\\d{1,3}(?:[ \\u00a0.,']\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,3})?";

const MULT_END = "(?![A-Za-zÅÄÖåäöÜü])";
const SUFFIX_RE = new RegExp(`(${NUMBER})\\s*(${MULT_ALT})?${MULT_END}\\s*(${CURRENCY_ALT})`, "gi");
const PREFIX_RE = new RegExp(`(${CURRENCY_ALT})\\s*(${NUMBER})\\s*(${MULT_ALT})?${MULT_END}`, "gi");
const BARE_RE = new RegExp(`(${NUMBER})\\s*(${MULT_ALT})?${MULT_END}`, "gi");

interface RawHit {
  start: number;
  end: number;
  text: string;
  amount: number;
  currency: string | null;
  /** The page marked this number as money (currency token or multiplier). */
  monetary: boolean;
  labelled: boolean;
}

/**
 * The price label closest before a value decides what kind of price it is.
 * When a specific label ("utgångspris") overlaps the generic one ("pris"),
 * the specific reading wins.
 */
function labelBefore(text: string, at: number): { type: PriceType; word: string } | null {
  const window = text.slice(Math.max(0, at - 42), at);
  const found: { type: PriceType; word: string; start: number; end: number; rank: number }[] = [];
  PRICE_LABELS.forEach(({ re, type }, rank) => {
    const m = window.match(new RegExp(re.source, "gi"));
    if (!m) return;
    const word = m[m.length - 1]!;
    const start = window.lastIndexOf(word);
    found.push({ type, word: word.trim(), start, end: start + word.length, rank });
  });
  if (found.length === 0) return null;
  const nearest = found.reduce((a, b) => (b.end > a.end ? b : a));
  const overlapping = found.filter((f) => f.start < nearest.end && f.end > nearest.start);
  const best = overlapping.reduce((a, b) => (b.rank < a.rank ? b : a), nearest);
  return { type: best.type, word: best.word };
}

function rejected(text: string, hit: { start: number; end: number; text: string }, hasCurrency: boolean): boolean {
  const after = text.slice(hit.end, hit.end + 14);
  if (!hasCurrency && NON_PRICE_UNIT_AFTER.test(after)) return true;
  const before = text.slice(Math.max(0, hit.start - 40), hit.start);
  if (NON_PRICE_LABEL_BEFORE.test(before)) return true;
  const digits = hit.text.replace(/\D/g, "");
  if (!hasCurrency) {
    // A bare four-digit year, a postal code or a phone number is not a price.
    if (/^(?:19|20)\d{2}$/.test(hit.text.trim())) return true;
    if (digits.length < 3) return true;
    if (PHONE_LIKE.test(`${before.trim().slice(-6)}${hit.text}`.replace(/\s+/g, " ").trim())) return true;
  }
  // Registration and organisation numbers are written as digit groups joined
  // by a hyphen or slash: "559201-4798", "1202-3".
  if (/\d\s*[-/]\s*$/.test(text.slice(Math.max(0, hit.start - 8), hit.start))) return true;
  if (!hasCurrency && /^\s*[-/]\s*\d/.test(after)) return true;
  // Reference/part numbers glue letters to digits: "EPY76G", "126610LN".
  if (/[A-Za-z]$/.test(text.slice(Math.max(0, hit.start - 1), hit.start))) return true;
  if (/^[A-Za-z]/.test(text.slice(hit.end, hit.end + 1)) && !hasCurrency) return true;
  return false;
}

function overlaps(hits: RawHit[], start: number, end: number): boolean {
  return hits.some((h) => start < h.end && end > h.start);
}

export interface TextPriceOptions {
  /** URL the text was read from; used only for market currency support. */
  url?: string | null;
  /** Currency the surrounding market uses, when the page states none. */
  marketCurrency?: string | null;
  sourceLocation?: PriceSourceLocation;
}

/** Every price literally written in a block of text, with its semantics. */
export function extractPricesFromText(text: string, options: TextPriceOptions = {}): ExtractedPrice[] {
  if (!text) return [];
  const clean = text.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const marketCurrency = options.marketCurrency ?? marketCurrencyForUrl(options.url ?? null);
  const location = options.sourceLocation ?? "page_text";
  const hits: RawHit[] = [];

  const push = (start: number, end: number, numeric: string, mult: string | undefined, cur: string | undefined) => {
    if (overlaps(hits, start, end)) return;
    const raw = clean.slice(start, end).trim();
    const factor = multiplierFor(mult);
    if (rejected(clean, { start, end, text: numeric }, !!cur || factor > 1)) return;
    const amount = parseMoneyNumber(numeric, factor);
    if (amount === null || amount <= 0) return;
    // A ratio like "0,8927" is not money unless the page writes a currency.
    if (!cur && factor === 1 && !Number.isInteger(amount)) return;
    hits.push({
      start,
      end,
      text: raw,
      amount,
      // A money multiplier ("Mkr", "tkr", "MSEK") states the currency family
      // itself; a bare "M"/"k" only states magnitude.
      currency: currencyFor(cur, marketCurrency) ?? (/(kr|sek|eur|usd)$/i.test(mult ?? "") ? marketCurrency : null),
      monetary: !!cur || factor > 1,
      labelled: !!labelBefore(clean, start),
    });
  };

  for (const m of clean.matchAll(SUFFIX_RE)) push(m.index!, m.index! + m[0].length, m[1]!, m[2], m[3]);
  for (const m of clean.matchAll(PREFIX_RE)) push(m.index!, m.index! + m[0].length, m[2]!, m[3], m[1]);
  for (const m of clean.matchAll(BARE_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (overlaps(hits, start, end)) continue;
    const label = labelBefore(clean, start);
    const mult = multiplierFor(m[2]);
    // A bare number is only a price when the page labels it as one, or when a
    // money multiplier ("3,5 Mkr") makes it unmistakably monetary.
    if (!label && mult === 1) continue;
    push(start, end, m[1]!, m[2], undefined);
  }

  hits.sort((a, b) => a.start - b.start);
  return hits.map((hit) => {
    const label = labelBefore(clean, hit.start);
    const after = clean.slice(hit.end, hit.end + 18);
    const periodic = PERIODIC_AFTER.test(after);
    let type: PriceType = label?.type ?? "unknown";
    if (periodic && type !== "fee") type = type === "rent" ? "rent" : "monthly_price";
    if (type === "unknown" && hit.monetary) type = "current_price";

    const currency = hit.currency ?? (label || hit.monetary ? marketCurrency : null);
    const inferredCurrency = !hit.currency && !!currency;

    let confidence = 0.5;
    if (hit.currency && label) confidence = 0.96;
    else if (hit.currency) confidence = 0.9;
    else if (label || hit.monetary) confidence = 0.8;
    if (inferredCurrency) confidence -= 0.06;
    if (location === "index_card") confidence -= 0.15;

    const contextStart = Math.max(0, hit.start - 32);
    const evidence = clean.slice(contextStart, Math.min(clean.length, hit.end + 12)).trim();

    return {
      amount: hit.amount,
      currency,
      original_text: hit.text,
      price_type: type,
      confidence: Number(Math.max(0.3, Math.min(0.99, confidence)).toFixed(2)),
      evidence: evidence.slice(0, 160),
      source_location: location,
    } satisfies ExtractedPrice;
  });
}

/* ------------------------------------------------------------------ *
 * Structured data
 * ------------------------------------------------------------------ */

const STRUCTURED_AMOUNT_KEYS = [
  "price",
  "pricecurrency:price",
  "lowprice",
  "offers",
  "price:amount",
  "product:price:amount",
  "og:price:amount",
  "highprice",
  "salesprice",
  "amount",
];

const STRUCTURED_CURRENCY_KEYS = [
  "pricecurrency",
  "currency",
  "price:currency",
  "product:price:currency",
  "og:price:currency",
];

/**
 * Read a price out of schema.org / OpenGraph / meta / microdata style data.
 * These maps are already flattened by the enrichment layer.
 */
export function extractPriceFromStructured(
  fields: Record<string, string> | undefined,
  options: TextPriceOptions = {},
): ExtractedPrice | null {
  if (!fields) return null;
  const lower = new Map(Object.entries(fields).map(([k, v]) => [k.toLowerCase(), String(v)]));
  let rawAmount: string | null = null;
  let key: string | null = null;
  for (const k of STRUCTURED_AMOUNT_KEYS) {
    const value = lower.get(k);
    if (value && /\d/.test(value)) {
      rawAmount = value.trim();
      key = k;
      break;
    }
  }
  if (!rawAmount || !key) return null;
  const amount = parseMoneyNumber(rawAmount.replace(/[^\d.,\s]/g, ""));
  if (amount === null || amount <= 0) return null;

  let currency: string | null = null;
  for (const k of STRUCTURED_CURRENCY_KEYS) {
    const value = lower.get(k)?.trim();
    if (value && /^[A-Za-z]{3}$/.test(value)) {
      currency = value.toUpperCase();
      break;
    }
  }
  if (!currency) {
    const inline = rawAmount.match(new RegExp(`(${CURRENCY_ALT})`, "i"))?.[1];
    currency = currencyFor(inline, options.marketCurrency ?? marketCurrencyForUrl(options.url ?? null));
  }
  const inferred = !currency;
  if (!currency) currency = options.marketCurrency ?? marketCurrencyForUrl(options.url ?? null);

  return {
    amount,
    currency,
    original_text: currency && !/[A-Za-z]/.test(rawAmount) ? `${rawAmount} ${currency}` : rawAmount,
    price_type: key === "lowprice" ? "starting_price" : "asking_price",
    confidence: inferred ? 0.93 : 0.99,
    evidence: `${key} = ${rawAmount}`,
    source_location: "structured_data",
  };
}

/** Labelled spec fields ("Utgångspris" -> "3 495 000 kr"). */
export function extractPriceFromFields(
  fields: Record<string, string> | undefined,
  options: TextPriceOptions = {},
): ExtractedPrice[] {
  if (!fields) return [];
  const out: ExtractedPrice[] = [];
  for (const [label, value] of Object.entries(fields)) {
    if (!value || !/\d/.test(value)) continue;
    if (NON_PRICE_LABEL_BEFORE.test(`${label.replace(/[:：\s]+$/, "")}:`)) continue;
    if (!PRICE_LABELS.some(({ re }) => re.test(label))) continue;
    const prices = extractPricesFromText(`${label}: ${value}`, { ...options, sourceLocation: "detail_field" });
    for (const p of prices) out.push({ ...p, confidence: Math.min(0.98, p.confidence + 0.02) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

const PURCHASE_TYPES: PriceType[] = [
  "sale_price",
  "current_price",
  "asking_price",
  "starting_price",
  "auction_price",
  "unknown",
];

const TYPE_RANK: Record<PriceType, number> = {
  sale_price: 6,
  asking_price: 6,
  current_price: 5,
  starting_price: 5,
  auction_price: 5,
  original_price: 2,
  unknown: 3,
  monthly_price: 1,
  rent: 1,
  fee: 0,
};

/** Choose the one value that represents what the item costs. */
export function selectPrimaryPrice(prices: ExtractedPrice[]): { primary: ExtractedPrice | null; reason?: string } {
  if (prices.length === 0) return { primary: null, reason: "no price stated on the page" };
  const purchase = prices.filter((p) => PURCHASE_TYPES.includes(p.price_type));
  if (purchase.length === 0) {
    // A rental object states a rent and nothing else — that IS its price.
    const rent = prices.find((p) => p.price_type === "rent" || p.price_type === "monthly_price");
    if (rent) return { primary: rent };
    return { primary: null, reason: "only fees and secondary values were stated" };
  }
  // A sale price supersedes the original price it is discounted from.
  const sale = purchase.find((p) => p.price_type === "sale_price");
  if (sale) return { primary: sale };

  const ranked = [...purchase].sort(
    (a, b) =>
      TYPE_RANK[b.price_type] - TYPE_RANK[a.price_type] ||
      b.confidence - a.confidence ||
      b.amount - a.amount,
  );
  const best = ranked[0]!;
  const rivals = ranked.filter(
    (p) => p !== best && p.amount !== best.amount && p.confidence >= best.confidence && TYPE_RANK[p.price_type] === TYPE_RANK[best.price_type],
  );
  if (rivals.length > 0 && best.price_type === "unknown") {
    return {
      primary: null,
      reason: `several unlabelled values compete (${[best, ...rivals].map((p) => p.original_text).join(" / ")})`,
    };
  }
  return { primary: best };
}

export interface PriceSourceInput {
  url?: string | null;
  /** Flattened structured signals (JSON-LD + OpenGraph + meta + microdata). */
  structured?: Record<string, string> | undefined;
  /** Labelled spec fields from the page. */
  fields?: Record<string, string> | undefined;
  /** Readable page text of the item's own page. */
  text?: string | null;
  /** Verbatim text of the index card the item was discovered in. */
  cardText?: string | null;
  /** Explicit market currency override (radar market). */
  marketCurrency?: string | null;
}

/**
 * Full price pipeline for one item: structured data, then labelled fields,
 * then page text, then — only as a last resort — the index card.
 */
export function extractPrice(input: PriceSourceInput): PriceExtractionResult {
  const options: TextPriceOptions = {
    url: input.url ?? null,
    marketCurrency: input.marketCurrency ?? marketCurrencyForUrl(input.url ?? null),
  };
  const all: ExtractedPrice[] = [];

  const structured = extractPriceFromStructured(input.structured, options);
  if (structured) all.push(structured);
  all.push(...extractPriceFromFields(input.fields, options));
  if (input.text) all.push(...extractPricesFromText(input.text, { ...options, sourceLocation: "page_text" }));

  let result = selectPrimaryPrice(all);
  if (!result.primary && input.cardText) {
    const card = extractPricesFromText(input.cardText, { ...options, sourceLocation: "index_card" });
    all.push(...card);
    const fromCard = selectPrimaryPrice(card);
    if (fromCard.primary) result = fromCard;
  }

  return result.primary
    ? { primary: result.primary, all }
    : { primary: null, all, reason: result.reason ?? "no price could be established" };
}

/** One-line, human-readable explanation for the verification panel. */
export function explainPrice(price: ExtractedPrice): string {
  const where =
    price.source_location === "structured_data"
      ? "page structured data"
      : price.source_location === "detail_field"
        ? "labelled page field"
        : price.source_location === "index_card"
          ? "listing card on the index page"
          : "semantic page extraction";
  return `${price.amount.toLocaleString("en-US")} ${price.currency ?? "?"} · source: ${where} · evidence: "${price.evidence}" · confidence ${price.confidence}`;
}
