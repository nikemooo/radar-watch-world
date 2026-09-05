/**
 * Yahoo Finance chart feed — the redundant market-data source.
 *
 * Why it exists: Stooq's quote endpoint (`/q/l/`) now answers 404 and its
 * daily CSV endpoint is behind a JS bot-check, so every stock, index,
 * commodity and forex radar lost its structured source at once. Yahoo's chart
 * endpoint covers all of those AND crypto, with intraday resolution, which is
 * also what per-event reaction measurement needs.
 *
 * Everything here is an identity mapping (asset → provider ticker), never a
 * business rule.
 */

const FETCH_TIMEOUT_MS = 9000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface YahooQuote {
  symbol: string;
  value: number;
  currency: string | null;
  observedAt: string;
}

export interface YahooPoint {
  t: number;
  v: number;
}

const CURRENCY_CODES = new Set([
  "usd", "eur", "sek", "gbp", "jpy", "chf", "nok", "dkk", "cad", "aud", "nzd", "cny", "pln", "try", "inr",
]);

/** Commodity / index aliases → Yahoo tickers. */
const ALIASES: Record<string, string> = {
  gold: "GC=F",
  guld: "GC=F",
  xau: "GC=F",
  xauusd: "GC=F",
  "xau/usd": "GC=F",
  silver: "SI=F",
  xag: "SI=F",
  xagusd: "SI=F",
  "xag/usd": "SI=F",
  platinum: "PL=F",
  xptusd: "PL=F",
  palladium: "PA=F",
  xpdusd: "PA=F",
  copper: "HG=F",
  "hg.f": "HG=F",
  oil: "BZ=F",
  olja: "BZ=F",
  brent: "BZ=F",
  "brent crude": "BZ=F",
  "brent oil": "BZ=F",
  "cb.f": "BZ=F",
  wti: "CL=F",
  crude: "CL=F",
  "wti crude": "CL=F",
  "cl.f": "CL=F",
  "natural gas": "NG=F",
  "ng.f": "NG=F",
  wheat: "ZW=F",
  "zw.f": "ZW=F",
  corn: "ZC=F",
  "zc.f": "ZC=F",
  spx: "^GSPC",
  "^spx": "^GSPC",
  sp500: "^GSPC",
  "s&p 500": "^GSPC",
  ndx: "^NDX",
  "^ndx": "^NDX",
  nasdaq: "^IXIC",
  "nasdaq 100": "^NDX",
  dji: "^DJI",
  "^dji": "^DJI",
  "dow jones": "^DJI",
  dax: "^GDAXI",
  "^dax": "^GDAXI",
  omxs30: "^OMX",
  "^omxs30": "^OMX",
  vix: "^VIX",
  "^vix": "^VIX",
  dxy: "DX-Y.NYB",
  "^dxy": "DX-Y.NYB",
  "us dollar index": "DX-Y.NYB",
  "us 10y": "^TNX",
  "10-year treasury": "^TNX",
  "us 2y": "^IRX",
};

/** Crypto tickers Yahoo quotes as `<SYM>-USD`. */
const CRYPTO_SYMBOLS = new Set([
  "btc", "eth", "sol", "xrp", "ada", "doge", "bnb", "ltc", "link", "avax", "dot", "matic",
]);

const CRYPTO_BY_NAME: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  solana: "SOL",
  ripple: "XRP",
  cardano: "ADA",
  dogecoin: "DOGE",
  binancecoin: "BNB",
  litecoin: "LTC",
  chainlink: "LINK",
  "avalanche-2": "AVAX",
  polkadot: "DOT",
  "matic-network": "MATIC",
};

export interface YahooLookup {
  symbol: string;
  name?: string | null | undefined;
  kind?: string | null | undefined;
  base_currency?: string | null | undefined;
  quote_currency?: string | null | undefined;
  stooq_symbol?: string | null | undefined;
  coingecko_id?: string | null | undefined;
}

