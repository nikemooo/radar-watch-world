/**
 * Generic listing-image understanding — pure, model-free, category-agnostic.
 *
 * Three separate problems, solved deterministically:
 *
 *  1. DISCOVERY  — real listing photos hide in many places: og:image, JSON-LD,
 *                  <link rel=preload as=image>, <picture><source srcset>,
 *                  lazy-loaded <img> attributes, and JSON galleries embedded by
 *                  client-rendered marketplaces. Every surface is read.
 *  2. FILTERING  — chrome (logos, icons, sprites, avatars, map tiles, tracking
 *                  pixels) is never a listing photo and is dropped by shape.
 *  3. INTEGRITY  — photos must belong to the listing they are shown on. A URL
 *                  is only accepted when it comes from the listing's own page,
 *                  and dedupe is done on a size-stripped key so the same photo
 *                  never appears twice at two renditions.
 *
 * Nothing here is site-specific: it reasons about URL shape and HTML structure.
 */

export type ImageOrigin =
  | "opengraph"
  | "jsonld"
  | "link_preload"
  | "picture_source"
  | "img"
  | "embedded_json"
  | "provider";

export interface ImageCandidate {
  url: string;
  origin: ImageOrigin;
  /** Largest declared width in a srcset, when the page published one. */
  width: number;
  /** Position in document order — galleries publish the hero first. */
  order: number;
}

export interface ListingImages {
  /** Ranked, deduplicated, integrity-checked listing photos. */
  images: string[];
  primary: string | null;
  /** Why the set looks the way it does — shown in diagnostics, never invented. */
  note: string;
  /** Candidates rejected by the noise/integrity filters. */
  rejected: number;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|avif)(\?|$)/i;

/**
 * Non-content imagery every site ships. Kept as URL-shape vocabulary, not
 * per-site rules: these tokens describe chrome on any website.
 */
const NOISE =
  /(sprite|logo|icon|favicon|avatar|profile[-_]?pic|placeholder|spacer|pixel|tracking|beacon|badge|banner|watermark|1x1|blank|loading|skeleton|default[-_]?image|no[-_]?image|missing|map[-_]?tile|staticmap|qr[-_]?code|share|social|flag|button|arrow)/i;

/** CDN image endpoints frequently carry no file extension at all. */
const HINT =
  /(\/image|\/images|\/img|\/media|\/photos?|\/pictures?|\/assets\/|format=|resize|fit=|quality=|w=\d{2,}|width=\d{2,}|h=\d{2,})/i;

/** Sizing/format parameters that produce the same photo at another rendition. */
const SIZE_PARAM = /^(w|h|width|height|size|s|q|quality|dpr|fit|format|fm|auto|crop|resize|rect|scale)$/i;

const PROTOCOL_RELATIVE = /^\/\//;

