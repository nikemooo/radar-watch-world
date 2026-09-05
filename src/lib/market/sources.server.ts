/**
 * Market data collection — multi-source with consensus.
 *
 * Priority order is deliberate:
 *   1. Structured free feeds (Stooq for stocks/indexes/commodities/forex,
 *      Frankfurter for forex, CoinGecko for crypto) — cheap, reliable,
 *      machine-readable.
 *   2. Web search as FALLBACK ONLY — when no structured source covers the
 *      instrument (housing statistics, niche series, unusual instruments),
 *      one bounded search plus one AI extraction produces the datapoint.
 *
 * When several sources answer, values are verified against each other:
 * agreement within a tolerance marks the datapoint VERIFIED; disagreement
 * keeps it PROBABLE and the observation records the spread.
 */
import { MODELS, chatJson } from "../ai/gateway.server";
import { researchQueries } from "../search/providers.server";
import type { MarketInstrument, MarketMonitorSpec } from "./types";

export interface SourceQuote {
  source: string;
  sourceUrl: string;
  value: number;
  currency: string | null;
  unit: string | null;
  /** ISO timestamp of when the SOURCE says the value was observed. */
  observedAt: string;
}

export interface SourceAttempt {
  source: string;
  ok: boolean;
  error?: string;
}

export interface CollectionResult {
  quotes: SourceQuote[];
  attempts: SourceAttempt[];
  provider: string | null;
  searchRequests: number;
  searchSuccesses: number;
  searchFailures: number;
  costEstimate: number;
}

export interface Consensus {
  value: number;
  /** Median-based middle quote — the value's provenance. */
  quote: SourceQuote;
  quotes: SourceQuote[];
  status: "VERIFIED" | "PROBABLE";
  confidence: number;
  spreadPct: number | null;
}

const FETCH_TIMEOUT_MS = 8000;
const MEDIAN_TOLERANCE_PCT = 1;

function validIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Verify sources against each other and pick the consensus value (median). */
export function consensusFromQuotes(quotes: SourceQuote[]): Consensus | null {
  const usable = quotes.filter((q) => Number.isFinite(q.value));
  if (usable.length === 0) return null;
  if (usable.length === 1) {
    return { value: usable[0]!.value, quote: usable[0]!, quotes: usable, status: "PROBABLE", confidence: 0.55, spreadPct: null };
  }
  const mid = median(usable.map((q) => q.value));
  const reference = Math.max(Math.abs(mid), 1e-12);
  let maxSpread = 0;
  for (const q of usable) maxSpread = Math.max(maxSpread, Math.abs(q.value - mid));
  const spreadPct = (maxSpread / reference) * 100;
  const verified = spreadPct <= MEDIAN_TOLERANCE_PCT;
  return {
    value: mid,
    quote: usable.reduce((best, q) =>
      Math.abs(q.value - mid) < Math.abs(best.value - mid) ? q : best,
    ),
    quotes: usable,
    status: verified ? "VERIFIED" : "PROBABLE",
    confidence: verified ? Math.min(0.95, 0.7 + usable.length * 0.06) : Math.max(0.4, 0.6 - spreadPct / 50),
    spreadPct,
  };
}

/** The Stooq ticker to try: explicit mapping first, base+quote derivation for forex. */
export function stooqSymbolFor(instrument: MarketInstrument): string | null {
  if (instrument.stooq_symbol) return instrument.stooq_symbol;
  if (instrument.kind === "forex" && instrument.base_currency && instrument.quote_currency) {
    return `${instrument.base_currency}${instrument.quote_currency}`.toLowerCase();
  }
  return null;
}

function parseStooqCsv(csv: string): { close: number; date: string; time: string } | null {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cells = lines[1]!.split(",");
  // Symbol,Date,Time,Open,High,Low,Close,Volume
  if (cells.length < 7) return null;
  const closeRaw = cells[6]?.trim();
  if (!closeRaw || closeRaw === "N/D") return null;
  const close = Number(closeRaw);
  if (!Number.isFinite(close)) return null;
  return { close, date: cells[1]?.trim() ?? "", time: cells[2]?.trim() ?? "" };
}

