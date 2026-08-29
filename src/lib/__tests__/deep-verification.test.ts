import { describe, expect, it } from "vitest";
import { evaluateSemanticCriterion, storableSemantics, unfetchableVerdict } from "@/lib/monitoring/semantic";
import { deepVerify } from "@/lib/monitoring/deep-verify";
import { evaluateCriteria, type HardConstraint } from "@/lib/monitoring/criteria";
import { extractListingFacts, verifyPlace } from "@/lib/monitoring/listing-extract";
import { extractListingImages } from "@/lib/monitoring/images";
import { extractPrice } from "@/lib/monitoring/price";

const PAGE = "https://example.se/bostad/13b";

const surfaces = (text: string, kind: "description" | "field" | "title" | "snippet" = "description") => [
  { url: PAGE, kind, text },
];

describe("reading the listing description", () => {
  it("verifies a sea view expressed as a view over a named water", () => {
    const v = evaluateSemanticCriterion(
      "havsutsikt",
      surfaces("Från vardagsrummet och den stora balkongen erbjuds en fantastisk utsikt över Stockholms inlopp."),
    );
    expect(v.status).toBe("confirmed");
    expect(v.snippet).toContain("Stockholms inlopp");
  });

  it("verifies sjöutsikt and vattenutsikt", () => {
    expect(evaluateSemanticCriterion("havsutsikt", surfaces("Vacker sjöutsikt från bostadens balkong.")).status).toBe(
      "confirmed",
    );
    expect(
      evaluateSemanticCriterion("havsutsikt", surfaces("Härifrån har du utsikt mot vattnet året om.")).status,
    ).toBe("confirmed");
    expect(evaluateSemanticCriterion("sea view", surfaces("Stunning views over the bay.")).status).toBe("confirmed");
  });

  it("does not treat proximity to water as a view", () => {
    expect(evaluateSemanticCriterion("havsutsikt", surfaces("Med närhet till vattnet.")).status).not.toBe("confirmed");
    expect(evaluateSemanticCriterion("havsutsikt", surfaces("Området ligger nära kajen.")).status).not.toBe(
      "confirmed",
    );
  });

  it("contradicts a sea view when the view is of the courtyard", () => {
    const v = evaluateSemanticCriterion("havsutsikt", surfaces("Utsikt över innergården från köket."));
    expect(v.status).toBe("contradicted");
    expect(v.snippet).toContain("innergård");
  });

  it("verifies a balcony from the description but not from a terrace", () => {
    expect(evaluateSemanticCriterion("balkong", surfaces("Stor inglasad balkong i söderläge.")).status).toBe(
      "confirmed",
    );
    const terrace = evaluateSemanticCriterion("balkong", surfaces("Bostaden har en fin terrass mot söder."));
    expect(terrace.status).toBe("probable");
  });

  it("respects negation in prose", () => {
    expect(evaluateSemanticCriterion("balkong", surfaces("Lägenheten saknar balkong.")).status).toBe("contradicted");
  });

  it("records which part of the page the evidence came from", () => {
    const stored = storableSemantics([
      evaluateSemanticCriterion("balkong", surfaces("Stor balkong mot söder.", "description")),
    ]);
    expect(stored[0]?.source_label).toBe("listing description");
    expect(stored[0]?.snippet).toContain("balkong");
  });
});

describe("place verification", () => {
  it("verifies the municipality from the stated address", () => {
    const stated = extractListingFacts({ url: PAGE, text: "Adress: Finnboda Kajväg 13B, Nacka" });
    expect(verifyPlace("Nacka", stated, "Adress: Finnboda Kajväg 13B, Nacka").status).toBe("confirmed");
  });

  it("does not verify from area marketing copy alone", () => {
    const mentioned = extractListingFacts({ url: PAGE, text: "Nacka är en populär kommun att bo i." });
    expect(verifyPlace("Nacka", mentioned, "Nacka är en populär kommun att bo i.").status).not.toBe("confirmed");
  });
});

describe("prices keep working", () => {
  it("reads the common Swedish formats", () => {
    for (const [text, expected] of [
      ["Pris: 4 495 000 kr", 4495000],
      ["Utgångspris 4,5 Mkr", 4500000],
      ["Pris 4500 tkr", 4500000],
    ] as const) {
      const p = extractPrice({ url: PAGE, text });
      expect(p.value).toBe(expected);
    }
  });
});

describe("images stay bound to the listing", () => {
  it("takes gallery photos from the listing page only", () => {
    const html = `
      <meta property="og:image" content="https://images.example.se/hero.jpg">
      <script type="application/ld+json">{"image":["https://images.example.se/ld.jpg"]}</script>
      <img data-src="https://images.example.se/lazy.jpg">
      <img src="https://cdn.other.com/stock.jpg">
    `;
    const out = extractListingImages(html, PAGE);
    expect(out.primary).toBe("https://images.example.se/hero.jpg");
    expect(out.images.some((u) => u.includes("other.com"))).toBe(false);
    expect(out.images.some((u) => u.includes("lazy.jpg"))).toBe(true);
  });
});

