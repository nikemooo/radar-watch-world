import { describe, expect, it } from "vitest";
import { comparableIdentity, parseIdentity, resolveIdentity, type IdentitySource } from "../monitoring/identity";
import { dedupeListings, listingId, normalizedUrl } from "../monitoring/dedupe";
import { evaluateConstraint } from "../monitoring/criteria";
import { inferMarket } from "../monitoring/geo";

const src = (sourceType: string, text: string, url = "https://shop.se/p/1"): IdentitySource => ({
  sourceType,
  url,
  text,
});

describe("canonical identity parsing", () => {
  it("reads a generation written as a bare trailing number", () => {
    const id = parseIdentity("Apple AirPods Pro 2");
    expect(id.brand).toBe("apple");
    expect(id.words).toEqual(["airpods", "pro"]);
    expect(id.generation).toBe(2);
  });

  it("reads a generation written in words", () => {
    expect(parseIdentity("AirPods Pro (2nd Generation)").generation).toBe(2);
    expect(parseIdentity("Sonos Beam Gen 2").generation).toBe(2);
    expect(parseIdentity("Leica M mark III").generation).toBe(3);
  });

  it("keeps model codes and years apart", () => {
    const bmw = parseIdentity("BMW M340i 2021");
    expect(bmw.codes).toEqual(["m340i"]);
    expect(bmw.year).toBe(2021);
    const rolex = parseIdentity("Rolex Submariner Date 126610LN");
    expect(rolex.codes).toEqual(["126610ln"]);
    expect(rolex.words).toEqual(["submariner", "date"]);
  });
});

describe("identity resolution over evidence", () => {
  const target = parseIdentity("Apple AirPods Pro 2");

  it("verifies a differently worded but identical product", () => {
    const r = resolveIdentity(target, [
      src("jsonld", "Apple AirPods Pro (2nd Generation) med MagSafe-laddningsetui USB-C"),
      src("detail_title", "AirPods Pro 2 – Apple"),
    ]);
    expect(r.status).toBe("verified");
    expect(r.conflicts).toHaveLength(0);
  });

  it("rejects another generation of the same family", () => {
    const r = resolveIdentity(target, [src("detail_title", "Apple AirPods Pro 3 (3rd generation)")]);
    expect(r.status).toBe("conflicted");
  });

  it("does not confuse a sibling product for the target", () => {
    expect(resolveIdentity(target, [src("detail_title", "Apple AirPods 4")]).status).toBe("unknown");
    expect(resolveIdentity(target, [src("detail_title", "Apple AirPods (2nd generation)")]).status).toBe("unknown");
  });

  it("says probable when the family is stated but the generation is not", () => {
    const r = resolveIdentity(target, [src("detail_title", "Apple AirPods Pro med USB-C")]);
    expect(r.status).toBe("probable");
    expect(r.missing).toContain("generation 2");
  });

  it("combines signals across separate surfaces", () => {
    const r = resolveIdentity(parseIdentity("Rolex Submariner Date 126610LN"), [
      src("detail_title", "Rolex Submariner Date stål 41 mm"),
      src("detail_field", "referensnummer: 126610-LN"),
    ]);
    expect(r.status).toBe("verified");
  });

  it("verifies a car model code written with the trim after it", () => {
    const r = resolveIdentity(parseIdentity("BMW M340i"), [
      src("og", "BMW M340i xDrive Touring 2021 – Bilweb"),
      src("detail_field", "modell: M340i xDrive"),
    ]);
    expect(r.status).toBe("verified");
  });

  it("rejects a different model code from the same numbering scheme", () => {
    expect(resolveIdentity(parseIdentity("BMW M340i"), [src("detail_title", "BMW 330i xDrive")]).status).toBe(
      "conflicted",
    );
    expect(
      resolveIdentity(parseIdentity("Rolex Submariner Date 126610LN"), [
        src("detail_title", "Rolex Submariner No Date 124060"),
      ]).status,
    ).toBe("conflicted");
  });

  it("does not mistake a price for a model code", () => {
    const r = resolveIdentity(parseIdentity("Rolex Submariner Date 126610LN"), [
      src("detail_title", "Rolex Submariner Date 126610LN"),
      src("detail_text", "Pris: 129000 kr inklusive box och papper"),
    ]);
    expect(r.status).toBe("verified");
    expect(r.conflicts).toHaveLength(0);
  });

  it("verifies from one naming source that states the identity in full", () => {
    expect(resolveIdentity(target, [src("detail_title", "Apple AirPods Pro (2nd generation) 2022")]).status).toBe(
      "verified",
    );
    expect(resolveIdentity(target, [src("index_card", "Apple AirPods Pro 2:a generationen")]).status).toBe("verified");
    expect(resolveIdentity(parseIdentity("BMW M340i"), [src("detail_title", "BMW M340i xDrive Touring")]).status).toBe(
      "verified",
    );
  });

  it("does not verify from loose prose alone", () => {
    expect(
      resolveIdentity(target, [src("detail_text", "Vi säljer AirPods Pro 2 och mycket annat i vår butik")]).status,
    ).toBe("probable");
  });

  it("stays unknown when only a generic brand word is stated", () => {
    expect(resolveIdentity(parseIdentity("BMW M340i"), [src("detail_title", "BMW M3 Competition")]).status).toBe(
      "unknown",
    );
  });

  it("never verifies without a retrieved source", () => {
    expect(resolveIdentity(target, []).status).toBe("unknown");
  });
});

