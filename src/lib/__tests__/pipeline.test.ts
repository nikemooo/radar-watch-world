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
import { countryAttribute, countryConstraint, inferMarket, requiredMarkets } from "../monitoring/geo";
import { buildHistory, hostPriority } from "../search/source-priority.server";
import { effectiveVerdict } from "../monitoring/verification";
import {
  enrichFromEvidence,
  mergeAttributeMaps,
  missingKeys,
  parseStructured,
  largestSrcCandidate,
  isLikelyContentImage,
} from "../monitoring/enrichment";
import { cleanListingUrl, resolveListingUrl } from "../search/listing-url";


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
      [{ attribute: "color", observation: "svart bil", value: "svart", confidence: "high", image_url: "https://x/1.jpg" }],
    );
    expect(v.status).toBe("unverified");
  });
});

// ---------------------------------------------------------------------------
// Deterministic enrichment: structured parsing + evidence merging.
// ---------------------------------------------------------------------------
describe("structured parsing", () => {
  const html = `<html><head>
    <meta property="og:title" content="BMW M340i xDrive 2023">
    <meta property="og:image" content="https://cdn.x.se/a.jpg">
    <script type="application/ld+json">{"@type":"Car","name":"BMW M340i xDrive","modelDate":"2023","color":"Svart","offers":{"price":"519000","priceCurrency":"SEK"}}</script>
    </head><body><table><tr><th>Modellår</th><td>2023</td></tr><tr><th>Färg</th><td>Svart</td></tr></table></body></html>`;

  it("reads OpenGraph, JSON-LD and spec-table fields", () => {
    const st = parseStructured(html, "https://x.se/annons/1");
    expect(st.og["title"]).toContain("M340i");
    expect(JSON.stringify(st.jsonld)).toContain("519000");
    expect(st.images).toContain("https://cdn.x.se/a.jpg");
    expect(Object.keys(st.fields).some((k) => k.toLowerCase().includes("färg"))).toBe(true);
  });

  it("extracts declared attributes from evidence without a model", () => {
    const st = parseStructured(html, "https://x.se/annons/1");
    const specs = [
      { key: "price", label: "Pris", kind: "money" as const },
      { key: "year", label: "Modellår", kind: "year" as const },
      { key: "color", label: "Färg", kind: "text" as const },
    ];
    const result = enrichFromEvidence(specs, [
      { url: "https://x.se/annons/1", sourceType: "detail_field", fields: st.fields, text: "" },
      { url: "https://x.se/annons/1", sourceType: "jsonld", fields: st.jsonld, text: Object.values(st.jsonld).join(" ") },
    ]);
    expect(result.attributes["year"]?.value).toBe(2023);
    expect(result.attributes["color"]?.raw?.toLowerCase()).toContain("svart");
    expect(result.telemetry.attributesFound).toBeGreaterThanOrEqual(2);
  });
});

describe("evidence merging", () => {
  const spec = { key: "year", label: "Modellår", kind: "year" as const };
  const structured = normalizeAttribute(spec, "2023", "structured", "https://x.se/1");
  const inferred = normalizeAttribute(spec, "2021", "inferred", "https://x.se/1");

  it("never downgrades a stronger value", () => {
    const { merged } = mergeAttributeMaps({ year: structured }, { year: inferred });
    expect(merged["year"]?.value).toBe(2023);
    expect(merged["year"]?.confidence).toBe("structured");
  });

  it("upgrades an unknown value when real evidence arrives", () => {
    const unknown = normalizeAttribute(spec, null, "unknown", "https://x.se/1");
    const { merged, merges } = mergeAttributeMaps({ year: unknown }, { year: structured });
    expect(merged["year"]?.value).toBe(2023);
    expect(merges).toBe(1);
  });

  it("reports which declared attributes are still missing", () => {
    const specs = [spec, { key: "color", label: "Färg", kind: "text" as const }];
    expect(missingKeys(specs, { year: structured })).toEqual(["color"]);
  });
});

describe("geographic relevance", () => {
  it("establishes the market from a country-code TLD", () => {
    const v = inferMarket({ url: "https://www.blocket.se/annons/123" });
    expect(v.market?.code).toBe("SE");
    expect(v.confidence).toBe("structured");
  });

  it("prefers a stated address country over the host TLD", () => {
    const v = inferMarket({
      url: "https://cars.com/listing/9",
      fields: { addressCountry: "Germany" },
    });
    expect(v.market?.code).toBe("DE");
    expect(v.confidence).toBe("structured");
  });

  it("never infers a market from currency alone", () => {
    const v = inferMarket({ url: "https://cars.com/listing/9", currency: "SEK" });
    expect(v.market).toBeNull();
    expect(countryAttribute(v)).toBeNull();
  });

  it("rejects a listing proven to be in another market", () => {
    const constraint = countryConstraint(["Sverige"])!;
    const attribute = countryAttribute(inferMarket({ url: "https://mobile.de/x/1" }))!;
    const verdict = evaluateCriteria(
      { title: "BMW", attributes: { country: attribute }, numericValue: null, currency: null },
      [constraint],
    );
    expect(verdict.status).toBe("reject");
  });

  it("leaves an unproven market unverified rather than matching", () => {
    const constraint = countryConstraint(["Sverige"])!;
    const verdict = evaluateCriteria(
      { title: "BMW", attributes: {}, numericValue: null, currency: null },
      [constraint],
    );
    expect(verdict.status).toBe("unverified");
  });

  it("adds no country requirement when the radar named several markets", () => {
    expect(countryConstraint(["Sweden", "Norway"])).toBeNull();
    expect(countryConstraint([])).toBeNull();
  });
});

