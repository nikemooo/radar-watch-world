import { describe, expect, it } from "vitest";
import {
  extractPrice,
  extractPriceFromStructured,
  extractPricesFromText,
  parseMoneyNumber,
  selectPrimaryPrice,
} from "../monitoring/price";

const se = { url: "https://www.example.se/objekt/1" };

function one(text: string, url = se.url) {
  return extractPrice({ url, text }).primary;
}

describe("number parsing", () => {
  it("reads every common thousands and decimal convention", () => {
    expect(parseMoneyNumber("3 495 000")).toBe(3495000);
    expect(parseMoneyNumber("3.495.000")).toBe(3495000);
    expect(parseMoneyNumber("3,495,000")).toBe(3495000);
    expect(parseMoneyNumber("1234,50")).toBe(1234.5);
    expect(parseMoneyNumber("1,234.50")).toBe(1234.5);
  });

  it("applies money multipliers as decimals", () => {
    expect(parseMoneyNumber("3,495", 1e6)).toBe(3495000);
    expect(parseMoneyNumber("3,50", 1e6)).toBe(3500000);
    expect(parseMoneyNumber("3.5", 1e6)).toBe(3500000);
    expect(parseMoneyNumber("3 500", 1e3)).toBe(3500000);
  });
});

describe("swedish price formats", () => {
  const cases: [string, number][] = [
    ["3 495 000 kr", 3495000],
    ["3.495.000 kr", 3495000],
    ["3,495,000 SEK", 3495000],
    ["SEK 3 495 000", 3495000],
    ["3 495 000 SEK", 3495000],
    ["Pris: 3 495 000 kr", 3495000],
    ["Utgångspris 3 495 000 kr", 3495000],
    ["Begärt pris 3 495 000 kr", 3495000],
    ["Pris 3 495 000", 3495000],
    ["3,495 Mkr", 3495000],
    ["3,50 Mkr", 3500000],
    ["3.5 MSEK", 3500000],
    ["3 500 tkr", 3500000],
    ["Accepterat pris 3 500 000", 3500000],
    ["Bud från 3 495 000 kr", 3495000],
  ];
  for (const [text, amount] of cases) {
    it(`understands "${text}"`, () => {
      const price = one(text);
      expect(price?.amount).toBe(amount);
      expect(price?.currency).toBe("SEK");
      expect(price?.original_text).toContain("3");
    });
  }
});

describe("international currencies", () => {
  it("reads symbols and codes on either side", () => {
    expect(one("€12,500", "https://x.de/a")).toMatchObject({ amount: 12500, currency: "EUR" });
    expect(one("12 500 EUR", "https://x.de/a")).toMatchObject({ amount: 12500, currency: "EUR" });
    expect(one("$12,500", "https://x.com/a")).toMatchObject({ amount: 12500, currency: "USD" });
    expect(one("USD 12,500", "https://x.com/a")).toMatchObject({ amount: 12500, currency: "USD" });
    expect(one("£9,995", "https://x.co.uk/a")).toMatchObject({ amount: 9995, currency: "GBP" });
    expect(one("CHF 24 900", "https://x.ch/a")).toMatchObject({ amount: 24900, currency: "CHF" });
    expect(one("¥1,250,000", "https://x.jp/a")).toMatchObject({ amount: 1250000, currency: "JPY" });
  });

  it("reads kr as the local krona of the page's market", () => {
    expect(one("399 000 kr", "https://x.no/a")?.currency).toBe("NOK");
    expect(one("399 000 kr", "https://x.dk/a")?.currency).toBe("DKK");
  });
});

describe("non-price numbers are never prices", () => {
  const noise = [
    "Telefon: 08-123 45 67",
    "Postnummer: 131 31",
    "Artikelnummer: 9912345",
    "Referensnummer: 126610",
    "Modellnummer 549000",
    "Årsmodell 2023",
    "Boarea 78 kvm",
    "Antal rum 3 rum",
    "Effekt 374 hk",
    "Miltal 4 500 mil",
  ];
  for (const text of noise) {
    it(`rejects "${text}"`, () => {
      expect(one(text)).toBeNull();
    });
  }

  it("reads only the price out of a car listing full of numbers", () => {
    const price = one("BMW 340i 2023 374 hk EPY76G 4 500 mil 549 000 kr");
    expect(price?.amount).toBe(549000);
    expect(price?.currency).toBe("SEK");
  });

  it("reads only the price out of a watch listing", () => {
    const price = one("Rolex Ref 126610LN 41 mm 2024 12 500 EUR", "https://x.de/w");
    expect(price?.amount).toBe(12500);
    expect(price?.currency).toBe("EUR");
  });
});

