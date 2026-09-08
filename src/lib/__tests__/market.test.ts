import { describe, expect, it } from "vitest";
import { changeOverWindow, computeMarketChanges, latestObservation, priceFreshness, type MarketPoint } from "../market/history";
import { evaluateMarketRules } from "../market/rules";
import { asMarketRules, asMarketSpec } from "../market/types";
import { consensusFromQuotes, stooqSymbolFor, type SourceQuote } from "../market/sources.server";

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse("2026-09-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("market history", () => {
  it("computes current/previous change from an unsorted series", () => {
    const points: MarketPoint[] = [
      { t: iso(NOW), v: 110 },
      { t: iso(NOW - DAY), v: 100 },
    ];
    const changes = computeMarketChanges(points, NOW)!;
    expect(changes.current).toBe(110);
    expect(changes.previous).toBe(100);
    expect(changes.abs).toBeCloseTo(10);
    expect(changes.pct).toBeCloseTo(10);
  });

  it("resolves windows against the point current at the cutoff", () => {
    const points: MarketPoint[] = [
      { t: iso(NOW - 10 * DAY), v: 90 },
      { t: iso(NOW - 2 * DAY), v: 100 },
      { t: iso(NOW), v: 105 },
    ];
    const changes = computeMarketChanges(points, NOW)!;
    // 24h: nothing at/before now-24h except the 2d point → reference 100
    expect(changes.windows["24h"]!.from).toBe(100);
    // 7d: reference is the 10d-old point
    expect(changes.windows["7d"]!.from).toBe(90);
    // 30d: no history that old → null
    expect(changes.windows["30d"]).toBeNull();
  });

  it("returns null windows for a single point", () => {
    const changes = computeMarketChanges([{ t: iso(NOW), v: 1.07 }], NOW)!;
    expect(changes.pct).toBeNull();
    expect(changes.windows["24h"]).toBeNull();
  });

  it("ignores points with broken timestamps or values", () => {
    expect(computeMarketChanges([{ t: "garbage", v: 5 }, { t: iso(NOW), v: NaN }])).toBeNull();
  });

  it("changeOverWindow refuses a window the series cannot cover", () => {
    const points: MarketPoint[] = [{ t: iso(NOW - 3600_000), v: 1 }];
    expect(changeOverWindow(points, DAY, NOW)).toBeNull();
  });
});

describe("market rules", () => {
  const threshold = { id: "rule_1", type: "threshold" as const, label: "under 1.15", operator: "lt" as const, value: 1.15 };

  it("fires a threshold on the edge, not while it stays breached", () => {
    const input = { current: 1.1, baselineValue: 1.1, changes: null, state: {}, nowIso: iso(NOW) };
    const first = evaluateMarketRules([threshold], input);
    expect(first.triggered).toHaveLength(1);
    expect(first.nextState["rule_1"]!.conditionMet).toBe(true);

    const again = evaluateMarketRules([threshold], { ...input, state: first.nextState });
    expect(again.triggered).toHaveLength(0);

    // re-arms after the condition clears, fires on the next crossing
    const cleared = evaluateMarketRules([threshold], { ...input, current: 1.2, state: first.nextState });
    expect(cleared.nextState["rule_1"]!.conditionMet).toBe(false);
    const recrossed = evaluateMarketRules([threshold], { ...input, state: cleared.nextState });
    expect(recrossed.triggered).toHaveLength(1);
  });

  it("evaluates pct_change against the baseline", () => {
    const rule = {
      id: "r",
      type: "pct_change" as const,
      label: "down 10 % from now",
      direction: "down" as const,
      pct: 10,
      window: "baseline" as const,
    };
    const hit = evaluateMarketRules([rule], { current: 88, baselineValue: 100, changes: null, state: {} });
    expect(hit.triggered).toHaveLength(1);
    expect(hit.statuses[0]!.movePct).toBeCloseTo(-12);
    const miss = evaluateMarketRules([rule], { current: 95, baselineValue: 100, changes: null, state: {} });
    expect(miss.triggered).toHaveLength(0);
    expect(miss.statuses[0]!.conditionMet).toBe(false);
  });

  it("never fires a windowed rule without reference data, and keeps prior state", () => {
    const rule = {
      id: "r",
      type: "pct_change" as const,
      label: "5 % in 24h",
      direction: "any" as const,
      pct: 5,
      window: "24h" as const,
    };
    const out = evaluateMarketRules([rule], {
      current: 100,
      baselineValue: 100,
      changes: null,
      state: { r: { conditionMet: true, lastTriggeredAt: iso(NOW - DAY) } },
    });
    expect(out.triggered).toHaveLength(0);
    expect(out.statuses[0]!.evaluable).toBe(false);
    expect(out.nextState["r"]!.conditionMet).toBe(true);
    expect(out.nextState["r"]!.lastTriggeredAt).toBe(iso(NOW - DAY));
  });
});

