/**
 * Market Monitoring — shared data model (client-safe, no server imports).
 *
 * A market radar watches a measurable datapoint over time (an exchange rate,
 * a share price, a commodity spot price, an index level, a statistic) instead
 * of hunting for listings. Everything here is generic: nothing is keyed to a
 * specific instrument, market or provider.
 */

export type InstrumentKind =
  | "forex"
  | "stock"
  | "commodity"
  | "crypto"
  | "index"
  | "housing"
  | "rate"
  | "statistic"
  | "other";

export interface MarketInstrument {
  /** Canonical symbol shown to the user: "USD/EUR", "NVDA", "GOLD", "SPX". */
  symbol: string;
  /** Human name: "US dollar to euro", "NVIDIA share price". */
  name: string;
  kind: InstrumentKind;
  /** snake_case metric: exchange_rate | price | spot_price | index_level | … */
  metric: string;
  /** Currency the value is expressed in ("USD"), when applicable. */
  currency: string | null;
  /** Unit of the value ("troy_ounce", "share", "percent"), when applicable. */
  unit: string | null;
  base_currency: string | null;
  quote_currency: string | null;
  /** Best-known Stooq ticker ("nvda.us", "usdeur", "xauusd", "^spx"). */
  stooq_symbol: string | null;
  /** CoinGecko asset id for crypto ("bitcoin", "ethereum"). */
  coingecko_id: string | null;
}

export type ThresholdOperator = "lt" | "lte" | "gt" | "gte";
export type RuleDirection = "up" | "down" | "any";
export type RuleWindow = "baseline" | "24h" | "7d" | "30d";

export type MarketRule =
  | {
      id: string;
      type: "threshold";
      /** Human form, e.g. "under 1.15". */
      label: string;
      operator: ThresholdOperator;
      value: number;
    }
  | {
      id: string;
      type: "pct_change";
      /** Human form, e.g. "faller mer än 10 % från nuvarande nivå". */
      label: string;
      direction: RuleDirection;
      pct: number;
      window: RuleWindow;
    };

/**
 * What world events matter for this instrument. Purely descriptive — the
 * event engine turns it into search queries and relevance judgements, and it
 * never affects the numeric collection path.
 */
export interface MarketImpactProfile {
  /** Plain-language subjects to watch: "central bank decisions", "war in the Middle East". */
  topics: string[];
  /** Concrete news search queries. */
  queries: string[];
  /** Entities whose news moves this instrument: "Federal Reserve", "TSMC". */
  entities: string[];
}

export interface MarketMonitorSpec {
  instrument: MarketInstrument;
  rules: MarketRule[];
  /** Null when the radar only tracks the number and no events. */
  impact: MarketImpactProfile | null;
}


const INSTRUMENT_KINDS: InstrumentKind[] = [
  "forex",
  "stock",
  "commodity",
  "crypto",
  "index",
  "housing",
  "rate",
  "statistic",
  "other",
];

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.replace(/\s/g, "").replace(",", ".")) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function asInstrument(value: unknown): MarketInstrument | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const symbol = asString(raw["symbol"]);
  const metric = asString(raw["metric"]);
  if (!symbol || !metric) return null;
  const kindRaw = asString(raw["kind"]);
  return {
    symbol,
    name: asString(raw["name"]) ?? symbol,
    kind: INSTRUMENT_KINDS.includes(kindRaw as InstrumentKind)
      ? (kindRaw as InstrumentKind)
      : "other",
    metric,
    currency: asString(raw["currency"])?.toUpperCase() ?? null,
    unit: asString(raw["unit"]),
    base_currency: asString(raw["base_currency"])?.toUpperCase() ?? null,
    quote_currency: asString(raw["quote_currency"])?.toUpperCase() ?? null,
    stooq_symbol: asString(raw["stooq_symbol"])?.toLowerCase() ?? null,
    coingecko_id: asString(raw["coingecko_id"])?.toLowerCase() ?? null,
  };
}

/** Coerce arbitrary (AI-produced) rule JSON into strict rules. Invalid rules are dropped. */
export function asMarketRules(value: unknown): MarketRule[] {
  if (!Array.isArray(value)) return [];
  const rules: MarketRule[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = asString(raw["id"]) ?? `rule_${index + 1}`;
    const label = asString(raw["label"]) ?? "";
    if (raw["type"] === "threshold") {
      const op = asString(raw["operator"]);
      const val = asFiniteNumber(raw["value"]);
      if ((op === "lt" || op === "lte" || op === "gt" || op === "gte") && val !== null) {
        rules.push({ id, type: "threshold", label, operator: op, value: val });
      }
    } else if (raw["type"] === "pct_change") {
      const dir = asString(raw["direction"]);
      const pct = asFiniteNumber(raw["pct"]);
      const win = asString(raw["window"]);
      if (
        (dir === "up" || dir === "down" || dir === "any") &&
        pct !== null &&
        pct > 0 &&
        (win === "baseline" || win === "24h" || win === "7d" || win === "30d")
      ) {
        rules.push({ id, type: "pct_change", label, direction: dir, pct, window: win });
      }
    }
  }
  // Rule ids must be unique for per-rule state; suffix any collision.
  const seen = new Set<string>();
  return rules.map((rule) => {
    let id = rule.id;
    let n = 2;
    while (seen.has(id)) id = `${rule.id}_${n++}`;
    seen.add(id);
    return { ...rule, id };
  });
}

function stringList(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = asString(item);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function asImpactProfile(value: unknown): MarketImpactProfile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const profile: MarketImpactProfile = {
    topics: stringList(raw["topics"]),
    queries: stringList(raw["queries"], 8),
    entities: stringList(raw["entities"]),
  };
  if (profile.topics.length === 0 && profile.queries.length === 0 && profile.entities.length === 0) {
    return null;
  }
  return profile;
}

export function asMarketSpec(value: unknown): MarketMonitorSpec | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const instrument = asInstrument(raw["instrument"]);
  if (!instrument) return null;
  return {
    instrument,
    rules: asMarketRules(raw["rules"]),
    impact: asImpactProfile(raw["impact"]),
  };
}


/** Short operator words for UI labels. */
export const OPERATOR_LABEL: Record<ThresholdOperator, string> = {
  lt: "under",
  lte: "at most",
  gt: "over",
  gte: "at least",
};
