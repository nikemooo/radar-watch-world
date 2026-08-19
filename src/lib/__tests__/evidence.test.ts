import { describe, expect, it } from "vitest";
import {
  applyVisualEvidence,
  collectAttributeEvidence,
  imageEvidence,
  storableEvidence,
  structuredPrice,
} from "../monitoring/evidence";
import { detectIdentifiers, mergeIdentifiers, sameItem } from "../monitoring/identifiers";
import type { EvidenceDoc } from "../monitoring/enrichment";
import type { AttributeSpec } from "../monitoring/normalize";

const specs: AttributeSpec[] = [
  { key: "price", label: "Price", kind: "money" },
  { key: "color", label: "Colour", kind: "text" },
  { key: "model_year", label: "Model year", kind: "year" },
];

const page = "https://example.se/annons/1";

describe("evidence aggregation", () => {
  it("marks a value verified when structured data states it", () => {
    const docs: EvidenceDoc[] = [
      { url: page, sourceType: "jsonld", fields: { price: "519000 SEK" } },
      { url: page, sourceType: "detail_text", text: "Pris: 519 000 kr" },
    ];
    const evidence = collectAttributeEvidence(specs, docs);
    expect(evidence["price"]!.status).toBe("verified");
    expect(evidence["price"]!.confidence).toBeGreaterThan(0.9);
    expect(evidence["price"]!.records.length).toBeGreaterThan(1);
  });

  it("marks a value probable when only one prose source states it", () => {
    const docs: EvidenceDoc[] = [{ url: page, sourceType: "detail_text", text: "Färg: Svart" }];
    const evidence = collectAttributeEvidence(specs, docs);
    expect(evidence["color"]!.status).toBe("probable");
    expect(evidence["color"]!.value?.raw?.toLowerCase()).toContain("svart");
  });

  it("reports a conflict when two factual sources disagree", () => {
    const docs: EvidenceDoc[] = [
      { url: page, sourceType: "detail_field", fields: { färg: "Svart" } },
      { url: page, sourceType: "index_card", text: "Färg: Vit" },
    ];
    const evidence = collectAttributeEvidence(specs, docs);
    expect(evidence["color"]!.status).toBe("conflicted");
    expect(evidence["color"]!.conflicts.length).toBe(1);
    expect(evidence["color"]!.confidence).toBeLessThanOrEqual(0.45);
  });

  it("keeps an unstated attribute unknown and never invents a value", () => {
    const evidence = collectAttributeEvidence(specs, [
      { url: page, sourceType: "detail_text", text: "Trevlig bil till salu." },
    ]);
    expect(evidence["model_year"]!.status).toBe("unknown");
    expect(evidence["model_year"]!.value).toBeNull();
  });
});

describe("visual evidence", () => {
  const base = () =>
    collectAttributeEvidence(specs, [{ url: page, sourceType: "detail_text", text: "Färg: Svart" }]);

  it("fills a gap but never reaches verified", () => {
    const evidence = collectAttributeEvidence(specs, [
      { url: page, sourceType: "detail_text", text: "Bil till salu." },
    ]);
    const merged = applyVisualEvidence(evidence, specs, [
      { attribute: "color", value: "svart", confidence: "high", image_url: "https://img/1.jpg" },
    ]);
    expect(merged["color"]!.status).toBe("probable");
    expect(merged["color"]!.value?.raw).toBe("svart");
  });

  it("contradicts a stated value instead of overwriting it", () => {
    const merged = applyVisualEvidence(base(), specs, [
      { attribute: "color", value: "vit", confidence: "high", image_url: "https://img/1.jpg" },
    ]);
    expect(merged["color"]!.status).toBe("conflicted");
    expect(merged["color"]!.value?.raw?.toLowerCase()).toContain("svart");
  });

  it("ignores observations the model could not make", () => {
    const merged = applyVisualEvidence(base(), specs, [
      { attribute: "color", value: null, confidence: "none", image_url: "https://img/1.jpg" },
    ]);
    expect(merged["color"]!.status).toBe("probable");
  });
});

describe("price and image evidence", () => {
  it("reads a price out of structured commerce metadata", () => {
    expect(structuredPrice({ price: "519000", pricecurrency: "SEK" })).toEqual({
      raw: "519000 SEK",
      currency: "SEK",
    });
    expect(structuredPrice({ description: "nice car" })).toBeNull();
  });

  it("records missing imagery as unavailable rather than hiding it", () => {
    expect(imageEvidence({ pageUrl: page, primary: null, images: [] }).status).toBe("unavailable");
    const found = imageEvidence({ pageUrl: page, primary: "https://img/a.jpg", images: ["https://img/b.jpg"] });
    expect(found.status).toBe("from_listing");
    expect(found.images).toHaveLength(2);
  });

  it("stores evidence in a compact, explainable shape", () => {
    const stored = storableEvidence(
      collectAttributeEvidence(specs, [{ url: page, sourceType: "jsonld", fields: { price: "500000 SEK" } }]),
    );
    const price = stored.find((s) => s.attribute === "price")!;
    expect(price.status).toBe("verified");
    expect(price.sources.length).toBeGreaterThan(0);
    expect(price.explanation).toContain("Price");
  });
});

describe("generic identifiers", () => {
  it("finds a labelled VIN and rejects an invalid one", () => {
    const ids = detectIdentifiers({ url: page, text: "Chassinummer: WBA8E9105J5K12345" });
    expect(ids.some((i) => i.type === "vin" && i.value.includes("WBA8E9105J5K12345"))).toBe(true);
    expect(detectIdentifiers({ url: page, text: "Chassinummer: IOQ" })).toHaveLength(0);
  });

  it("finds a watch reference and a product SKU from labelled fields", () => {
    const ids = detectIdentifiers({
      url: page,
      fields: { referensnummer: "126610LN", artikelnummer: "SKU-9912" },
    });
    expect(ids.map((i) => i.type).sort()).toEqual(["reference", "sku"]);
  });

  it("treats a shared strong identifier as the same physical item", () => {
    const a = detectIdentifiers({ url: page, text: "VIN: WBA8E9105J5K12345" });
    const b = detectIdentifiers({ url: "https://other.se/x", text: "Chassinummer WBA8E9105J5K12345" });
    expect(sameItem(a, b)).toBe(true);
    expect(mergeIdentifiers([a, b]).length).toBe(1);
  });
});
