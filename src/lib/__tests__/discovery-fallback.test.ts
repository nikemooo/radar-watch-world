import { describe, expect, it, vi } from "vitest";
import {
  classifyProviderFailure,
  ProviderCooldowns,
  searchWithFailover,
  type FailoverProvider,
} from "@/lib/search/provider-failover";
import { parseDuckDuckGoHtml } from "@/lib/search/providers.server";
import { gateCandidates } from "@/lib/monitoring/candidate-gate";
import { requiredMarkets } from "@/lib/monitoring/geo";
import { dedupeListings } from "@/lib/monitoring/dedupe";
import type { CandidateItem } from "@/lib/monitoring/candidates.server";

interface Doc {
  url: string;
  title: string;
}

class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const working = (id: string, docs: Doc[]): FailoverProvider<Doc> => ({
  id,
  costPerRequest: 0.01,
  isConfigured: () => true,
  search: vi.fn(async () => docs),
});

const broken = (id: string, err: Error): FailoverProvider<Doc> => ({
  id,
  costPerRequest: 0.01,
  isConfigured: () => true,
  search: vi.fn(async () => {
    throw err;
  }),
});

const run = (providers: FailoverProvider<Doc>[], cooldowns = new ProviderCooldowns()) =>
  searchWithFailover<Doc>({ providers, query: "lägenhet finnboda balkong", limit: 5, cooldowns, log: () => {} });

describe("provider error classification", () => {
  it("classifies Exa 402 / NO_MORE_CREDITS as quota exceeded", () => {
    const failure = classifyProviderFailure({
      status: 402,
      message: "Exa search failed (402) You have exceeded your credits limit. tag: NO_MORE_CREDITS",
    });
    expect(failure.class).toBe("quota_exceeded");
    expect(failure.failover).toBe(true);
    expect(failure.cooldownMs).toBeGreaterThan(0);
  });

  it("classifies NO_MORE_CREDITS without a status code", () => {
    expect(classifyProviderFailure({ message: "tag: NO_MORE_CREDITS" }).class).toBe("quota_exceeded");
  });

  it("classifies rate limits, 5xx, network and timeouts", () => {
    expect(classifyProviderFailure({ status: 429, message: "too many requests" }).class).toBe("rate_limited");
    expect(classifyProviderFailure({ status: 503, message: "bad gateway" }).class).toBe("temporary_error");
    expect(classifyProviderFailure({ status: 0, message: "fetch failed" }).class).toBe("network_error");
    expect(classifyProviderFailure({ status: 0, message: "The operation timed out" }).class).toBe("network_error");
  });
});

