/**
 * V3 market intelligence: taxonomy, syndication, reaction feeds and themes.
 * Everything here is pure or offline — no network calls in the suite.
 */
import { describe, expect, it } from "vitest";
import { yahooSymbolFor } from "@/lib/market/yahoo.server";
import {
  classifyEvent,
  eventCategories,
  normalizeCategory,
  relatedCategories,
} from "@/lib/market/taxonomy";
import {
  bestQuality,
  countIndependent,
  identifyAll,
  identifySource,
} from "@/lib/market/syndication";
import {
  resolveFeed,
  describeReactions,
  significantReactions,
  peakMovePct,
} from "@/lib/market/reaction.server";
import { buildThemes } from "@/lib/market/themes";

describe("taxonomy", () => {
  it("classifies by weighted evidence, not first match", () => {
    expect(classifyEvent("Fed holds rates steady as inflation cools")).toBe("monetary_policy");
    expect(classifyEvent("OPEC+ announces surprise production cut")).toBe("commodity_supply");
    expect(classifyEvent("Missile strikes hit Red Sea shipping lane")).toBe("military_conflict");
    expect(classifyEvent("US imposes new tariffs on Chinese EVs")).toBe("sanctions");
    expect(classifyEvent("NVIDIA beats Q4 revenue guidance")).toBe("earnings");
  });

  it("does not label a war story as monetary policy just because a bank is quoted", () => {
    const category = classifyEvent(
      "Israeli strikes escalate as troops advance",
      "Analysts at Bank of America said the Fed may respond to oil prices.",
    );
    expect(category).toBe("military_conflict");
  });

  it("returns nothing for text without market-event signals", () => {
    expect(classifyEvent("A quiet day in the park")).toBe("other");
  });

  it("exposes secondary categories and normalises legacy values", () => {
    const cats = eventCategories("New sanctions on Russian oil exports disrupt crude supply");
    expect(cats).toContain("sanctions");
    expect(normalizeCategory("conflict")).toBe("military_conflict");
    expect(normalizeCategory("nonsense")).toBe("other");
  });

  it("relates neighbouring categories but keeps unrelated ones apart", () => {
    expect(relatedCategories("military_conflict", "geopolitics")).toBe(true);
    expect(relatedCategories("monetary_policy", "military_conflict")).toBe(false);
  });
});

describe("syndication", () => {
  it("attributes an aggregator link to the original publisher", () => {
    const identity = identifySource({
      title: "Reuters: OPEC+ cuts output",
      url: "https://news.google.com/articles/xyz",
      publisher: "Google News",
    });
    expect(identity.syndicated).toBe(true);
    expect((identity.original_publisher ?? "").toLowerCase()).toContain("reuters");
  });

  it("counts syndicated copies of one wire report as a single voice", () => {
    const identities = identifyAll([
      { title: "Reuters: rate cut", url: "https://reuters.com/a", publisher: "Reuters" },
      { title: "(Reuters) rate cut", url: "https://finance.yahoo.com/b", publisher: "Yahoo" },
      { title: "(Reuters) rate cut", url: "https://msn.com/c", publisher: "MSN" },
    ]);
    expect(countIndependent(identities)).toBe(1);
  });

  it("counts genuinely different newsrooms separately", () => {
    const identities = identifyAll([
      { title: "Fed cuts", url: "https://reuters.com/a", publisher: "Reuters" },
      { title: "Fed cuts", url: "https://ft.com/b", publisher: "Financial Times" },
      { title: "Fed cuts", url: "https://randomblog.example/c", publisher: "Blog" },
    ]);
    expect(countIndependent(identities)).toBe(3);
    expect(bestQuality(identities)).toBe("high");
  });
});

describe("reaction feeds", () => {
  it("maps assets onto real provider feeds", () => {
    expect(resolveFeed("BTC")?.provider).toBe("coingecko");
    expect(resolveFeed("Gold")?.provider).toBe("yahoo");
    expect(resolveFeed("Gold")?.id).toBe("GC=F");
    expect(resolveFeed("USD/SEK")?.id).toBe("USDSEK=X");
    expect(resolveFeed("AAPL", "", "stock")?.id).toBe("AAPL");
  });

  it("returns null rather than guessing for unknown assets", () => {
    expect(resolveFeed("my neighbour's bicycle")).toBeNull();
  });

  it("filters noise and describes moves without claiming causation", () => {
    const reactions = [
      { symbol: "XAU", changePct: 1.8, window: "24h", available: true } as never,
      { symbol: "BTC", changePct: 0.05, window: "1h", available: true } as never,
      { symbol: "OIL", changePct: null, window: null, available: false } as never,
    ];
    expect(significantReactions(reactions)).toHaveLength(1);
    expect(peakMovePct(reactions)).toBeCloseTo(1.8);
    const text = describeReactions(reactions);
    expect(text).toContain("XAU +1.80%");
    expect(text).toMatch(/not proven causation/i);
  });

  it("says nothing when no asset has usable data", () => {
    expect(describeReactions([{ symbol: "X", available: false } as never])).toBeNull();
  });
});