describe("multiple prices on one page", () => {
  it("prefers the sale price over the original price", () => {
    const result = extractPrice({ url: se.url, text: "Ordinarie pris 4 995 kr Nu 3 995 kr" });
    expect(result.primary?.amount).toBe(3995);
    expect(result.primary?.price_type).toBe("sale_price");
    expect(result.all.some((p) => p.price_type === "original_price" && p.amount === 4995)).toBe(true);
  });

  it("keeps a monthly fee out of the asking price", () => {
    const result = extractPrice({
      url: se.url,
      text: "Utgångspris 3 495 000 kr Månadsavgift 4 250 kr",
    });
    expect(result.primary?.amount).toBe(3495000);
    expect(result.primary?.price_type).toBe("starting_price");
    expect(result.all.find((p) => p.amount === 4250)?.price_type).toBe("fee");
  });

  it("treats a rent as a rent, not a purchase price", () => {
    const result = extractPrice({ url: se.url, text: "Hyra 12 500 kr/mån" });
    expect(result.primary?.amount).toBe(12500);
    expect(result.primary?.price_type).toBe("rent");
  });

  it("reads an auction bid as an auction price", () => {
    expect(one("Högsta bud 45 000 kr")?.price_type).toBe("auction_price");
  });

  it("refuses to pick between two unlabelled rival values", () => {
    const { primary, reason } = selectPrimaryPrice([
      { amount: 100, currency: "SEK", original_text: "100 kr", price_type: "unknown", confidence: 0.9, evidence: "", source_location: "page_text" },
      { amount: 200, currency: "SEK", original_text: "200 kr", price_type: "unknown", confidence: 0.9, evidence: "", source_location: "page_text" },
    ]);
    expect(primary).toBeNull();
    expect(reason).toContain("compete");
  });
});

describe("structured data", () => {
  it("reads a schema.org Offer", () => {
    const price = extractPriceFromStructured({ price: "3495000", pricecurrency: "SEK" }, se);
    expect(price).toMatchObject({ amount: 3495000, currency: "SEK", confidence: 0.99 });
    expect(price?.source_location).toBe("structured_data");
  });

  it("reads OpenGraph and product meta tags", () => {
    expect(
      extractPriceFromStructured({ "product:price:amount": "12500.00", "product:price:currency": "eur" }, se),
    ).toMatchObject({ amount: 12500, currency: "EUR" });
  });

  it("prefers structured data over page text", () => {
    const result = extractPrice({
      url: se.url,
      structured: { price: "3495000", pricecurrency: "SEK" },
      text: "Månadsavgift 4 250 kr",
    });
    expect(result.primary?.amount).toBe(3495000);
    expect(result.primary?.source_location).toBe("structured_data");
  });

  it("reads a labelled spec field", () => {
    const result = extractPrice({ url: se.url, fields: { utgångspris: "3 495 000 kr", boarea: "78 kvm" } });
    expect(result.primary?.amount).toBe(3495000);
    expect(result.primary?.source_location).toBe("detail_field");
  });

  it("returns nothing rather than a guess when the page states no price", () => {
    const result = extractPrice({ url: se.url, text: "Trevlig lägenhet med balkong och havsutsikt." });
    expect(result.primary).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  it("falls back to the index card only when the page itself is silent", () => {
    const result = extractPrice({
      url: se.url,
      text: "Lägenhet i Finnboda, Nacka. 3 rum och kök.",
      cardText: "Finnboda strand 12 · 3 495 000 kr · 78 kvm",
    });
    expect(result.primary?.amount).toBe(3495000);
    expect(result.primary?.source_location).toBe("index_card");
    expect(result.primary?.confidence).toBeLessThan(0.9);
  });
});
