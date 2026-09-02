/**
 * Market Reaction Engine — V3.
 *
 * For an event with a timestamp, measure what the affected assets ACTUALLY
 * did around that moment: the last real observation before the event and the
 * first one at/after the chosen window, straight from market-data providers.
 *
 * Three hard rules:
 *   1. Never invent a price. If no provider covers the asset, or the series
 *      does not span the event, the reaction is `available: false` with a
 *      reason and the UI says "market data unavailable".
 *   2. Never call it causation. The output is a coinciding move; wording is
 *      owned by the UI and the interpretation layer.
 *   3. Nothing here is hardcoded to a product decision — aliases are identity
 *      mappings (symbol → provider ticker), not business rules.
 */
import type { InstrumentKind } from "./types";

export type ReactionWindow = "1h" | "4h" | "24h" | "7d";

export const WINDOW_HOURS: Record<ReactionWindow, number> = { "1h": 1, "4h": 4, "24h": 24, "7d": 168 };

export interface MarketReaction {
  symbol: string;
  name: string;
  /** Data provider that answered, or null when nothing did. */
  provider: string | null;
  currency: string | null;
  window: ReactionWindow | null;
  priceBefore: number | null;
  priceBeforeAt: string | null;
  priceAfter: number | null;
  priceAfterAt: string | null;
  changePct: number | null;
  available: boolean;
  /** Machine-readable honesty: why there is no number. */
  unavailableReason: "no_provider" | "no_history" | "event_undated" | "fetch_failed" | null;
}

interface Point {
  t: number;
  v: number;
}

interface Feed {
  provider: "coingecko" | "stooq";
  id: string;
  currency: string | null;
  /** Finest resolution the feed offers, in hours. */
  resolutionHours: number;
}

const FETCH_TIMEOUT_MS = 9000;

/** Crypto assets → CoinGecko ids. Identity mapping, extended by heuristics. */
const COINGECKO_IDS: Record<string, string> = {
  btc: "bitcoin",
  "btc/usd": "bitcoin",
  bitcoin: "bitcoin",
  eth: "ethereum",
  "eth/usd": "ethereum",
  ethereum: "ethereum",
  sol: "solana",
  solana: "solana",
  xrp: "ripple",
  ada: "cardano",
  doge: "dogecoin",
  bnb: "binancecoin",
  ltc: "litecoin",
  link: "chainlink",
  avax: "avalanche-2",
  dot: "polkadot",
  matic: "matic-network",
};

/** Commodities, indices and common aliases → Stooq tickers. */
const STOOQ_ALIASES: Record<string, string> = {
  gold: "xauusd",
  xau: "xauusd",
  "xau/usd": "xauusd",
  guld: "xauusd",
  silver: "xagusd",
  "xag/usd": "xagusd",
  platinum: "xptusd",
  palladium: "xpdusd",
  copper: "hg.f",
  brent: "cb.f",
  "brent crude": "cb.f",
  "brent oil": "cb.f",
  oil: "cb.f",
  olja: "cb.f",
  crude: "cl.f",
  wti: "cl.f",
  "wti crude": "cl.f",
  "natural gas": "ng.f",
  gas: "ng.f",
  wheat: "zw.f",
  corn: "zc.f",
  spx: "^spx",
  "s&p 500": "^spx",
  sp500: "^spx",
  ndx: "^ndx",
  nasdaq: "^ndx",
  "nasdaq 100": "^ndx",
  dji: "^dji",
  "dow jones": "^dji",
  dax: "^dax",
  omxs30: "^omxs30",
  vix: "^vix",
  dxy: "^dxy",
  "us dollar index": "^dxy",
  "usd index": "^dxy",
  "us 10y": "10usy.b",
  "10-year treasury": "10usy.b",
  "us 2y": "2usy.b",
};

const CURRENCY_CODES = new Set([
  "usd", "eur", "sek", "gbp", "jpy", "chf", "nok", "dkk", "cad", "aud", "nzd", "cny", "pln",
]);

