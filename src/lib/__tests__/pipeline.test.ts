/**
 * Regression suite for the deterministic parts of the Radar pipeline.
 *
 * Everything tested here must be reproducible without a model and without the
 * network: price parsing, constraint matching, pagination detection, index-row
 * price joining, and index-page selection.
 */
import { describe, expect, it } from "vitest";
import { normalizeAttribute } from "../monitoring/normalize";
import { containsToken, evaluateCriteria, type HardConstraint } from "../monitoring/criteria";
import { detectPaginationLinks, extractIndexRowPrices, moneyMatchesIn } from "../search/index-rows";
import { selectIndexPages } from "../search/index-expansion.server";
import { assignFingerprints } from "../monitoring/temporal";
import { effectiveVerdict } from "../monitoring/verification";


const priceSpec = { key: "price", label: "Price", kind: "money" as const };
const norm = (raw: string) => normalizeAttribute(priceSpec, raw, "stated", "https://x.se/annons/1");

describe("money normalization", () => {
  it("reads Swedish thin/space grouped prices", () => {
    const v = norm("579 000 kr");
    expect(v.value).toBe(579000);
    expect(v.currency).toBe("SEK");
  });

  it("reads grouped euro and dollar prices", () => {
    expect(norm("€42.500").value).toBe(42500);
    expect(norm("$12,995").value).toBe(12995);
    expect(norm("$12,995").currency).toBe("USD");
  });

  it("refuses to invent a value from junk", () => {
    expect(norm("call for price").value).toBeNull();
  });
});

describe("index-row price qualifiers", () => {
  it("marks monthly and tax-variant prices as qualified", () => {
    const matches = moneyMatchesIn("579 000 kr  4 899 kr/mån  463 200 kr exkl. moms");
    expect(matches.length).toBeGreaterThanOrEqual(3);
    expect(matches.filter((m) => !m.qualified).map((m) => m.raw)).toEqual(["579 000 kr"]);
  });

  it("joins exactly one unambiguous price per item row", () => {
    const html = `
      <ul>
        <li><a href="https://x.se/annons/1">M340i</a><span>579 000 kr</span><span>4 899 kr/mån</span></li>
        <li><a href="https://x.se/annons/2">M340i</a><span>612 000 kr</span></li>
      </ul>`;
    const items = new Set(["https://x.se/annons/1", "https://x.se/annons/2"]);
    const res = extractIndexRowPrices(html, "https://x.se/bilar", items);
    expect(res.ambiguous.length).toBe(0);
    expect([...res.hints.values()].map((h) => h.raw).sort()).toEqual(["579 000 kr", "612 000 kr"]);
    expect([...res.hints.values()][0]?.sourceUrl).toBe("https://x.se/bilar");
  });
});

describe("pagination detection", () => {
  it("finds query-parameter pages ahead of the current one", () => {
    const next = detectPaginationLinks(
      ["https://x.se/bilar?page=1", "https://x.se/bilar?page=2", "https://x.se/bilar?page=3"],
      "https://x.se/bilar?page=1",
    );
    expect(next).toEqual(["https://x.se/bilar?page=2", "https://x.se/bilar?page=3"]);
  });

  it("finds path-style pages and never goes backwards", () => {
    const next = detectPaginationLinks(
      ["https://x.se/bilar/page/2", "https://x.se/bilar/page/3", "https://x.se/bilar/page/1"],
      "https://x.se/bilar/page/2",
    );
    expect(next).toEqual(["https://x.se/bilar/page/3"]);
  });

  it("ignores other hosts", () => {
    expect(detectPaginationLinks(["https://other.se/bilar?page=2"], "https://x.se/bilar")).toEqual([]);
  });
});