describe("market spec coercion", () => {
  it("drops malformed rules and suffixes duplicate ids", () => {
    const rules = asMarketRules([
      { id: "a", type: "threshold", label: "x", operator: "lt", value: "1.15" },
      { id: "a", type: "threshold", label: "y", operator: "gt", value: 2 },
      { id: "b", type: "threshold", label: "bad", operator: "==", value: 2 },
      { id: "c", type: "pct_change", label: "ok", direction: "down", pct: 10, window: "baseline" },
      "garbage",
    ]);
    expect(rules).toHaveLength(3);
    expect(rules[0]!.id).toBe("a");
    expect(rules[1]!.id).toBe("a_2");
    expect(rules[2]!.type).toBe("pct_change");
  });

  it("rejects a spec without a usable instrument", () => {
    expect(asMarketSpec(null)).toBeNull();
    expect(asMarketSpec({ instrument: { name: "x" }, rules: [] })).toBeNull();
    const spec = asMarketSpec({
      instrument: { symbol: "USD/EUR", metric: "exchange_rate", kind: "forex", base_currency: "usd", quote_currency: "eur" },
      rules: [],
    });
    expect(spec!.instrument.base_currency).toBe("USD");
    expect(spec!.instrument.kind).toBe("forex");
  });
});

describe("market sources", () => {
  const quote = (source: string, value: number): SourceQuote => ({
    source,
    sourceUrl: `https://${source}.example`,
    value,
    currency: "EUR",
    unit: null,
    observedAt: iso(NOW),
  });

  it("verifies agreement and marks disagreement as probable", () => {
    const ok = consensusFromQuotes([quote("a", 1.0), quote("b", 1.005), quote("c", 1.002)])!;
    expect(ok.status).toBe("VERIFIED");
    expect(ok.value).toBeCloseTo(1.002);

    const split = consensusFromQuotes([quote("a", 1.0), quote("b", 1.2)])!;
    expect(split.status).toBe("PROBABLE");
    expect(split.spreadPct!).toBeGreaterThan(1);
  });

  it("treats a single source as probable and rejects empties", () => {
    expect(consensusFromQuotes([quote("a", 42)])!.confidence).toBeCloseTo(0.55);
    expect(consensusFromQuotes([])).toBeNull();
  });

  it("derives a stooq symbol for forex pairs", () => {
    const spec = asMarketSpec({
      instrument: { symbol: "USD/EUR", metric: "exchange_rate", kind: "forex", base_currency: "USD", quote_currency: "EUR" },
      rules: [],
    })!;
    expect(stooqSymbolFor(spec.instrument)).toBe("usdeur");
    expect(
      stooqSymbolFor(asMarketSpec({ instrument: { symbol: "X", metric: "price", kind: "other" }, rules: [] })!.instrument),
    ).toBeNull();
  });
});

describe("price freshness (BUG 5 — stale price presented as current)", () => {
  it("flags a Friday close retrieved on Tuesday as last_close for a stock", () => {
    const f = priceFreshness("stock", "2026-09-04T20:00:00Z", "2026-09-08T10:50:28Z");
    expect(f.state).toBe("last_close");
    expect(Math.round(f.ageMs / 36e5)).toBe(87);
  });
  it("treats a 30-minute-old quote as fresh", () => {
    expect(priceFreshness("stock", "2026-09-08T14:00:00Z", "2026-09-08T14:30:00Z").state).toBe("fresh");
  });
  it("calls an old crypto/commodity timestamp stale, not last close", () => {
    expect(priceFreshness("crypto", "2026-09-08T01:00:00Z", "2026-09-08T10:00:00Z").state).toBe("stale");
    expect(priceFreshness("commodity", "2026-09-08T09:00:00Z", "2026-09-08T10:00:00Z").state).toBe("fresh");
  });
  it("picks the newest retrieval when several rows share one source timestamp", () => {
    const rows = [
      { observed_at: "2026-09-04T20:00:00Z", retrieved_at: "2026-09-07T09:25:00Z", src: "Stock Analysis" },
      { observed_at: "2026-09-04T20:00:00Z", retrieved_at: "2026-09-08T10:50:28Z", src: "yahoo" },
      { observed_at: "2026-09-04T20:00:00Z", retrieved_at: "2026-09-08T05:32:40Z", src: "yahoo" },
    ];
    expect(latestObservation(rows)?.retrieved_at).toBe("2026-09-08T10:50:28Z");
    expect(latestObservation([...rows].reverse())?.retrieved_at).toBe("2026-09-08T10:50:28Z");
  });
});
