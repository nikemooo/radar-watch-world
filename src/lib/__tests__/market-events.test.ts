import { describe, expect, it } from "vitest";
import {
  alertDecision,
  bestSourceTier,
  calibrateFactConfidence,
  calibrateInterpretationConfidence,
  classifyEventType,
  clusterDocuments,
  computeImportance,
  containsCausalClaim,
  eventSimilarity,
  importanceBand,
  independentSourceCount,
  isMaterialUpdate,
  matchExistingEvent,
  noveltyScore,
  softenCausality,
  sourceTier,
} from "../market/events";

const day = "2026-03-04T10:00:00.000Z";

describe("event typing", () => {
  it("recognises monetary policy, conflict and earnings wording", () => {
    expect(classifyEventType("Fed holds interest rate steady")).toBe("monetary_policy");
    expect(classifyEventType("Missile attack on shipping lane")).toBe("conflict");
    expect(classifyEventType("NVIDIA Q4 earnings beat revenue guidance")).toBe("earnings");
    expect(classifyEventType("A quiet day in the park")).toBe("other");
  });
});

describe("clustering", () => {
  it("collapses differently worded reports of the same happening", () => {
    const clusters = clusterDocuments([
      {
        title: "Fed holds interest rates steady at 4.25%",
        url: "https://reuters.com/a",
        snippet: "The Federal Reserve kept rates unchanged.",
        published_at: day,
      },
      {
        title: "Federal Reserve keeps rates unchanged at 4.25%, Powell signals patience",
        url: "https://bloomberg.com/b",
        snippet: "Powell said the committee can wait.",
        published_at: day,
      },
      {
        title: "Israel strikes tanker in Red Sea, oil supply route disrupted",
        url: "https://apnews.com/c",
        snippet: "A tanker was hit.",
        published_at: day,
      },
    ]);
    expect(clusters).toHaveLength(2);
    const fed = clusters.find((c) => c.type === "monetary_policy");
    expect(fed?.sources).toHaveLength(2);
  });

  it("never merges two different event types", () => {
    const score = eventSimilarity(
      { title: "Fed cuts interest rate by 25 bps" },
      { title: "Missile attack destroys Red Sea shipping terminal" },
    );
    expect(score).toBeLessThan(0.4);
  });

  it("keeps recurring headlines apart across months", () => {
    const clusters = clusterDocuments([
      { title: "Fed holds rates", url: "https://reuters.com/x", snippet: "", published_at: "2026-01-04T10:00:00Z" },
      { title: "Fed holds rates", url: "https://reuters.com/y", snippet: "", published_at: "2026-03-04T10:00:00Z" },
    ]);
    expect(clusters).toHaveLength(2);
  });
});

describe("source quality", () => {
  it("ranks primary above high above secondary above low", () => {
    expect(sourceTier("https://www.federalreserve.gov/news")).toBe("primary");
    expect(sourceTier("https://reuters.com/markets")).toBe("high");
    expect(sourceTier("https://someblog.se/post")).toBe("secondary");
    expect(sourceTier("https://reddit.com/r/gold")).toBe("low");
    expect(bestSourceTier([{ url: "https://reddit.com/a" }, { url: "https://reuters.com/b" }])).toBe("high");
  });

  it("counts distinct publishers, not URLs", () => {
    expect(
      independentSourceCount([
        { url: "https://reuters.com/a" },
        { url: "https://reuters.com/b" },
        { url: "https://ft.com/c" },
      ]),
    ).toBe(2);
  });
});

describe("confidence calibration", () => {
  it("caps a single low-quality source hard", () => {
    expect(calibrateFactConfidence({ modelConfidence: 0.98, tier: "low", independentSources: 1 })).toBeLessThanOrEqual(0.6);
  });

  it("allows high confidence only with corroborated primary sources", () => {
    expect(calibrateFactConfidence({ modelConfidence: 0.95, tier: "primary", independentSources: 4 })).toBe(0.95);
  });

  it("keeps interpretation below fact confidence", () => {
    const fact = 0.8;
    expect(calibrateInterpretationConfidence({ modelConfidence: 0.99, factConfidence: fact })).toBeLessThan(fact);
  });
});

