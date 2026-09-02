/**
 * Source identity and syndication detection — V3.
 *
 * Corroboration is only real when the sources are INDEPENDENT. Ten portals
 * republishing the same Reuters wire are one source, not ten, and an
 * aggregator carrying a Reuters story deserves Reuters-level attribution
 * rather than a blanket downgrade.
 *
 * Everything is heuristic and open-ended: unknown-but-credible publishers stay
 * usable, they simply do not receive the top tier.
 */

export type SourceQuality = "primary" | "high" | "standard" | "low";

export interface SourceIdentity {
  /** The domain the article was fetched from. */
  source_domain: string;
  /** Publisher the content actually originates from, when establishable. */
  original_publisher: string | null;
  /** Stable identity used for independence counting. */
  source_identity: string;
  source_quality: SourceQuality;
  /** True when the content is a republished wire/aggregated copy. */
  syndicated: boolean;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Publishers whose output is authoritative by construction: governments,
 * central banks, regulators, exchanges, statistical offices, official data.
 */
const PRIMARY = [
  /(^|\.)gov(\.|$)/i,
  /(^|\.)europa\.eu$/i,
  /riksbank\.se$/i,
  /federalreserve\.gov$/i,
  /ecb\.europa\.eu$/i,
  /bankofengland\.co\.uk$/i,
  /boj\.or\.jp$/i,
  /imf\.org$/i,
  /worldbank\.org$/i,
  /bis\.org$/i,
  /opec\.org$/i,
  /iea\.org$/i,
  /eia\.gov$/i,
  /sec\.gov$/i,
  /scb\.se$/i,
  /oecd\.org$/i,
  /un\.org$/i,
  /nasdaq\.com$/i,
  /nyse\.com$/i,
  /coingecko\.com$/i,
  /investor\.[a-z0-9-]+\.com$/i,
];

/** Established financial/general newsrooms with their own reporting. */
const HIGH = [
  /reuters\.com$/i,
  /bloomberg\.com$/i,
  /ft\.com$/i,
  /wsj\.com$/i,
  /apnews\.com$/i,
  /cnbc\.com$/i,
  /bbc\.(co\.uk|com)$/i,
  /economist\.com$/i,
  /barrons\.com$/i,
  /nikkei\.com$/i,
  /marketwatch\.com$/i,
  /afp\.com$/i,
  /axios\.com$/i,
  /politico\.(com|eu)$/i,
  /guardian\.co\.uk$/i,
  /theguardian\.com$/i,
  /nytimes\.com$/i,
  /washingtonpost\.com$/i,
  /di\.se$/i,
  /dn\.se$/i,
  /svd\.se$/i,
  /svt\.se$/i,
];

/** Low-signal surfaces: social, self-publishing, engagement-farm crypto blogs. */
const LOW = [
  /reddit\.com$/i,
  /(^|\.)x\.com$/i,
  /twitter\.com$/i,
  /facebook\.com$/i,
  /youtube\.com$/i,
  /tiktok\.com$/i,
  /medium\.com$/i,
  /substack\.com$/i,
  /blogspot\./i,
  /wordpress\./i,
  /zerohedge\.com$/i,
  /(coinspeaker|cryptopotato|newsbtc|ambcrypto|beincrypto|cryptoslate|u\.today|bitcoinist)\./i,
];

/** Aggregators: quality must be inherited from the underlying publisher. */
const AGGREGATORS = [
  /news\.google\./i,
  /finance\.yahoo\.com$/i,
  /yahoo\.com$/i,
  /msn\.com$/i,
  /flipboard\.com$/i,
  /investing\.com$/i,
  /tradingview\.com$/i,
  /marketscreener\.com$/i,
  /stocktitan\.net$/i,
  /nasdaq\.com\/articles/i,
  /finanzen\.net$/i,
  /morningstar\.com$/i,
  /businesstimes|streetinsider|benzinga/i,
];

/** Wire services whose copy travels verbatim across many domains. */
const WIRES: [RegExp, string][] = [
  [/\breuters\b/i, "reuters.com"],
  [/\bbloomberg\b/i, "bloomberg.com"],
  [/\b(associated press|ap news|\(ap\))\b/i, "apnews.com"],
  [/\bagence france[- ]presse|\bafp\b/i, "afp.com"],
  [/\bdow jones newswires\b/i, "wsj.com"],
  [/\bpr ?newswire\b/i, "prnewswire.com"],
  [/\bbusiness ?wire\b/i, "businesswire.com"],
  [/\bglobe ?newswire\b/i, "globenewswire.com"],
  [/\btt\b(?![a-z])/i, "tt.se"],
];

function matches(host: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(host));
}

