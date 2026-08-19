import { describe, expect, it } from "vitest";
import { classifyCandidateUrl, gateCandidates, marketAllowed } from "@/lib/monitoring/candidate-gate";
import { requiredMarkets } from "@/lib/monitoring/geo";
import type { CandidateItem } from "@/lib/monitoring/candidates.server";

const candidate = (url: string): CandidateItem => ({
  title: url,
  url,
  discovery_url: "https://example.com",
  individual: true,
  likelihood: 0.9,
  relevance: 0.8,
  clue: null,
});

describe("candidate URL classification", () => {
  it("treats a marketplace search/category page as a search page", () => {
    expect(classifyCandidateUrl("https://www.blocket.se/mobility/discover/cars/bmw/3-serie/m340i")).toBe(
      "search_page",
    );
    expect(classifyCandidateUrl("https://www.chrono24.se/rolex/submariner--mod5.htm?q=126610ln")).toBe(
      "search_page",
    );
  });

  it("treats a host root as an aggregator, never a listing", () => {
    expect(classifyCandidateUrl("https://www.chrono24.se/")).toBe("aggregator");
  });

  it("accepts a concrete item URL", () => {
    expect(classifyCandidateUrl("https://www.blocket.se/annons/stockholm/bmw-m340i-xdrive/1234567890")).toBe(
      "listing",
    );
    expect(
      classifyCandidateUrl("https://www.bytbil.com/bil/bmw/m340i-xdrive-sedan-2022-abc12345"),
    ).toBe("listing");
  });

  it("rejects a page we ourselves read as an index this sweep", () => {
    expect(
      classifyCandidateUrl("https://www.autoscout24.se/lst/bmw/340", [
        "https://autoscout24.se/lst/bmw/340",
      ]),
    ).toBe("search_page");
  });
});

describe("market gate", () => {
  const sweden = requiredMarkets(["Sverige"]);

  it("rejects a source whose country-code TLD proves another market", () => {
    expect(marketAllowed("https://www.kleinanzeigen.de/s-anzeige/bmw/3377276509", sweden)).toBe(false);
  });

  it("allows Swedish and market-neutral sources", () => {
    expect(marketAllowed("https://www.blocket.se/annons/x/1234567890", sweden)).toBe(true);
    expect(marketAllowed("https://www.example.com/listing/1234567890", sweden)).toBe(true);
  });

  it("allows everything when the radar names no market", () => {
    expect(marketAllowed("https://www.mobile.de/x/1234567890", [])).toBe(true);
  });
});

describe("gateCandidates", () => {
  it("keeps listings and reports what it dropped", () => {
    const result = gateCandidates({
      candidates: [
        candidate("https://www.blocket.se/annons/stockholm/bmw-m340i/1234567890"),
        candidate("https://www.blocket.se/mobility/discover/cars/bmw/3-serie/m340i"),
        candidate("https://www.kleinanzeigen.de/s-anzeige/bmw-m340i/3377276509"),
      ],
      markets: requiredMarkets(["Sverige"]),
    });
    expect(result.kept).toHaveLength(1);
    expect(result.searchPages).toBe(1);
    expect(result.offMarket).toBe(1);
    expect(result.rejected).toHaveLength(2);
  });
});