/** Map an instrument or a free-form asset symbol onto a Yahoo ticker. */
export function yahooSymbolFor(input: YahooLookup): string | null {
  const raw = (input.symbol ?? "").trim();
  const key = raw.toLowerCase();
  const nameKey = (input.name ?? "").trim().toLowerCase();
  const stooq = (input.stooq_symbol ?? "").trim().toLowerCase();

  const alias = ALIASES[key] ?? ALIASES[nameKey] ?? ALIASES[stooq];
  if (alias) return alias;

  const coin = input.coingecko_id ? CRYPTO_BY_NAME[input.coingecko_id.toLowerCase()] : undefined;
  if (coin) return `${coin}-USD`;

  // Crypto pair or bare crypto ticker.
  const cryptoPair = key.match(/^([a-z]{2,5})\s*[/-]?\s*(usd|usdt)$/);
  if (cryptoPair && CRYPTO_SYMBOLS.has(cryptoPair[1]!)) return `${cryptoPair[1]!.toUpperCase()}-USD`;
  if (input.kind === "crypto" && /^[a-z]{2,5}$/.test(key)) return `${raw.toUpperCase()}-USD`;

  // Forex pair, explicit fields first.
  if (input.base_currency && input.quote_currency) {
    return `${input.base_currency}${input.quote_currency}`.toUpperCase() + "=X";
  }
  const pair = key.match(/^([a-z]{3})\s*[/-]?\s*([a-z]{3})$/);
  if (pair && CURRENCY_CODES.has(pair[1]!) && CURRENCY_CODES.has(pair[2]!)) {
    return `${pair[1]!}${pair[2]!}`.toUpperCase() + "=X";
  }

  // Equity: exchange-qualified Stooq form (nvda.us) or a bare ticker.
  const stooqEquity = stooq.match(/^([a-z.]{1,6})\.us$/) ?? key.match(/^([a-z.]{1,6})\.us$/);
  if (stooqEquity) return stooqEquity[1]!.toUpperCase();
  if (/^[A-Za-z.-]{1,6}$/.test(raw) && (input.kind === "stock" || input.kind == null)) {
    return raw.toUpperCase();
  }
  if (raw.includes("=") || raw.startsWith("^")) return raw.toUpperCase();
  return null;
}

interface ChartMeta {
  currency?: string;
  regularMarketPrice?: number;
  regularMarketTime?: number;
}

async function chart(
  symbol: string,
  params: string,
): Promise<{ meta: ChartMeta; points: YahooPoint[] }> {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastError: unknown = null;
  for (const host of hosts) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`yahoo HTTP ${res.status}`);
      const json = (await res.json()) as {
        chart?: { result?: unknown[]; error?: { description?: string } | null };
      };
      if (json.chart?.error) throw new Error(`yahoo ${json.chart.error.description ?? "error"}`);
      const result = json.chart?.result?.[0] as
        | {
            meta?: ChartMeta;
            timestamp?: number[];
            indicators?: { quote?: { close?: (number | null)[] }[] };
          }
        | undefined;
      if (!result?.meta) throw new Error("yahoo empty result");
      const stamps = result.timestamp ?? [];
      const closes = result.indicators?.quote?.[0]?.close ?? [];
      const points: YahooPoint[] = [];
      for (let i = 0; i < stamps.length; i++) {
        const v = closes[i];
        const t = stamps[i];
        if (typeof v === "number" && Number.isFinite(v) && typeof t === "number") {
          points.push({ t: t * 1000, v });
        }
      }
      return { meta: result.meta, points };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Current value for a Yahoo ticker. Throws with a readable reason on failure. */
export async function yahooQuote(symbol: string): Promise<YahooQuote | null> {
  const { meta, points } = await chart(symbol, "interval=5m&range=1d");
  const last = points.at(-1);
  const value = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice! : last?.v;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const at =
    typeof meta.regularMarketTime === "number"
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : last
        ? new Date(last.t).toISOString()
        : new Date().toISOString();
  return { symbol, value, currency: meta.currency?.toUpperCase() ?? null, observedAt: at };
}

/**
 * Price series around a moment, at the finest resolution Yahoo still serves
 * for that age (1m/5m only exist for recent days).
 */
export async function yahooSeries(
  symbol: string,
  aroundMs: number,
): Promise<{ points: YahooPoint[]; resolutionHours: number; currency: string | null }> {
  const ageDays = (Date.now() - aroundMs) / 864e5;
  const plan: { interval: string; range: string; hours: number }[] =
    ageDays <= 5
      ? [
          { interval: "5m", range: "5d", hours: 1 / 12 },
          { interval: "1h", range: "1mo", hours: 1 },
          { interval: "1d", range: "3mo", hours: 24 },
        ]
      : ageDays <= 55
        ? [
            { interval: "1h", range: "3mo", hours: 1 },
            { interval: "1d", range: "6mo", hours: 24 },
          ]
        : [{ interval: "1d", range: "2y", hours: 24 }];

  let lastError: unknown = null;
  for (const attempt of plan) {
    try {
      const { meta, points } = await chart(
        symbol,
        `interval=${attempt.interval}&range=${attempt.range}`,
      );
      if (points.length > 0) {
        return {
          points,
          resolutionHours: attempt.hours,
          currency: meta.currency?.toUpperCase() ?? null,
        };
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  return { points: [], resolutionHours: 24, currency: null };
}
