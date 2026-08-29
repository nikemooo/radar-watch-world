import { describe, expect, it } from "vitest";
import { extractListingFacts, verifyPlace } from "@/lib/monitoring/listing-extract";
import { evaluateSemanticCriterion } from "@/lib/monitoring/semantic";
import { extractListingImages, imageKey, isContentImage, sameOperator } from "@/lib/monitoring/images";

const PAGE = "https://example.se/bostad/12345";

describe("listing facts", () => {
  it("reads measures from labelled fields and text", () => {
    const out = extractListingFacts({
      url: PAGE,
      title: "Ljus trea i Finnboda Hamn",
      text: "Boarea 82 m² fördelat på 3 rum. Våning 4 av 6. Avgift: 4 210 kr/mån.",
      fields: { boarea: "82 m²" },
    });
    expect(out.facts["area"]?.value).toBe(82);
    expect(out.facts["area"]?.confidence).toBe("structured");
    expect(out.facts["rooms"]?.value).toBe(3);
    expect(out.facts["floor"]?.value).toBe(4);
    expect(out.facts["monthly_fee"]?.value).toBe(4210);
  });

  it("never invents a fact the page does not state", () => {
    const out = extractListingFacts({ url: PAGE, title: "Bostad till salu", text: "Trevlig bostad." });
    expect(out.facts["area"]).toBeUndefined();
    expect(out.facts["rooms"]).toBeUndefined();
  });

  it("detects sold and reserved offers", () => {
    expect(extractListingFacts({ url: PAGE, title: "Såld – Volvo V60", text: "" }).status.status).toBe("sold");
    expect(
      extractListingFacts({ url: PAGE, title: "Lägenhet", text: "Budgivning pågår just nu." }).status.status,
    ).toBe("reserved");
    expect(
      extractListingFacts({ url: PAGE, jsonld: { availability: "https://schema.org/InStock" } }).status.status,
    ).toBe("active");
  });

  it("verifies place from stated address, not from marketing copy", () => {
    const stated = extractListingFacts({
      url: PAGE,
      text: "Adress: Finnbodavägen 2, Nacka",
    });
    expect(verifyPlace("Nacka", stated, "").status).toBe("confirmed");

    const mentioned = extractListingFacts({ url: PAGE, text: "Nära Finnboda Hamn och Nacka strand." });
    expect(verifyPlace("Nacka", mentioned, "Nära Finnboda Hamn och Nacka strand.").status).toBe("probable");

    const elsewhere = extractListingFacts({ url: PAGE, text: "Adress: Storgatan 1, Göteborg" });
    expect(verifyPlace("Nacka", elsewhere, "Adress: Storgatan 1, Göteborg").status).toBe("contradicted");
  });
});

describe("semantic criteria", () => {
  const surfaces = (text: string, kind: "text" | "field" = "text") => [{ url: PAGE, kind, text }];

  it("confirms an exact synonym", () => {
    const v = evaluateSemanticCriterion("havsutsikt", surfaces("Fantastisk sjöutsikt från vardagsrummet."));
    expect(v.status).toBe("confirmed");
    expect(v.snippet).toContain("sjöutsikt");
  });

  it("keeps adjacent wording probable, never confirmed", () => {
    const v = evaluateSemanticCriterion("havsutsikt", surfaces("Sjönära läge med gångavstånd till bryggan."));
    expect(v.status).toBe("probable");
  });

  it("respects negation", () => {
    const v = evaluateSemanticCriterion("balkong", surfaces("Lägenheten saknar balkong men har stor uteplats?"));
    expect(v.status).toBe("contradicted");
  });

  it("treats a shared terrace as weaker evidence for a balcony", () => {
    const v = evaluateSemanticCriterion("balkong", surfaces("Gemensam takterrass finns i föreningen."));
    expect(v.status).toBe("probable");
  });

  it("is unknown when the listing never addresses it", () => {
    expect(evaluateSemanticCriterion("garage", surfaces("Trevlig lägenhet.")).status).toBe("unknown");
  });
});

describe("images", () => {
  it("rejects chrome and accepts content photos", () => {
    expect(isContentImage("https://cdn.example.se/logo.png")).toBe(false);
    expect(isContentImage("https://cdn.example.se/media/listing-1.jpg")).toBe(true);
    expect(isContentImage("data:image/png;base64,AAA")).toBe(false);
  });

  it("dedupes renditions of the same photo", () => {
    expect(imageKey("https://cdn.example.se/img/a.jpg?w=1200")).toBe(
      imageKey("https://cdn.example.se/img/a.jpg?w=400"),
    );
  });

  it("recognises the listing's own image CDN", () => {
    expect(sameOperator("https://images.example.se/a.jpg", "https://www.example.se/x")).toBe(true);
    expect(sameOperator("https://other.com/a.jpg", "https://www.example.se/x")).toBe(false);
  });

  it("extracts, ranks and deduplicates gallery photos", () => {
    const html = `
      <meta property="og:image" content="https://images.example.se/hero.jpg">
      <link rel="preload" as="image" href="https://images.example.se/second.jpg">
      <picture><source srcset="https://images.example.se/third-400.jpg 400w, https://images.example.se/third-1600.jpg 1600w"></picture>
      <img src="/static/logo.png"><img data-src="https://images.example.se/hero.jpg?w=200">
    `;
    const out = extractListingImages(html, PAGE);
    expect(out.primary).toBe("https://images.example.se/hero.jpg");
    expect(out.images).toHaveLength(3);
    expect(out.images.some((u) => u.includes("logo"))).toBe(false);
    expect(out.images.some((u) => u.includes("third-1600"))).toBe(true);
  });
});
