/**
 * Candidate item discovery.
 *
 * A retrieved document is either a single entity page or an index/aggregator
 * page listing many concrete items. This layer turns any document into a list
 * of candidate items, each keeping the discovery source it came from. It is
 * fully generic — it never assumes a category.
 *
 * Hard rule: a candidate URL must be a URL that actually appeared in the
 * retrieved page (or the page itself). Detail URLs are never invented.
 */
import { chatJson, MODELS } from "../ai/gateway.server";
import type { SearchDocument } from "../search/providers.server";

export interface CandidateItem {
  /** Item title as written by the source. */
  title: string;
  /** Individual detail URL when one exists, else null. */
  url: string | null;
  /** URL of the page the candidate was discovered on. */
  discovery_url: string;
  /** True when the candidate looks like one concrete item, not a category page. */
  individual: boolean;
  /** 0-1 confidence that a real individual item exists behind this candidate. */
  likelihood: number;
  /** 0-1 estimate of how well the candidate matches the radar's criteria. */
  relevance: number;
  /** Short verbatim clue from the page (price, ref, address...) — never invented. */
  clue: string | null;
}

const candidateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url", "discovery_url", "individual", "likelihood", "relevance", "clue"],
        properties: {
          title: { type: "string" },
          url: { type: ["string", "null"] },
          discovery_url: { type: "string" },
          individual: { type: "boolean" },
          likelihood: { type: "number" },
          relevance: { type: "number" },
          clue: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.replace(/^www\./, "") === new URL(b).host.replace(/^www\./, "");
  } catch {
    return false;
  }
}

/** URLs literally present in a document: provider link extras plus text. */
export function harvestLinks(doc: SearchDocument): string[] {
  const found = new Set<string>(doc.links ?? []);
  for (const match of doc.snippet.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) {
    found.add(match[0].replace(/[.,;]+$/, ""));
  }
  return Array.from(found).slice(0, 120);
}

export interface DiscoveryResult {
  candidates: CandidateItem[];
  indexPages: string[];
  singlePages: string[];
}

/**
 * Ask the model to split each retrieved document into concrete candidates.
 * Candidate URLs are then validated against the URLs the page really contains.
 */
export async function discoverCandidates(
  docs: SearchDocument[],
  criteria: string,
): Promise<DiscoveryResult> {
  if (docs.length === 0) return { candidates: [], indexPages: [], singlePages: [] };

  const linkIndex = new Map<string, Set<string>>();
  const blocks = docs.map((doc, i) => {
    const links = harvestLinks(doc);
    linkIndex.set(doc.url, new Set([doc.url, ...links]));
    return `[${i + 1}] PAGE: ${doc.url}
TITLE: ${doc.title}
LINKS FOUND ON PAGE:
${links.slice(0, 60).join("\n") || "(none captured)"}
TEXT:
${doc.snippet.slice(0, 3000)}`;
  });

  const result = await chatJson<{ candidates: CandidateItem[] }>({
    model: MODELS.fast,
    schemaName: "radar_candidates",
    schema: candidateSchema,
    system:
      "You split retrieved web pages into concrete candidate items for a category-agnostic monitoring platform. " +
      "An index/aggregator/search page contains MANY concrete items — emit one candidate per concrete item you can see. " +
      "A page describing a single entity, article or listing yields exactly ONE candidate whose url is the page itself. " +
      "url MUST be copied verbatim from the page's LINKS FOUND ON PAGE list or be the PAGE url itself. " +
      "If no individual URL exists for an item, set url to null — NEVER construct, guess or complete a URL. " +
      "discovery_url is always the PAGE url the candidate was seen on. " +
      "individual=true only when the candidate is one concrete item/listing/entity rather than a category, filter or navigation link. " +
      "likelihood is 0-1 that a real individual item page exists behind the candidate. " +
      "relevance is 0-1 for how well the visible information matches the monitoring criteria; do not filter items out, just score them. " +
      "clue is a short verbatim fragment from the page (price, reference, address, year) or null. Never invent facts.",
    user: `Monitoring criteria (for relevance scoring only):
${criteria}

Pages:
${blocks.join("\n\n")}`,
  });

  const candidates: CandidateItem[] = [];
  for (const c of result.candidates ?? []) {
    const discovery = docs.find((d) => d.url === c.discovery_url)?.url;
    if (!discovery) continue;
    let url = c.url && /^https?:\/\//.test(c.url) ? c.url.split("#")[0]! : null;
    const allowed = linkIndex.get(discovery);
    // Grounding: only URLs the page actually contained (or same-host links).
    if (url && !(allowed?.has(url) || allowed?.has(`${url}/`) || sameHost(url, discovery))) url = null;
    candidates.push({
      title: (c.title ?? "").slice(0, 300),
      url,
      discovery_url: discovery,
      individual: Boolean(c.individual),
      likelihood: Math.max(0, Math.min(1, Number(c.likelihood) || 0)),
      relevance: Math.max(0, Math.min(1, Number(c.relevance) || 0)),
      clue: c.clue ? String(c.clue).slice(0, 200) : null,
    });
  }

  const perPage = new Map<string, number>();
  for (const c of candidates) perPage.set(c.discovery_url, (perPage.get(c.discovery_url) ?? 0) + 1);
  const indexPages = [...perPage.entries()].filter(([, n]) => n > 1).map(([url]) => url);
  const singlePages = [...perPage.entries()].filter(([, n]) => n === 1).map(([url]) => url);

  return { candidates, indexPages, singlePages };
}

/**
 * Cost control: rank candidates and keep only the best ones for detail fetching.
 * Priority = relevance, likelihood of being an individual item, and having a
 * direct URL that is not simply the discovery page again.
 */
export function selectForDetailFetch(candidates: CandidateItem[], max: number): CandidateItem[] {
  const scored = candidates
    .filter((c) => c.url && c.individual)
    .map((c) => ({
      c,
      score:
        c.relevance * 2 +
        c.likelihood +
        (c.url !== c.discovery_url ? 0.5 : 0) +
        (c.clue ? 0.25 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const picked: CandidateItem[] = [];
  const seenUrls = new Set<string>();
  const perHost = new Map<string, number>();
  for (const { c } of scored) {
    if (picked.length >= max) break;
    const url = c.url!;
    if (seenUrls.has(url)) continue;
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }
    // Spread the budget so one marketplace cannot consume the whole sweep.
    const used = perHost.get(host) ?? 0;
    if (used >= Math.max(2, Math.ceil(max / 2))) continue;
    perHost.set(host, used + 1);
    seenUrls.add(url);
    picked.push(c);
  }
  return picked;
}