describe("themes", () => {
  const base = { published_at: "2026-01-05T10:00:00Z", last_updated_at: "2026-01-05T10:00:00Z" };

  it("groups related events into one theme and keeps unrelated ones apart", () => {
    const themes = buildThemes([
      {
        id: "1",
        title: "Israel strikes Hezbollah positions",
        entities: ["Israel", "Hezbollah"],
        event_type: "military_conflict",
        importance_score: 80,
        ...base,
      },
      {
        id: "2",
        title: "Israeli forces escalate against Hezbollah",
        entities: ["Israel", "Hezbollah"],
        event_type: "geopolitics",
        importance_score: 70,
        ...base,
      },
      {
        id: "3",
        title: "Fed holds rates",
        entities: ["Fed", "FOMC"],
        event_type: "monetary_policy",
        importance_score: 75,
        ...base,
      },
    ]);
    const conflict = themes.find((t) => t.eventCount === 2);
    expect(conflict?.eventIds.sort()).toEqual(["1", "2"]);
    expect(themes.some((t) => t.eventIds.includes("3") && t.eventCount === 1)).toBe(true);
  });

  it("aggregates measured moves and ignores unavailable ones", () => {
    const reactions = [
      { symbol: "XAU", changePct: 2, window: "24h", available: true },
      { symbol: "OIL", changePct: null, available: false },
    ];
    const [theme] = buildThemes(
      [
        {
          id: "1",
          title: "Gulf tensions rise",
          entities: ["Iran", "Hormuz"],
          event_type: "military_conflict",
          importance_score: 90,
          market_reactions: reactions,
          ...base,
        },
        {
          id: "2",
          title: "Iran threatens Hormuz shipping",
          entities: ["Iran", "Hormuz"],
          event_type: "military_conflict",
          importance_score: 60,
          market_reactions: reactions,
          ...base,
        },
      ],
      { minEvents: 2 },
    );
    expect(theme?.moves).toEqual([{ symbol: "XAU", changePct: 2, window: "24h" }]);
  });

  it("drops one-off noise but keeps a single critical event", () => {
    const themes = buildThemes([
      {
        id: "1",
        title: "Minor commentary",
        entities: ["Analyst"],
        event_type: "other",
        importance_score: 20,
        ...base,
      },
      {
        id: "2",
        title: "Emergency rate cut announced",
        entities: ["Fed"],
        event_type: "monetary_policy",
        importance_score: 92,
        ...base,
      },
    ]);
    expect(themes).toHaveLength(1);
    expect(themes[0]?.eventIds).toEqual(["2"]);
  });
});

describe("data-source redundancy and duplicate stories (production bug fixes)", () => {
  it("maps every instrument kind onto a Yahoo ticker", () => {
    expect(yahooSymbolFor({ symbol: "XAU/USD", name: "Gold", kind: "commodity" })).toBe("GC=F");
    expect(yahooSymbolFor({ symbol: "NVDA", kind: "stock", stooq_symbol: "nvda.us" })).toBe("NVDA");
    expect(
      yahooSymbolFor({ symbol: "USD/EUR", kind: "forex", base_currency: "USD", quote_currency: "EUR" }),
    ).toBe("USDEUR=X");
    expect(yahooSymbolFor({ symbol: "BTC/USD", kind: "crypto", coingecko_id: "bitcoin" })).toBe("BTC-USD");
    expect(yahooSymbolFor({ symbol: "my neighbour's bicycle" })).toBeNull();
  });

  it("merges two headlines about the same number and subject into one story", () => {
    const clusters = clusterDocuments([
      {
        title: "Bitcoin hits $77,000 wall as the Fed gets trapped between weak jobs and $90 oil",
        url: "https://a.com/1",
        snippet: "BTC stalled.",
        published_at: "2026-09-02T10:00:00Z",
      },
      {
        title: "Bitcoin falls below $77,000 with Federal Reserves trapped between jobs and oil",
        url: "https://b.com/2",
        snippet: "BTC slid.",
        published_at: "2026-09-02T11:00:00Z",
      },
      {
        title: "Bitcoin Pauses After Reclaiming $80,000 as Sept. 15 Clarity Act Vote Looms",
        url: "https://c.com/3",
        snippet: "Different story.",
        published_at: "2026-09-02T12:00:00Z",
      },
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.sources).toHaveLength(2);
  });

  it("lets a first sweep alert on major news but stays quiet on ordinary news", () => {
    expect(alertDecision({ importance: 84, isBaseline: true, isNewEvent: true })).toEqual({
      alert: true,
      reason: "baseline_significant",
    });
    expect(alertDecision({ importance: 62, isBaseline: true, isNewEvent: true })).toEqual({
      alert: false,
      reason: "baseline",
    });
  });
});