export function absoluteImageUrl(href: string, base: string): string | null {
  try {
    const raw = href.replace(/&amp;/g, "&").trim();
    if (!raw || /^data:/i.test(raw)) return null;
    const u = new URL(PROTOCOL_RELATIVE.test(raw) ? `https:${raw}` : raw, base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Identity key for one photo, independent of the rendition that was linked. */
export function imageKey(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (SIZE_PARAM.test(key)) u.searchParams.delete(key);
    }
    u.hash = "";
    // /1200x800/ and /w_1200/ style path segments are renditions, not identity.
    const path = u.pathname
      .replace(/\/\d{2,4}x\d{2,4}\//g, "/")
      .replace(/\/(?:w|h|s|c)_\d{2,4}(?:,[a-z]_[\w.]+)*\//g, "/")
      .replace(/[-_](?:\d{2,4}x\d{2,4}|thumb|small|medium|large|scaled)(?=\.[a-z]{3,4}$)/i, "");
    return `${u.host.replace(/^www\./, "")}${path}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Pick the largest entry of a srcset; a plain src is returned unchanged. */
export function largestFromSrcset(raw: string): { url: string; width: number } {
  const parts = raw
    .split(/\s*,\s*(?=(?:https?:|\/|data:|[\w./-]+\s+\d))/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [url, size] = p.split(/\s+/);
      const width = size ? Number(size.replace(/[^\d]/g, "")) : 0;
      return { url: url ?? "", width: Number.isFinite(width) ? width : 0 };
    })
    .filter((p) => p.url);
  if (parts.length === 0) return { url: raw.trim(), width: 0 };
  return parts.sort((a, b) => b.width - a.width)[0]!;
}

/** True when a resolved URL plausibly points at real item imagery. */
export function isContentImage(url: string): boolean {
  if (/^data:/i.test(url)) return false;
  if (/\.(svg|gif|ico)(\?|$)/i.test(url)) return false;
  if (NOISE.test(url)) return false;
  return IMAGE_EXT.test(url) || HINT.test(url) || /image|photo|media/i.test(url);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Registrable-ish suffix used to recognise a site's own image CDN. */
function baseName(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return parts[0] ?? host;
  return parts[parts.length - 3] ?? parts[0] ?? host;
}

/**
 * Integrity: a photo belongs to the listing when it is served by the listing's
 * own host, that host's image CDN, or a generic CDN referenced BY that page.
 * Because every candidate here was read from the item's own page, a foreign
 * host is only downgraded in rank — never silently attributed to another item.
 */
export function sameOperator(imageUrl: string, pageUrl: string): boolean {
  const a = hostOf(imageUrl);
  const b = hostOf(pageUrl);
  if (!a || !b) return false;
  if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  return baseName(a) === baseName(b) && baseName(a).length > 2;
}

/** Every image surface a served HTML document exposes, in document order. */
export function collectImageCandidates(html: string, pageUrl: string): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  let order = 0;
  const push = (raw: string | undefined | null, origin: ImageOrigin) => {
    if (!raw) return;
    const { url, width } = largestFromSrcset(raw);
    const abs = absoluteImageUrl(url, pageUrl);
    if (!abs) return;
    out.push({ url: abs, origin, width, order: order++ });
  };

  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!name) continue;
    if (!/^(og:image(:secure_url|:url)?|twitter:image(:src)?|image)$/.test(name)) continue;
    push(tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1], "opengraph");
  }

  for (const m of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    for (const u of (m[1] ?? "").matchAll(/"(?:image|contentUrl|thumbnailUrl)"\s*:\s*"([^"]{8,600})"/gi)) {
      push(u[1]!.replace(/\\\//g, "/"), "jsonld");
    }
    for (const arr of (m[1] ?? "").matchAll(/"(?:image|photos?)"\s*:\s*\[([^\]]{0,6000})\]/gi)) {
      for (const u of arr[1]!.matchAll(/"(https?:[^"]{8,600})"/gi)) push(u[1]!.replace(/\\\//g, "/"), "jsonld");
    }
  }

  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? "";
    if (!/image_src/.test(rel) && !(/preload/.test(rel) && /\bas\s*=\s*["']image["']/i.test(tag))) continue;
    push(
      tag.match(/\bimagesrcset\s*=\s*["']([^"']+)["']/i)?.[1] ?? tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1],
      "link_preload",
    );
  }

  // Client-rendered marketplaces ship their gallery as JSON inside the page.
  for (const m of html.matchAll(
    /"(?:image|imageUrl|imageUrls|images|photos|media|gallery|pictures)"\s*:\s*(\[[^\]]{0,8000}\]|"[^"]{8,600}")/gi,
  )) {
    const blob = m[1]!.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
    for (const u of blob.matchAll(/https?:\/\/[^"',\s\\]{8,600}/gi)) push(u[0]!, "embedded_json");
  }

  for (const m of html.matchAll(/<source\b[^>]*>/gi)) {
    const tag = m[0];
    if (/\btype\s*=\s*["']video/i.test(tag)) continue;
    push(
      tag.match(/\bsrcset\s*=\s*["']([^"']+)["']/i)?.[1] ?? tag.match(/\bdata-srcset\s*=\s*["']([^"']+)["']/i)?.[1],
      "picture_source",
    );
  }

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    push(
      tag.match(/\bsrcset\s*=\s*["']([^"']+)["']/i)?.[1] ??
        tag.match(/\bdata-srcset\s*=\s*["']([^"']+)["']/i)?.[1] ??
        tag.match(/\bdata-(?:lazy-)?src\s*=\s*["']([^"']+)["']/i)?.[1] ??
        tag.match(/\bdata-original\s*=\s*["']([^"']+)["']/i)?.[1] ??
        tag.match(/\bdata-image\s*=\s*["']([^"']+)["']/i)?.[1] ??
        tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1],
      "img",
    );
  }

  return out;
}

const ORIGIN_RANK: Record<ImageOrigin, number> = {
  opengraph: 6,
  jsonld: 6,
  embedded_json: 5,
  link_preload: 4,
  picture_source: 3,
  img: 2,
  provider: 5,
};

/**
 * Rank, deduplicate and integrity-check candidate photos for one listing.
 * The primary photo is the strongest-sourced, largest image the page itself
 * published — never an image borrowed from anywhere else.
 */
export function selectListingImages(
  candidates: ImageCandidate[],
  pageUrl: string,
  limit = 10,
): ListingImages {
  const seen = new Map<string, ImageCandidate>();
  let rejected = 0;
  for (const c of candidates) {
    if (!isContentImage(c.url)) {
      rejected += 1;
      continue;
    }
    const key = imageKey(c.url);
    const current = seen.get(key);
    if (!current) {
      seen.set(key, c);
      continue;
    }
    // Keep the best rendition of the same photo.
    const better =
      ORIGIN_RANK[c.origin] * 10000 + c.width > ORIGIN_RANK[current.origin] * 10000 + current.width;
    if (better) seen.set(key, { ...c, order: Math.min(c.order, current.order) });
  }

  const ranked = [...seen.values()].sort((a, b) => {
    const own = Number(sameOperator(b.url, pageUrl)) - Number(sameOperator(a.url, pageUrl));
    if (own !== 0) return own;
    const origin = ORIGIN_RANK[b.origin] - ORIGIN_RANK[a.origin];
    if (origin !== 0) return origin;
    if (b.width !== a.width) return b.width - a.width;
    return a.order - b.order;
  });

  const images = ranked.slice(0, limit).map((c) => c.url);
  const foreign = ranked.filter((c) => !sameOperator(c.url, pageUrl)).length;
  const note =
    images.length === 0
      ? "the listing page published no usable photo"
      : `${images.length} photo(s) read from the listing page` +
        (foreign > 0 ? `; ${foreign} served by an external host` : "") +
        (rejected > 0 ? `; ${rejected} non-content image(s) filtered out` : "");

  return { images, primary: images[0] ?? null, note, rejected };
}

/** Convenience: HTML in, listing photos out. */
export function extractListingImages(html: string, pageUrl: string, limit = 10): ListingImages {
  return selectListingImages(collectImageCandidates(html, pageUrl), pageUrl, limit);
}

/** Merge provider-supplied photos with page-derived ones, keeping integrity. */
export function mergeImageSets(pageUrl: string, sets: { urls: string[]; origin: ImageOrigin }[]): ListingImages {
  let order = 0;
  const candidates: ImageCandidate[] = [];
  for (const set of sets) {
    for (const raw of set.urls) {
      const abs = absoluteImageUrl(raw, pageUrl);
      if (abs) candidates.push({ url: abs, origin: set.origin, width: 0, order: order++ });
    }
  }
  return selectListingImages(candidates, pageUrl);
}