/** Discovery -> fetch -> extraction -> semantics -> evidence -> matching. */
describe("end-to-end verification", () => {
  const constraints: HardConstraint[] = [
    { attribute: "location", op: "includes", value: "Nacka", kind: "geo", label: "Nacka" },
    { attribute: "view_type", op: "includes", value: "havsutsikt", label: "Havs- eller sjöutsikt" },
    { attribute: "balcony", op: "includes", value: "balkong", label: "Balkong" },
    { attribute: "price", op: "lt", value: 5_000_000, currency: "SEK", label: "Pris under 5 000 000 SEK" },
  ];

  const subject = {
    title: "Finnboda Kajväg 13B",
    attributes: {
      price: {
        key: "price",
        raw: "4 200 000 kr",
        value: 4_200_000,
        unit: null,
        currency: "SEK",
        confidence: "structured" as const,
        source_url: PAGE,
      },
    },
    numericValue: 4_200_000,
    currency: "SEK",
  };

  const description =
    "Adress: Finnboda Kajväg 13B, Nacka. Här erbjuds en fantastisk utsikt över Stockholms inlopp från bostadens stora inglasade balkong.";

  const semanticsFor = (text: string) =>
    storableSemantics([
      evaluateSemanticCriterion("Nacka", surfaces(text)),
      evaluateSemanticCriterion("havsutsikt", surfaces(text)),
      evaluateSemanticCriterion("balkong", surfaces(text)),
    ]);

  it("turns a read description into a full verified match", () => {
    const base = evaluateCriteria(subject, constraints);
    expect(base.status).toBe("unverified");

    const deep = deepVerify(base, semanticsFor(description), { status: "ok" });
    expect(deep.status).toBe("match");
    const view = deep.requirements.find((r) => r.attribute === "view_type")!;
    expect(view.status).toBe("match");
    expect(view.evidence?.snippet).toContain("Stockholms inlopp");
    expect(view.evidence?.source_label).toBe("listing description");
    expect(deep.requirements.find((r) => r.attribute === "price")?.status).toBe("match");
  });

  it("keeps a requirement open when the wording is only adjacent", () => {
    const deep = deepVerify(
      evaluateCriteria(subject, constraints),
      semanticsFor("Adress: Finnbodavägen 2, Nacka. Vattennära läge med fin terrass."),
      { status: "ok" },
    );
    expect(deep.status).toBe("unverified");
    expect(deep.requirements.find((r) => r.attribute === "view_type")?.status).toBe("unverified");
  });

  it("rejects when the description contradicts a requirement", () => {
    const deep = deepVerify(
      evaluateCriteria(subject, constraints),
      semanticsFor("Adress: Finnboda Kajväg 13B, Nacka. Utsikt över innergården. Stor balkong."),
      { status: "ok" },
    );
    expect(deep.status).toBe("reject");
  });

  it("never states a real match cannot be verified without price evidence", () => {
    const noPrice = { ...subject, attributes: {}, numericValue: null, currency: null };
    const deep = deepVerify(evaluateCriteria(noPrice, constraints), semanticsFor(description), { status: "ok" });
    expect(deep.status).toBe("unverified");
    expect(deep.requirements.find((r) => r.attribute === "view_type")?.status).toBe("match");
  });

  it("separates a technical fetch failure from a missing feature", () => {
    const unreachable = storableSemantics([
      unfetchableVerdict("havsutsikt", PAGE, "HTTP 404"),
      unfetchableVerdict("balkong", PAGE, "HTTP 404"),
      unfetchableVerdict("Nacka", PAGE, "HTTP 404"),
    ]);
    const deep = deepVerify(evaluateCriteria(subject, constraints), unreachable, {
      status: "failed",
      reason: "HTTP 404",
    });
    expect(deep.status).toBe("unverified");
    expect(deep.blockedByFetch).toBe(true);
    const view = deep.requirements.find((r) => r.attribute === "view_type")!;
    expect(view.verdict).toBe("unfetchable");
    expect(view.reason).toContain("could not be opened");
    expect(view.reason).not.toContain("unknown —");
  });

  it("never lets evidence overturn a proven arithmetic rejection", () => {
    const expensive = { ...subject, numericValue: 9_000_000, attributes: { ...subject.attributes, price: { ...subject.attributes.price, value: 9_000_000, raw: "9 000 000 kr" } } };
    const deep = deepVerify(evaluateCriteria(expensive, constraints), semanticsFor(description), { status: "ok" });
    expect(deep.status).toBe("reject");
  });
});
