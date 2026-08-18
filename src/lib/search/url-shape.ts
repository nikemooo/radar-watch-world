/**
 * Generic URL shape analysis.
 *
 * Marketplaces, news sites, job boards and directories all express "one item"
 * as a repeating URL pattern (`/item/123456`, `/listing/abc-987`, `/jobs/xyz`).
 * This module derives a structural signature for a URL so sibling links on an
 * index page can be clustered WITHOUT any site-specific knowledge.
 */

/** Structural signature: variable segments collapse to placeholders. */
export function pathSignature(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const segments = u.pathname.split("/").filter(Boolean);
  const shaped = segments.map((s) => {
    if (/^\d+$/.test(s)) return "#";
    if (/\d{4,}/.test(s)) return "*";
    if (s.includes("-") && s.length >= 8) return "*";
    if (s.length >= 24) return "*";
    return s.toLowerCase();
  });
  return `${u.host.replace(/^www\./, "")}/${shaped.join("/")}`;
}

export interface UrlFamily {
  signature: string;
  urls: string[];
  /** Share of the family's URLs that carry a variable (item-like) segment. */
  variableSegments: number;
}

/**
 * Cluster links into structural families and keep the ones that look like a
 * repeating list of concrete items (many siblings, at least one variable part).
 */
export function detectItemFamilies(links: string[], pageUrl: string, minSize = 3): UrlFamily[] {
  const own = pathSignature(pageUrl);
  const groups = new Map<string, Set<string>>();
  for (const link of links) {
    const clean = link.split("#")[0]!.replace(/&amp;/g, "&");
    const sig = pathSignature(clean);
    if (!sig || sig === own) continue;
    // A pure query-string variation of the page itself is a filter, not an item.
    if (!groups.has(sig)) groups.set(sig, new Set());
    groups.get(sig)!.add(clean);
  }

  const families: UrlFamily[] = [];
  for (const [signature, set] of groups) {
    const variableSegments = signature.split("/").filter((s) => s === "#" || s === "*").length;
    if (variableSegments === 0) continue;
    if (set.size < minSize) continue;
    families.push({ signature, urls: [...set], variableSegments });
  }
  // Deepest / most item-like families first.
  return families.sort((a, b) => b.urls.length * b.variableSegments - a.urls.length * a.variableSegments);
}

/** True when a page links to a repeating family of concrete item URLs. */
export function looksLikeIndexPage(links: string[], pageUrl: string): boolean {
  return detectItemFamilies(links, pageUrl).length > 0;
}