async function stooqFetch(symbol: string): Promise<{ close: number; date: string; time: string } | null> {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  return parseStooqCsv(await res.text());
}

async function stooqQuote(symbol: string, instrument: MarketInstrument): Promise<SourceQuote | null> {
  const toQuote = (sym: string, value: number): SourceQuote => ({
    source: "stooq",
    sourceUrl: `https://stooq.com/q/?s=${encodeURIComponent(sym)}`,
    value,
    currency: instrument.currency,
    unit: instrument.unit,
    observedAt: new Date().toISOString(),
  });
  const direct = await stooqFetch(symbol);
  if (direct) return toQuote(symbol, direct.close);
  // Stooq lists most forex pairs in one direction only — try the inverse.
  if (instrument.kind === "forex" && instrument.base_currency && instrument.quote_currency) {
    const invertedSymbol = `${instrument.quote_currency}${instrument.base_currency}`.toLowerCase();
    if (invertedSymbol !== symbol) {
      const inverted = await stooqFetch(invertedSymbol);
      if (inverted && inverted.close !== 0) return toQuote(invertedSymbol, 1 / inverted.close);
    }
  }
  return null;
}

async function frankfurterQuote(base: string, quote: string): Promise<SourceQuote | null> {
  const url = `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(quote)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`frankfurter HTTP ${res.status}`);
  const json = (await res.json()) as { date?: string; rates?: Record<string, number> };
  const value = json.rates?.[quote];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return {
    source: "frankfurter",
    sourceUrl: url,
    value,
    currency: quote,
    unit: null,
    observedAt: validIso(json.date ? `${json.date}T00:00:00Z` : null) ?? new Date().toISOString(),
  };
}

async function coingeckoQuote(
  id: string,
  vsCurrency: string,
  instrument: MarketInstrument,
): Promise<SourceQuote | null> {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(vsCurrency)}&include_last_updated_at=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, Record<string, number | undefined> | undefined>;
  const entry = json[id];
  const value = entry?.[vsCurrency];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const updated = entry?.["last_updated_at"];
  return {
    source: "coingecko",
    sourceUrl: `https://www.coingecko.com/en/coins/${encodeURIComponent(id)}`,
    value,
    currency: vsCurrency.toUpperCase(),
    unit: instrument.unit,
    observedAt: typeof updated === "number" ? new Date(updated * 1000).toISOString() : new Date().toISOString(),
  };
}

/** Yahoo Finance — covers stocks, indices, commodities, forex and crypto. */
async function yahooSourceQuote(
  symbol: string,
  instrument: MarketInstrument,
): Promise<SourceQuote | null> {
  const quote = await yahooQuote(symbol);
  if (!quote) return null;
  return {
    source: "yahoo",
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
    value: quote.value,
    currency: quote.currency ?? instrument.currency,
    unit: instrument.unit,
    observedAt: quote.observedAt,
  };
}

/** Binance — second independent crypto feed, keyless. */
async function binanceQuote(
  base: string,
  instrument: MarketInstrument,
): Promise<SourceQuote | null> {
  const pair = `${base.toUpperCase()}USDT`;
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`binance HTTP ${res.status}`);
  const json = (await res.json()) as { price?: string };
  const value = Number(json.price);
  if (!Number.isFinite(value)) return null;
  return {
    source: "binance",
    sourceUrl: `https://www.binance.com/en/trade/${pair}`,
    value,
    currency: "USD",
    unit: instrument.unit,
    observedAt: new Date().toISOString(),
  };
}

interface WebQuoteResult {
  quote: SourceQuote | null;
  cost: number;
  requests: number;
  successes: number;
  failures: number;
  error?: string;
}