describe("source priority", () => {
  const history = buildHistory(
    [
      { url: null, primary_url: "https://www.blocket.se/a/1", snapshot: { match_status: "match" } },
      { url: null, primary_url: "https://www.blocket.se/a/2", snapshot: { match_status: "match" } },
      { url: null, primary_url: "https://spec-site.com/bmw", snapshot: { match_status: "reject" } },
    ],
    [{ host: "spec-site.com", attempts: 10, successes: 1 }],
  );
  const ctx = { markets: requiredMarkets(["Sverige"]), history };

  it("ranks a proven in-market marketplace above an unreliable spec site", () => {
    expect(hostPriority("blocket.se", ctx).score).toBeGreaterThan(
      hostPriority("spec-site.com", ctx).score,
    );
  });

  it("treats an unknown host as neutral, never excluded", () => {
    expect(hostPriority("brand-new-market.se", ctx).score).toBeGreaterThan(0);
  });

  it("never turns a page without item evidence into a selected index page", () => {
    const { picked } = selectIndexPages(
      [{ title: "About", url: "https://blocket.se/om-oss", snippet: "text", links: [], retrieved_at: new Date().toISOString(), query: "q" } as never],
      4,
      () => 5,
    );
    expect(picked).toHaveLength(0);
  });
});

describe("availability", () => {
  it("only marks a listing removed when the source proves it", async () => {
    const { removedListings, reasonProvesRemoved, availabilityFromStructured } = await import(
      "../monitoring/availability"
    );
    expect(reasonProvesRemoved("HTTP 404")).toBe(true);
    expect(reasonProvesRemoved("timeout")).toBe(false);
    expect(availabilityFromStructured("https://schema.org/SoldOut")).toBe("removed");
    expect(availabilityFromStructured("InStock")).toBe("available");
    expect(availabilityFromStructured(null)).toBe("unknown");

    const gone = removedListings(
      [
        { url: "https://a.se/annons/1", reason: "HTTP 410 Gone" },
        { url: "https://a.se/annons/2", reason: "network timeout" },
        { url: "https://a.se/annons/3", reason: "HTTP 404" },
      ],
      ["https://a.se/annons/1", "https://a.se/annons/2"],
    );
    expect(gone.map((g) => g.url)).toEqual(["https://a.se/annons/1"]);
  });
});

describe("direct listing urls", () => {
  it("separates item pages from search and category pages", async () => {
    const { looksLikeItemUrl } = await import("../search/url-shape");
    expect(looksLikeItemUrl("https://www.blocket.se/annons/bmw-m340i/12345678")).toBe(true);
    expect(looksLikeItemUrl("https://shop.example.com/p/rolex-submariner-124060-full-set")).toBe(true);
    expect(looksLikeItemUrl("https://www.blocket.se/annonser/hela_sverige?q=bmw")).toBe(false);
    expect(looksLikeItemUrl("https://www.blocket.se/")).toBe(false);
    expect(looksLikeItemUrl("not a url")).toBe(false);
  });
});

describe("listing url resolution", () => {
  it("prefers a same-host canonical item URL and marks it direct", () => {
    const r = resolveListingUrl({
      requestedUrl: "https://www.blocket.se/annons/goteborg/bmw/1234567?utm_source=x#gallery",
      finalUrl: "https://www.blocket.se/annons/goteborg/bmw/1234567",
      canonical: "https://www.blocket.se/annons/goteborg/bmw/1234567",
    });
    expect(r.status).toBe("direct");
    expect(r.source).toBe("canonical");
    expect(r.url).toBe("https://www.blocket.se/annons/goteborg/bmw/1234567");
  });

  it("never claims a search/index page is the advert", () => {
    const r = resolveListingUrl({ requestedUrl: "https://www.blocket.se/annonser/hela_sverige?q=bmw" });
    expect(r.status).toBe("unverified");
  });

  it("strips tracking parameters and hashes", () => {
    expect(cleanListingUrl("https://x.se/annons/1?gclid=a&color=black#top")).toBe(
      "https://x.se/annons/1?color=black",
    );
  });
});

describe("image extraction", () => {
  it("takes the largest srcset rendition", () => {
    expect(largestSrcCandidate("/a-320.jpg 320w, /a-1200.jpg 1200w, /a-640.jpg 640w")).toBe("/a-1200.jpg");
    expect(largestSrcCandidate("  /solo.jpg  ")).toBe("/solo.jpg");
  });

  it("rejects site chrome and data URIs but accepts extensionless CDN photos", () => {
    expect(isLikelyContentImage("https://cdn.x.se/logo.png")).toBe(false);
    expect(isLikelyContentImage("data:image/png;base64,AAA")).toBe(false);
    expect(isLikelyContentImage("https://cdn.x.se/icons/star.svg")).toBe(false);
    expect(isLikelyContentImage("https://cdn.x.se/images/abc123?width=1200")).toBe(true);
    expect(isLikelyContentImage("https://cdn.x.se/photos/abc.jpg?w=800")).toBe(true);
  });

  it("finds gallery images embedded as JSON in a client-rendered page", () => {
    const html = `<html><body><script>window.__D={"images":["https:\\/\\/cdn.x.se\\/media\\/one.jpg","https:\\/\\/cdn.x.se\\/media\\/two.jpg"]}</script></body></html>`;
    const s = parseStructured(html, "https://x.se/annons/1");
    expect(s.images).toContain("https://cdn.x.se/media/one.jpg");
    expect(s.images).toContain("https://cdn.x.se/media/two.jpg");
  });
});