describe("deterministic criteria", () => {
  const constraints: HardConstraint[] = [
    { attribute: "price", op: "lte", value: 600000, currency: "SEK", label: "price <= 600 000 SEK" },
    { attribute: "color", op: "includes", value: "black", aliases: ["svart"] },
  ];
  const subject = (price: number | null, color: string | null, currency = "SEK") => ({
    title: "BMW M340i xDrive",
    attributes: {
      ...(price === null
        ? {}
        : {
            price: {
              key: "price",
              raw: `${price} kr`,
              value: price,
              currency,
              unit: null,
              confidence: "stated" as const,
              source_url: "https://x.se/annons/1",
            },
          }),
      ...(color === null
        ? {}
        : {
            color: {
              key: "color",
              raw: color,
              value: null,
              currency: null,
              unit: null,
              confidence: "stated" as const,
              source_url: "https://x.se/annons/1",
            },
          }),
    },
    numericValue: price,
    currency,
  });

  it("accepts an item inside every constraint", () => {
    const v = evaluateCriteria(subject(579000, "Svart"), constraints);
    expect(v.status).toBe("match");
  });

  it("rejects an item above the price ceiling with an exact reason", () => {
    const v = evaluateCriteria(subject(714800, "Svart"), constraints);
    expect(v.status).toBe("reject");
    expect(v.reason).toMatch(/714\s?800/);
  });

  it("never passes an item whose fact is missing", () => {
    expect(evaluateCriteria(subject(null, "Svart"), constraints).status).toBe("unverified");
  });

  it("never compares across currencies", () => {
    expect(evaluateCriteria(subject(55000, "Svart", "EUR"), constraints).status).toBe("unverified");
  });

  it("matches aliases and folds diacritics", () => {
    expect(containsToken("Helt svart lackering", "svart")).toBe(true);
    expect(containsToken("Grå metallic", "gra")).toBe(true);
    expect(containsToken("blackberry", "black")).toBe(false);
  });
});

describe("identity fingerprints", () => {
  it("keeps one identity per item URL across sweeps", () => {
    const a = assignFingerprints([{ url: "https://x.se/annons/1?utm=x", title: "M340i" }]);
    const b = assignFingerprints([{ url: "https://x.se/annons/1", title: "M340i xDrive" }]);
    expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
  });

  it("separates two items published on the same path shape", () => {
    const [x, y] = assignFingerprints([
      { url: "https://x.se/annons/1", title: "M340i Svart" },
      { url: "https://x.se/annons/2", title: "M340i Vit" },
    ]);
    expect(x!.fingerprint).not.toBe(y!.fingerprint);
  });
});

describe("index page selection", () => {
  const doc = (url: string, links: string[]) => ({
    title: url,
    url,
    snippet: "x",
    retrieved_at: new Date().toISOString(),
    query: "q",
    links,
  });

  it("prefers a marketplace with item-like URLs over a deep media tree", () => {
    const res = selectIndexPages(
      [
        doc("https://market.se/bilar", [
          "https://market.se/annons/1234567",
          "https://market.se/annons/2234567",
          "https://market.se/annons/3234567",
        ]),
        doc("https://wiki.example/specs/bmw/m340i/2021/gallery", [
          "https://wiki.example/specs/bmw/m340i/2021/gallery/a.jpg",
          "https://wiki.example/specs/bmw/m340i/2021/gallery/b.jpg",
        ]),
      ],
      1,
    );
    expect(res.picked[0]?.url).toContain("market.se");
  });

  it("explains every candidate in telemetry", () => {
    const res = selectIndexPages([doc("https://market.se/bilar", [
        "https://market.se/annons/1234567",
        "https://market.se/annons/2234567",
        "https://market.se/annons/3234567",
      ])], 1);
    expect(res.telemetry.length).toBe(1);
    expect(res.telemetry[0]!.reason.length).toBeGreaterThan(0);
  });
});

describe("effective verification verdict", () => {
  const outcome = (attribute: string, status: "match" | "reject" | "unverified") => ({
    constraint: { attribute, op: "includes" as const, value: attribute },
    status,
    reason: `${attribute}: ${status}`,
    observedRaw: null,
  });

  it("never lets a user answer rescue a machine-rejected listing", () => {
    const v = effectiveVerdict(
      [outcome("price", "reject"), outcome("color", "unverified")],
      [
        { attribute: "price", verdict: "pass" },
        { attribute: "color", verdict: "pass" },
      ],
    );
    expect(v.status).toBe("reject");
    expect(v.userInfluenced).toBe(false);
  });

  it("promotes an unverified listing only when every requirement is resolved", () => {
    const outcomes = [outcome("color", "unverified"), outcome("year", "unverified")];
    expect(effectiveVerdict(outcomes, [{ attribute: "color", verdict: "pass" }]).status).toBe("unverified");
    const full = effectiveVerdict(outcomes, [
      { attribute: "color", verdict: "pass" },
      { attribute: "year", verdict: "pass" },
    ]);
    expect(full.status).toBe("match");
    expect(full.userInfluenced).toBe(true);
  });

  it("treats image evidence as display-only, never as proof", () => {
    const v = effectiveVerdict(
      [outcome("color", "unverified")],
      [],
      [{ attribute: "color", observation: "svart bil", confidence: 0.9, imageUrl: "https://x/1.jpg" }],
    );
    expect(v.status).toBe("unverified");
  });
});