/** Fallback: bounded web search + AI extraction of the current datapoint. */
async function webSearchQuote(instrument: MarketInstrument, rawRequest: string): Promise<WebQuoteResult> {
  const query = `${instrument.name} ${instrument.metric.replace(/_/g, " ")} current value today`;
  const research = await researchQueries([query], 5, 1);
  const base = {
    cost: research.costEstimate,
    requests: research.requests,
    successes: research.successes,
    failures: research.failures,
  };
  if (!research.configured || research.documents.length === 0) {
    return { ...base, quote: null, error: research.errors.join(" | ") || "no search results" };
  }
  const docs = research.documents.slice(0, 5);
  try {
    const extracted = await chatJson<{
      value: number | null;
      currency: string | null;
      unit: string | null;
      observed_at: string | null;
      source_url: string | null;
      source_name: string | null;
    }>({
      model: MODELS.fast,
      schemaName: "market_datapoint",
      schema: {
        type: "object",
        properties: {
          value: { type: ["number", "null"] },
          currency: { type: ["string", "null"] },
          unit: { type: ["string", "null"] },
          observed_at: { type: ["string", "null"] },
          source_url: { type: ["string", "null"] },
          source_name: { type: ["string", "null"] },
        },
        required: ["value", "currency", "unit", "observed_at", "source_url", "source_name"],
        additionalProperties: false,
      },
      system:
        "Extract the CURRENT numeric market datapoint for the requested instrument from these search results. Rules: the value must be the actual current level of the requested metric (an exchange rate, a share price, an index level), never a change, percentage, forecast or target. If results disagree, prefer the most recent and most authoritative. If no result contains a genuine current value, return value null. Never invent a number.",
      user: [
        `Instrument: ${instrument.symbol} (${instrument.name})`,
        `Metric: ${instrument.metric}`,
        `Expected currency: ${instrument.currency ?? "unknown"}`,
        `Expected unit: ${instrument.unit ?? "unknown"}`,
        `Original request: ${rawRequest}`,
        "",
        "Results:",
        ...docs.map(
          (d, i) =>
            `[${i + 1}] ${d.title}\nURL: ${d.url}\nRetrieved: ${d.retrieved_at}\n${d.snippet.slice(0, 1200)}`,
        ),
      ].join("\n"),
    });
    if (extracted.value === null || !Number.isFinite(extracted.value)) {
      return { ...base, quote: null, error: "no current datapoint found in search results" };
    }
    return {
      ...base,
      cost: base.cost + 0.001,
      quote: {
        source: extracted.source_name ?? hostOf(extracted.source_url) ?? "web",
        sourceUrl: extracted.source_url ?? docs[0]!.url,
        value: extracted.value,
        currency: extracted.currency?.toUpperCase() ?? instrument.currency,
        unit: extracted.unit ?? instrument.unit,
        observedAt: validIso(extracted.observed_at) ?? new Date().toISOString(),
      },
    };
  } catch (err) {
    return { ...base, quote: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** One AI call that fills in the structured-source tickers the interpreter left blank. */
export async function refineInstrumentSources(spec: MarketMonitorSpec): Promise<MarketMonitorSpec> {
  const inst = spec.instrument;
  const wantsStooq =
    !inst.stooq_symbol &&
    (inst.kind === "stock" || inst.kind === "index" || inst.kind === "commodity" || inst.kind === "other");
  const wantsCoingecko = !inst.coingecko_id && inst.kind === "crypto";
  if (!wantsStooq && !wantsCoingecko) return spec;
  try {
    const resolved = await chatJson<{ stooq_symbol: string | null; coingecko_id: string | null }>({
      model: MODELS.fast,
      schemaName: "market_instrument_sources",
      schema: {
        type: "object",
        properties: {
          stooq_symbol: { type: ["string", "null"] },
          coingecko_id: { type: ["string", "null"] },
        },
        required: ["stooq_symbol", "coingecko_id"],
        additionalProperties: false,
      },
      system:
        "Map a financial instrument to free structured data source tickers. stooq_symbol: the Stooq ticker, lowercase (US stocks 'nvda.us', forex 'usdeur', gold 'xauusd', S&P 500 '^spx', Nasdaq 100 '^ndx', bitcoin 'btcusd'). null when you are not confident it exists on Stooq. coingecko_id: the CoinGecko asset id for cryptocurrencies ('bitcoin', 'ethereum'); null otherwise. Never invent a ticker — null is better than wrong.",
      user: JSON.stringify(inst),
    });
    return {
      ...spec,
      instrument: {
        ...inst,
        stooq_symbol: inst.stooq_symbol ?? resolved.stooq_symbol,
        coingecko_id: inst.coingecko_id ?? resolved.coingecko_id,
      },
    };
  } catch {
    return spec;
  }
}

/** Collect quotes from every applicable structured source; web search only when all fail. */
export async function collectMarketQuotes(
  spec: MarketMonitorSpec,
  options: { allowWebSearch: boolean; rawRequest: string },
): Promise<CollectionResult> {
  const inst = spec.instrument;
  const tasks: { source: string; run: () => Promise<SourceQuote | null> }[] = [];
  const stooqSym = stooqSymbolFor(inst);
  if (stooqSym) tasks.push({ source: "stooq", run: () => stooqQuote(stooqSym, inst) });
  const baseCurrency = inst.base_currency;
  const quoteCurrency = inst.quote_currency;
  if (inst.kind === "forex" && baseCurrency && quoteCurrency) {
    tasks.push({ source: "frankfurter", run: () => frankfurterQuote(baseCurrency, quoteCurrency) });
  }
  if (inst.coingecko_id) {
    tasks.push({
      source: "coingecko",
      run: () => coingeckoQuote(inst.coingecko_id!, (inst.currency ?? "usd").toLowerCase(), inst),
    });
  }
  // Yahoo covers every instrument kind and is the redundancy that keeps a
  // radar alive when Stooq blocks or a single API rate-limits.
  const yahooSym = yahooSymbolFor(inst);
  if (yahooSym) tasks.push({ source: "yahoo", run: () => yahooSourceQuote(yahooSym, inst) });
  if (inst.kind === "crypto") {
    const cryptoBase = (inst.base_currency ?? inst.symbol.split(/[\/-]/)[0] ?? "").trim();
    if (/^[A-Za-z]{2,6}$/.test(cryptoBase)) {
      tasks.push({ source: "binance", run: () => binanceQuote(cryptoBase, inst) });
    }
  }

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  const quotes: SourceQuote[] = [];
  const attempts: SourceAttempt[] = [];
  settled.forEach((result, i) => {
    const source = tasks[i]!.source;
    if (result.status === "fulfilled" && result.value) {
      quotes.push(result.value);
      attempts.push({ source, ok: true });
    } else {
      const error = result.status === "rejected" ? String(result.reason).slice(0, 200) : "no data";
      // Server-side visibility: which provider failed, for which instrument, why.
      console.warn(
        `[market-data] ${inst.symbol} (${inst.kind}) source=${source} failed: ${error}`,
      );
      attempts.push({ source, ok: false, error });
    }
  });

  let provider = quotes.length > 0 ? quotes.map((q) => q.source).join("+") : null;
  let searchRequests = 0;
  let searchSuccesses = 0;
  let searchFailures = 0;
  let costEstimate = 0;

  if (quotes.length === 0 && options.allowWebSearch) {
    const web = await webSearchQuote(inst, options.rawRequest);
    costEstimate += web.cost;
    searchRequests += web.requests;
    searchSuccesses += web.successes;
    searchFailures += web.failures;
    if (web.quote) {
      quotes.push(web.quote);
      attempts.push({ source: web.quote.source, ok: true });
      provider = `web:${web.quote.source}`;
    } else {
      attempts.push({ source: "web_search", ok: false, ...(web.error ? { error: web.error } : {}) });
    }
  }

  return {
    quotes,
    attempts,
    provider,
    searchRequests,
    searchSuccesses,
    searchFailures,
    costEstimate: Number(costEstimate.toFixed(4)),
  };
}