/**
 * Map a free-form asset symbol/name onto a real data feed. Returns null when
 * no provider can be established — the caller must then report unavailable.
 */
export function resolveFeed(symbol: string, name = "", kind?: InstrumentKind | null): Feed | null {
  const raw = symbol.trim();
  const key = raw.toLowerCase();
  const nameKey = name.trim().toLowerCase();

  const coin = COINGECKO_IDS[key] ?? COINGECKO_IDS[nameKey];
  if (coin) return { provider: "coingecko", id: coin, currency: "USD", resolutionHours: 1 };

  const alias = STOOQ_ALIASES[key] ?? STOOQ_ALIASES[nameKey];
  if (alias) return { provider: "stooq", id: alias, currency: alias.startsWith("^") ? null : "USD", resolutionHours: 24 };

  // Forex pair, e.g. "USD/SEK" or "EURUSD".
  const pair = key.match(/^([a-z]{3})\s*[/-]?\s*([a-z]{3})$/);
  if (pair && CURRENCY_CODES.has(pair[1]!) && CURRENCY_CODES.has(pair[2]!)) {
    return { provider: "stooq", id: `${pair[1]}${pair[2]}`, currency: pair[2]!.toUpperCase(), resolutionHours: 24 };
  }

  // Equity ticker: 1–5 letters, optionally already exchange-qualified.
  if (/^[a-z]{1,5}\.[a-z]{2}$/.test(key)) {
    return { provider: "stooq", id: key, currency: null, resolutionHours: 24 };
  }
  if (/^[A-Z]{1,5}$/.test(raw) && (kind === "stock" || kind == null)) {
    return { provider: "stooq", id: `${key}.us`, currency: "USD", resolutionHours: 24 };
  }
  return null;
}

async function coingeckoSeries(id: string, fromMs: number, toMs: number): Promise<Point[]> {
  const url =
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart/range` +
    `?vs_currency=usd&from=${Math.floor(fromMs / 1000)}&to=${Math.ceil(toMs / 1000)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
  const json = (await res.json()) as { prices?: [number, number][] };
  return (json.prices ?? [])
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => ({ t: p[0], v: p[1] }));
}

async function stooqSeries(ticker: string): Promise<Point[]> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(ticker)}&i=d`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`stooq HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^date/i.test(lines[0] ?? "")) return [];
  const out: Point[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const date = cells[0];
    const close = Number(cells[4]);
    if (!date || !Number.isFinite(close)) continue;
    const t = Date.parse(`${date}T21:00:00Z`); // daily close, roughly US session end
    if (Number.isFinite(t)) out.push({ t, v: close });
  }
  return out;
}

function pickBefore(points: Point[], at: number): Point | null {
  let best: Point | null = null;
  for (const p of points) if (p.t <= at && (!best || p.t > best.t)) best = p;
  return best;
}

function pickAfter(points: Point[], at: number): Point | null {
  let best: Point | null = null;
  for (const p of points) if (p.t >= at && (!best || p.t < best.t)) best = p;
  return best;
}

const unavailable = (
  symbol: string,
  name: string,
  reason: NonNullable<MarketReaction["unavailableReason"]>,
  provider: string | null = null,
): MarketReaction => ({
  symbol,
  name,
  provider,
  currency: null,
  window: null,
  priceBefore: null,
  priceBeforeAt: null,
  priceAfter: null,
  priceAfterAt: null,
  changePct: null,
  available: false,
  unavailableReason: reason,
});

/**
 * Measure one asset's move around an event. The window is the smallest the
 * feed can actually resolve at or above the requested one — a daily series can
 * never answer "1h", and pretending otherwise would be inventing data.
 */
