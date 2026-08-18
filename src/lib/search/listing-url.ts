/**
 * Direct listing URL resolution.
 *
 * A finding is only useful if "Öppna annons" opens the actual advert. Search
 * providers, redirects and canonical tags all disagree about which URL that
 * is, so this module picks the best candidate deterministically and — just as
 * importantly — reports when NO candidate can be proven to address one item.
 * The UI must then say the direct link could not be verified instead of
 * sending the user to a marketplace start page.
 *
 * Fully generic: it only reasons about URL shape and host identity.
 */
import { looksLikeItemUrl } from "./url-shape";

export type LinkStatus = "direct" | "unverified";

export interface ResolvedListingUrl {
  /** Best URL we have for the listing. */
  url: string;
  /** "direct" only when the URL provably addresses one item. */
  status: LinkStatus;
  /** Where the chosen URL came from. */
  source: "canonical" | "final" | "requested";
  canonical: string | null;
  final_url: string | null;
}

function sameHost(a: string, b: string): boolean {
  try {
    const norm = (u: string) => new URL(u).host.replace(/^www\./, "").toLowerCase();
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/** Strip tracking noise so the same advert is not stored under two URLs. */
export function cleanListingUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|mc_|ref|referrer|campaign)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

export function resolveListingUrl(input: {
  requestedUrl: string;
  finalUrl?: string | null | undefined;
  canonical?: string | null | undefined;
}): ResolvedListingUrl {
  const requested = cleanListingUrl(input.requestedUrl);
  const finalUrl = input.finalUrl ? cleanListingUrl(input.finalUrl) : null;
  const canonical = input.canonical ? cleanListingUrl(input.canonical) : null;

  // A canonical tag is only trusted when it stays on the same host — a
  // cross-host canonical is usually a syndication or aggregator artefact.
  if (canonical && sameHost(canonical, requested) && looksLikeItemUrl(canonical)) {
    return { url: canonical, status: "direct", source: "canonical", canonical, final_url: finalUrl };
  }
  if (finalUrl && looksLikeItemUrl(finalUrl)) {
    return { url: finalUrl, status: "direct", source: "final", canonical, final_url: finalUrl };
  }
  if (looksLikeItemUrl(requested)) {
    return { url: requested, status: "direct", source: "requested", canonical, final_url: finalUrl };
  }
  return {
    url: finalUrl ?? requested,
    status: "unverified",
    source: finalUrl ? "final" : "requested",
    canonical,
    final_url: finalUrl,
  };
}