function qualityForHost(host: string): SourceQuality {
  if (matches(host, PRIMARY)) return "primary";
  if (matches(host, HIGH)) return "high";
  if (matches(host, LOW)) return "low";
  return "standard";
}

/**
 * Establish who actually produced a report. Attribution is looked for in the
 * byline/title/snippet ("— Reuters", "(Reuters)") and in aggregator URL paths
 * that name the origin publisher.
 */
export function identifySource(input: {
  url: string;
  title?: string | null;
  snippet?: string | null;
  publisher?: string | null;
}): SourceIdentity {
  const domain = hostOf(input.url);
  const isAggregator = matches(domain, AGGREGATORS);
  const attributionText = [input.title ?? "", input.publisher ?? "", (input.snippet ?? "").slice(0, 400)].join(" ");

  let originalPublisher: string | null = null;
  for (const [pattern, publisherHost] of WIRES) {
    if (pattern.test(attributionText)) {
      originalPublisher = publisherHost;
      break;
    }
  }
  if (!originalPublisher && isAggregator) {
    // Aggregator paths frequently embed the origin: /news/reuters/...
    const path = (() => {
      try {
        return new URL(input.url).pathname.toLowerCase();
      } catch {
        return "";
      }
    })();
    for (const [pattern, publisherHost] of WIRES) {
      if (pattern.test(path)) {
        originalPublisher = publisherHost;
        break;
      }
    }
  }

  const sameOrigin = originalPublisher !== null && domain.endsWith(originalPublisher);
  const syndicated = originalPublisher !== null && !sameOrigin;

  const domainQuality = qualityForHost(domain);
  const originQuality = originalPublisher ? qualityForHost(originalPublisher) : null;
  // An aggregator inherits its origin's standing; a newsroom never loses its own.
  const quality: SourceQuality =
    originQuality && RANK[originQuality] > RANK[domainQuality] ? originQuality : domainQuality;

  return {
    source_domain: domain,
    original_publisher: originalPublisher,
    source_identity: originalPublisher ?? domain,
    source_quality: isAggregator && !originalPublisher ? "standard" : quality,
    syndicated,
  };
}

const RANK: Record<SourceQuality, number> = { low: 0, standard: 1, high: 2, primary: 3 };

export function bestQuality(identities: SourceIdentity[]): SourceQuality {
  let best: SourceQuality = "low";
  for (const id of identities) if (RANK[id.source_quality] > RANK[best]) best = id.source_quality;
  return identities.length === 0 ? "low" : best;
}

/**
 * Independent voices behind a story: distinct source identities, so wire
 * copies collapse onto the wire itself.
 */
export function countIndependent(identities: SourceIdentity[]): number {
  return new Set(identities.map((i) => i.source_identity)).size;
}

export function identifyAll(
  sources: { url: string; title?: string | null; snippet?: string | null; publisher?: string | null }[],
): SourceIdentity[] {
  return sources.map((s) =>
    identifySource({
      url: s.url,
      title: s.title ?? null,
      snippet: s.snippet ?? null,
      publisher: s.publisher ?? null,
    }),
  );
}