describe("identity inside the deterministic criteria gate", () => {
  const constraint = { attribute: "model", op: "includes" as const, value: "Apple AirPods Pro 2" };
  const base = { title: "AirPods", attributes: {}, numericValue: 2290, currency: "SEK" };

  it("matches a listing whose field wording differs from the request", () => {
    const outcome = evaluateConstraint(
      {
        ...base,
        attributes: {
          model: {
            key: "model",
            raw: "AirPods Pro (2nd Generation)",
            value: null,
            currency: null,
            unit: null,
            confidence: "structured",
            source_url: "https://shop.se/p/1",
          },
        },
        identitySources: [src("jsonld", "Apple AirPods Pro (2nd Generation) USB-C"), src("detail_title", "AirPods Pro 2")],
      },
      constraint,
    );
    expect(outcome.status).toBe("match");
  });

  it("rejects the wrong generation even when nothing else contradicts it", () => {
    const outcome = evaluateConstraint(
      { ...base, identitySources: [src("detail_title", "Apple AirPods Pro 3"), src("og", "AirPods Pro 3")] },
      constraint,
    );
    expect(outcome.status).toBe("reject");
  });

  it("stays unverified — not unknown — when the family is stated", () => {
    const outcome = evaluateConstraint(
      { ...base, identitySources: [src("detail_title", "Apple AirPods Pro")] },
      constraint,
    );
    expect(outcome.status).toBe("unverified");
    expect(outcome.identity?.status).toBe("probable");
  });
});

describe("listing deduplication", () => {
  it("normalizes away tracking, www, AMP and trailing slashes", () => {
    expect(normalizedUrl("https://www.blocket.se/annons/123456/?utm_source=x")).toBe("blocket.se/annons/123456");
    expect(normalizedUrl("http://blocket.se/annons/123456/amp")).toBe("blocket.se/annons/123456");
  });

  it("finds the advert id in the path", () => {
    expect(listingId("https://www.blocket.se/annons/skane/airpods/1234567")).toBe("blocket.se#1234567");
    expect(listingId("https://shop.se/products/airpods-pro")).toBeNull();
  });

  it("collapses the same advert reached through different URLs", () => {
    const { kept, removed } = dedupeListings([
      { url: "https://www.blocket.se/annons/airpods-pro-2/1234567", title: "AirPods Pro 2", numeric_value: 2290, currency: "SEK" },
      { url: "https://blocket.se/annons/1234567?utm_source=g", title: "AirPods Pro 2", numeric_value: 2290, currency: "SEK" },
      { url: "https://tradera.se/item/999", title: "AirPods Pro 2", numeric_value: 2290, currency: "SEK" },
    ]);
    expect(kept).toHaveLength(2);
    expect(removed[0]!.rule).toBe("same-listing-id");
  });

  it("keeps two different sellers of the same product", () => {
    const { kept } = dedupeListings([
      { url: "https://a.se/p/1", title: "AirPods Pro 2", numeric_value: 2290, currency: "SEK" },
      { url: "https://b.se/p/1", title: "AirPods Pro 2", numeric_value: 2290, currency: "SEK" },
    ]);
    expect(kept).toHaveLength(2);
  });
});

describe("comparable identity", () => {
  it("refuses to compare across generations", () => {
    expect(comparableIdentity(parseIdentity("AirPods Pro 2"), parseIdentity("AirPods Pro 3"))).toBe(false);
    expect(comparableIdentity(parseIdentity("AirPods Pro 2"), parseIdentity("AirPods Pro (2nd generation)"))).toBe(true);
  });
});

describe("attribute independence and geography", () => {
  const geo = { attribute: "country", op: "includes" as const, value: "Sweden", aliases: ["SE", "sverige"], kind: "geo" as const };
  const subject = {
    title: "Apple AirPods Pro (2nd generation) 2022",
    attributes: {},
    numericValue: 1669,
    currency: "SEK",
    identitySources: [src("detail_title", "Apple AirPods Pro (2nd generation) 2022")],
  };

  it("verifies the model even when the country cannot be verified", () => {
    const model = evaluateConstraint(subject, {
      attribute: "model",
      op: "includes",
      value: "AirPods Pro 2",
    });
    const country = evaluateConstraint(subject, geo);
    expect(model.status).toBe("match");
    expect(country.status).toBe("unverified");
    expect(country.reason).toContain("country could not be verified");
  });

  it("never resolves a country through product identity", () => {
    const country = evaluateConstraint(subject, geo);
    expect(country.identity).toBeUndefined();
  });

  it("verifies a price independently of the model", () => {
    const price = evaluateConstraint(subject, {
      attribute: "price",
      op: "lte",
      value: 2500,
      currency: "SEK",
    });
    expect(price.status).toBe("match");
  });
});

describe("geographic evidence", () => {
  it("reads a market from a ccTLD and from a locale segment", () => {
    expect(inferMarket({ url: "https://www.blocket.se/annons/1" }).market?.code).toBe("SE");
    const localised = inferMarket({ url: "https://swappie.com/se/modell/airpods-pro-2/" });
    expect(localised.market?.code).toBe("SE");
    expect(localised.confidence).toBe("stated");
    expect(inferMarket({ url: "https://shop.com/sv-se/p/1" }).market?.code).toBe("SE");
  });

  it("never guesses a country from currency alone", () => {
    expect(inferMarket({ url: "https://shop.com/p/1", currency: "SEK" }).market).toBeNull();
  });
});