export async function measureReaction(input: {
  symbol: string;
  name?: string;
  kind?: InstrumentKind | null;
  eventIso: string | null;
  preferredWindow?: ReactionWindow;
}): Promise<MarketReaction> {
  const name = input.name ?? input.symbol;
  if (!input.eventIso) return unavailable(input.symbol, name, "event_undated");
  const at = Date.parse(input.eventIso);
  if (!Number.isFinite(at)) return unavailable(input.symbol, name, "event_undated");

  const feed = resolveFeed(input.symbol, input.name ?? "", input.kind ?? null);
  if (!feed) return unavailable(input.symbol, name, "no_provider");

  const requested = input.preferredWindow ?? "24h";
  const window: ReactionWindow =
    WINDOW_HOURS[requested] >= feed.resolutionHours
      ? requested
      : feed.resolutionHours <= 4
        ? "4h"
        : feed.resolutionHours <= 24
          ? "24h"
          : "7d";

  let points: Point[];
  try {
    points =
      feed.provider === "coingecko"
        ? await coingeckoSeries(feed.id, at - 3 * 864e5, at + 8 * 864e5)
        : await stooqSeries(feed.id);
  } catch {
    return unavailable(input.symbol, name, "fetch_failed", feed.provider);
  }
  if (points.length === 0) return unavailable(input.symbol, name, "no_history", feed.provider);

  const before = pickBefore(points, at);
  const target = at + WINDOW_HOURS[window] * 36e5;
  const after = pickAfter(points, target) ?? pickAfter(points, at + 1);
  if (!before || !after || after.t <= before.t || before.v === 0) {
    return unavailable(input.symbol, name, "no_history", feed.provider);
  }

  return {
    symbol: input.symbol,
    name,
    provider: feed.provider,
    currency: feed.currency,
    window,
    priceBefore: before.v,
    priceBeforeAt: new Date(before.t).toISOString(),
    priceAfter: after.v,
    priceAfterAt: new Date(after.t).toISOString(),
    changePct: Math.round(((after.v - before.v) / before.v) * 10000) / 100,
    available: true,
    unavailableReason: null,
  };
}

/**
 * Measure the whole affected-asset basket for one event, bounded and
 * de-duplicated. Failures degrade to "unavailable" entries, never to zeros.
 */
export async function measureReactions(input: {
  assets: { symbol: string; name?: string }[];
  eventIso: string | null;
  preferredWindow?: ReactionWindow;
  max?: number;
}): Promise<MarketReaction[]> {
  const seen = new Set<string>();
  const targets = input.assets
    .filter((a) => {
      const key = a.symbol.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, input.max ?? 5);

  return Promise.all(
    targets.map((a) =>
      measureReaction({
        symbol: a.symbol,
        ...(a.name ? { name: a.name } : {}),
        eventIso: input.eventIso,
        ...(input.preferredWindow ? { preferredWindow: input.preferredWindow } : {}),
      }).catch(() => unavailable(a.symbol, a.name ?? a.symbol, "fetch_failed")),
    ),
  );
}

/** Reactions worth showing: real data, and a move that is not pure noise. */
export function significantReactions(reactions: MarketReaction[], minAbsPct = 0.3): MarketReaction[] {
  return reactions.filter((r) => r.available && Math.abs(r.changePct ?? 0) >= minAbsPct);
}

/** Largest absolute observed move across the basket, for importance scoring. */
export function peakMovePct(reactions: MarketReaction[]): number | null {
  const moves = reactions.filter((r) => r.available && r.changePct !== null).map((r) => Math.abs(r.changePct!));
  return moves.length === 0 ? null : Math.max(...moves);
}

/**
 * One honest line about what the measured assets did. Deliberately worded as a
 * coincidence: "around", never "because of".
 */
export function describeReactions(reactions: MarketReaction[]): string | null {
  const shown = significantReactions(reactions).slice(0, 3);
  if (shown.length === 0) return null;
  const parts = shown.map(
    (r) => `${r.symbol} ${r.changePct! >= 0 ? "+" : ""}${r.changePct!.toFixed(2)}% (${r.window})`,
  );
  return `Observed around this event: ${parts.join(", ")} — coincidence, not proven causation.`;
}