describe("discovery failover", () => {
  it("uses the primary provider and never pays for the fallback when it works", async () => {
    const primary = working("exa", [{ url: "https://www.hemnet.se/bostad/lagenhet-1234567", title: "A" }]);
    const fallback = working("fallback", [{ url: "https://x.test/1234567", title: "B" }]);
    const outcome = await run([primary, fallback]);
    expect(outcome.provider).toBe("exa");
    expect(outcome.fallbackUsed).toBe(false);
    expect(fallback.search).not.toHaveBeenCalled();
    expect(outcome.cost).toBeCloseTo(0.01);
  });

  it.each([
    [402, "You have exceeded your credits limit. tag: NO_MORE_CREDITS"],
    [429, "rate limit"],
    [503, "upstream failure"],
    [0, "The operation timed out"],
  ])("falls back when the primary fails with %s", async (status, message) => {
    const primary = broken("exa", new ProviderError(status, message));
    const fallback = working("fallback", [{ url: "https://www.hemnet.se/bostad/lagenhet-9999999", title: "B" }]);
    const outcome = await run([primary, fallback]);
    expect(outcome.provider).toBe("fallback");
    expect(outcome.fallbackUsed).toBe(true);
    expect(outcome.discoveryFailed).toBe(false);
    expect(outcome.documents).toHaveLength(1);
    expect(outcome.attempts[0]).toMatchObject({ provider: "exa", status: "failed" });
  });

  it("reports discoveryFailed when every provider fails", async () => {
    const outcome = await run([
      broken("exa", new ProviderError(402, "NO_MORE_CREDITS")),
      broken("fallback", new ProviderError(500, "down")),
    ]);
    expect(outcome.provider).toBeNull();
    expect(outcome.documents).toHaveLength(0);
    expect(outcome.discoveryFailed).toBe(true);
  });

  it("puts a quota-exhausted provider in cooldown so the next sweep skips it", async () => {
    const cooldowns = new ProviderCooldowns();
    const primary = broken("exa", new ProviderError(402, "NO_MORE_CREDITS"));
    const fallback = working("fallback", [{ url: "https://a.test/1234567", title: "B" }]);
    await run([primary, fallback], cooldowns);
    expect(cooldowns.isAvailable("exa")).toBe(false);

    const second = await run([primary, fallback], cooldowns);
    expect(second.provider).toBe("fallback");
    expect(second.attempts[0]).toMatchObject({ provider: "exa", status: "skipped_cooldown" });
    expect((primary.search as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe("fallback results obey the same gates as primary results", () => {
  const candidate = (url: string, title = url): CandidateItem => ({
    title,
    url,
    discovery_url: "https://fallback.test",
    individual: true,
    likelihood: 0.9,
    relevance: 0.8,
    clue: null,
  });

  it("drops search pages, shopfronts and wrong-country hosts from fallback discovery", () => {
    const result = gateCandidates({
      candidates: [
        candidate("https://www.hemnet.se/bostad/lagenhet-3rum-finnboda-nacka-kommun-12345678"),
        candidate("https://www.hemnet.se/bostader?location_ids[]=898472"),
        candidate("https://blombergsur.se/"),
        candidate("https://www.uret.se/rolex/submariner"),
        candidate("https://www.immobilienscout24.de/expose/12345678"),
      ],
      markets: requiredMarkets(["Sverige"]),
    });
    expect(result.kept.map((c) => c.url)).toEqual([
      "https://www.hemnet.se/bostad/lagenhet-3rum-finnboda-nacka-kommun-12345678",
    ]);
    expect(result.offMarket).toBe(1);
    expect(result.searchPages).toBe(3);
  });

  it("deduplicates the same listing found by both the primary and the fallback", () => {
    const rows = [
      {
        url: "https://www.hemnet.se/bostad/lagenhet-3rum-finnboda-12345678",
        title: "Lägenhet Finnboda",
        numeric_value: 5950000,
        currency: "SEK",
      },
      {
        url: "https://www.hemnet.se/bostad/lagenhet-3rum-finnboda-12345678?utm_source=ddg",
        title: "Lägenhet Finnboda",
        numeric_value: 5950000,
        currency: "SEK",
      },
    ];
    const result = dedupeListings(rows);
    expect(result.kept).toHaveLength(1);
    expect(result.removed).toHaveLength(1);
  });
});

describe("keyless fallback parsing", () => {
  it("returns only real result URLs and never invents any", () => {
    const html = `
      <div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fwww.hemnet.se%2Fbostad%2Flagenhet-12345678">Lägenhet i Finnboda</a></div>
      <div class="result"><a class="result__a" href="https://www.booli.se/annons/9876543">Balkong och havsutsikt</a></div>
      <div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
    `;
    const docs = parseDuckDuckGoHtml(html, "lägenhet finnboda", 10, "2026-08-29T00:00:00.000Z");
    expect(docs.map((d) => d.url)).toEqual([
      "https://www.hemnet.se/bostad/lagenhet-12345678",
      "https://www.booli.se/annons/9876543",
    ]);
    expect(docs[0]!.title).toBe("Lägenhet i Finnboda");
  });

  it("returns nothing rather than fabricating results for empty HTML", () => {
    expect(parseDuckDuckGoHtml("<html></html>", "q", 5)).toEqual([]);
  });
});
