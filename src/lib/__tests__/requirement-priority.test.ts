import { describe, expect, it } from "vitest";
import { evaluateCriteria, type HardConstraint } from "@/lib/monitoring/criteria";
import { deepVerify, matchScore, type VerifiedRequirement } from "@/lib/monitoring/deep-verify";
import { evaluateSemanticCriterion, storableSemantics } from "@/lib/monitoring/semantic";

const PAGE = "https://example.se/bostad/8";

/**
 * "Lägenheter i Nacka med havsutsikt, gärna balkong mot vattnet. Helst under
 * 5 miljoner." — location, dwelling and view are REQUIREMENTS; balcony and the
 * budget are PREFERENCES that rank but never exclude.
 */
const constraints: HardConstraint[] = [
  { attribute: "property_type", op: "includes", value: "lägenhet", label: "Lägenhet" },
  { attribute: "location", op: "includes", value: "Nacka", kind: "geo", label: "Nacka" },
  { attribute: "view", op: "includes", value: "havsutsikt", label: "Havsutsikt" },
  { attribute: "balcony", op: "includes", value: "balkong", label: "Balkong mot vattnet", priority: "preferred" },
  { attribute: "price", op: "lte", value: 5_000_000, currency: "SEK", label: "Pris ≤ 5 000 000 SEK", priority: "preferred" },
];

const subject = {
  title: "Finnboda kajväg 8, Nacka — Lägenhet",
  text: "Ljus lägenhet i Nacka med fantastisk utsikt över havet.",
  attributes: {
    property_type: { key: "property_type", raw: "lägenhet", value: null, unit: null, confidence: "high" as const },
    location: { key: "location", raw: "Nacka", value: null, unit: null, confidence: "high" as const },
    view: { key: "view", raw: "havsutsikt", value: null, unit: null, confidence: "high" as const },
  },
  numericValue: 5_795_000,
  currency: "SEK",
};

describe("requirements versus preferences", () => {
  it("matches when every requirement holds even though the price preference is exceeded", () => {
    const base = evaluateCriteria(subject, constraints);
    expect(base.status).toBe("match");
    const deep = deepVerify(base, []);
    expect(deep.status).toBe("match");
    expect(deep.requirements.find((r) => r.attribute === "price")?.priority).toBe("preferred");
    // Exceeding the budget costs score, never eligibility.
    expect(deep.score).toBeLessThan(100);
    expect(deep.score).toBeGreaterThan(60);
  });

  it("still rejects when a real requirement is contradicted", () => {
    const elsewhere = { ...subject, attributes: { ...subject.attributes, location: { key: "location", raw: "Solna", value: null, unit: null, confidence: "high" as const } } };
    expect(evaluateCriteria(elsewhere, constraints).status).toBe("reject");
  });

  it("scores a fully satisfied listing at 100", () => {
    const perfect = { ...subject, numericValue: 4_500_000, attributes: { ...subject.attributes, balcony: { key: "balcony", raw: "balkong", value: null, unit: null, confidence: "high" as const } } };
    const deep = deepVerify(evaluateCriteria(perfect, constraints), []);
    expect(deep.status).toBe("match");
    expect(deep.score).toBe(100);
  });

  it("explains an open requirement instead of saying it could not be verified", () => {
    const thin = { ...subject, attributes: { property_type: subject.attributes.property_type, location: subject.attributes.location } };
    const deep = deepVerify(evaluateCriteria(thin, constraints), []);
    expect(deep.status).toBe("unverified");
    const view = deep.requirements.find((r) => r.attribute === "view")!;
    expect(view.reason).toContain("Havsutsikt");
    expect(view.reason).not.toBe("could not be verified");
  });

  it("reads the dwelling type from the page wording", () => {
    const v = evaluateSemanticCriterion("lägenhet", [
      { url: PAGE, kind: "title", text: "Finnboda kajväg 8, Nacka — Bostadsrätt, 3 rum" },
    ]);
    expect(v.status).toBe("confirmed");
    expect(storableSemantics([v])[0]?.snippet).toContain("Bostadsrätt");
  });

  it("weights preferences at a quarter of the score", () => {
    const rows: VerifiedRequirement[] = [
      { attribute: "a", label: "a", status: "match", verdict: "verified", reason: "", evidence: null, source: "attribute", priority: "required" },
      { attribute: "b", label: "b", status: "reject", verdict: "rejected", reason: "", evidence: null, source: "attribute", priority: "preferred" },
    ];
    expect(matchScore(rows)).toBe(75);
  });
});