describe("importance", () => {
  it("scores a corroborated critical event far above routine commentary", () => {
    const big = computeImportance({
      severity: "critical",
      relevance: 0.95,
      tier: "primary",
      independentSources: 5,
      marketMovePct: 4,
      novelty: 1,
    });
    const small = computeImportance({
      severity: "low",
      relevance: 0.3,
      tier: "low",
      independentSources: 1,
      marketMovePct: 0,
      novelty: 0.1,
    });
    expect(big).toBeGreaterThan(90);
    expect(small).toBeLessThan(30);
    expect(importanceBand(big)).toBe("critical");
    expect(importanceBand(small)).toBe("minor");
  });

  it("penalises repeat coverage of an event already known", () => {
    const args = { severity: "high", relevance: 0.8, tier: "high", independentSources: 3 } as const;
    expect(computeImportance({ ...args, isUpdate: true })).toBeLessThan(computeImportance({ ...args }));
  });
});

describe("alert policy", () => {
  const base = { importance: 78, isBaseline: false, isNewEvent: true, nowIso: day };

  it("never alerts on the baseline sweep", () => {
    expect(alertDecision({ ...base, isBaseline: true }).alert).toBe(false);
  });

  it("alerts once on a significant new event", () => {
    expect(alertDecision(base)).toEqual({ alert: true, reason: "new_significant_event" });
  });

  it("stays quiet below the sensitivity threshold", () => {
    expect(alertDecision({ ...base, importance: 60 }).reason).toBe("below_threshold");
    expect(alertDecision({ ...base, importance: 60, sensitivity: "high" }).alert).toBe(true);
  });

  it("does not re-alert on non-material follow-up coverage", () => {
    expect(alertDecision({ ...base, isNewEvent: false, isMaterialUpdate: false }).reason).toBe("no_material_change");
  });

  it("respects the cooldown for material updates", () => {
    const quiet = alertDecision({
      ...base,
      isNewEvent: false,
      isMaterialUpdate: true,
      lastAlertedAt: "2026-03-04T06:00:00.000Z",
    });
    expect(quiet).toEqual({ alert: false, reason: "cooldown" });
    const later = alertDecision({
      ...base,
      isNewEvent: false,
      isMaterialUpdate: true,
      lastAlertedAt: "2026-03-03T06:00:00.000Z",
    });
    expect(later.alert).toBe(true);
  });
});

describe("updates and novelty", () => {
  it("treats fresh corroboration or escalation as material", () => {
    expect(
      isMaterialUpdate({
        newIndependentSources: 2,
        previousImportance: 70,
        importance: 71,
        previousSeverity: "high",
        severity: "high",
      }),
    ).toBe(true);
    expect(
      isMaterialUpdate({
        newIndependentSources: 1,
        previousImportance: 70,
        importance: 71,
        previousSeverity: "high",
        severity: "high",
      }),
    ).toBe(false);
    expect(
      isMaterialUpdate({
        newIndependentSources: 0,
        previousImportance: 70,
        importance: 72,
        previousSeverity: "high",
        severity: "critical",
      }),
    ).toBe(true);
  });

  it("matches follow-up coverage onto the stored event", () => {
    const known = [
      {
        id: "e1",
        title: "Federal Reserve holds rates unchanged at 4.25%",
        published_at: day,
      },
    ];
    const match = matchExistingEvent(
      { title: "Fed keeps interest rates steady at 4.25% after meeting", published_at: day },
      known,
    );
    expect(match?.id).toBe("e1");
  });

  it("scores repeated themes as low novelty", () => {
    const known = [{ title: "Fed holds interest rates unchanged at 4.25%" }];
    expect(noveltyScore({ title: "Fed keeps interest rates unchanged at 4.25%" }, known)).toBeLessThan(0.5);
    expect(noveltyScore({ title: "Tanker attacked in Red Sea shipping lane" }, known)).toBeGreaterThan(0.6);
  });
});

describe("causality guard", () => {
  it("rewrites causal claims into coincidence language", () => {
    const text = "Gold rose because of the attack, which caused a flight to safety.";
    expect(containsCausalClaim(text)).toBe(true);
    const soft = softenCausality(text);
    expect(soft).not.toMatch(/because of|caused/i);
    expect(soft).toMatch(/amid|coincided with/i);
  });
});
