import { researchQueries } from "@/lib/search/providers.server";
import { discoverCandidates, selectForDetailFetch } from "@/lib/monitoring/candidates.server";
import { fetchDetailPages } from "@/lib/search/detail-fetch.server";
import { extractListingFacts, verifyPlace } from "@/lib/monitoring/listing-extract";
import { evaluateSemanticCriteria, type SemanticSurface } from "@/lib/monitoring/semantic";
import { extractPrice } from "@/lib/monitoring/price";

const queries = [
  "lägenhet till salu Nacka havsutsikt balkong",
  "bostadsrätt Nacka sjöutsikt till salu",
  "lägenhet Finnboda Nacka till salu",
];
const r = await researchQueries(queries, 8, 3);
console.log("DOCS", r.documents.length, "provider", r.provider);
const disc = await discoverCandidates(r.documents, "Lägenheter i Nacka med havsutsikt, balkong/terrass, helst under 5 miljoner");
console.log("CANDIDATES", disc.candidates.length);
const picked = selectForDetailFetch(disc.candidates, 12);
const urls = [...new Set(picked.map(p => p.url).filter((u): u is string => !!u))];
console.log("URLS", urls);
const fetched = await fetchDetailPages(urls, 8000);
console.log("OK", fetched.pages.length, "FAIL", JSON.stringify(fetched.failures));
for (const page of fetched.pages) {
  const st = page.structured;
  const listing = extractListingFacts({ url: page.url, title: page.title, text: page.text, jsonld: st?.jsonld, og: st?.og, meta: st?.meta, fields: st?.fields, description: page.description, headings: page.headings });
  const surfaces: SemanticSurface[] = [
    { url: page.url, kind: "title", text: page.title ?? "" },
    { url: page.url, kind: "description", text: page.description ?? "" },
    ...(page.headings ?? []).map(h => ({ url: page.url, kind: "heading" as const, text: h })),
    ...(page.features ?? []).map(h => ({ url: page.url, kind: "feature" as const, text: h })),
    { url: page.url, kind: "text", text: page.text },
  ];
  const sem = evaluateSemanticCriteria(["havsutsikt", "balkong", "lägenhet"], surfaces);
  const place = verifyPlace("Nacka", listing, page.text);
  console.log("=====", page.url, "via", page.via, "len", page.text.length);
  console.log(" title:", page.title);
  console.log(" desc:", (page.description ?? "").slice(0,150));
  console.log(" headings:", (page.headings ?? []).slice(0,4));
  console.log(" features:", (page.features ?? []).slice(0,6));
  console.log(" addr:", JSON.stringify(listing.location));
  console.log(" price:", JSON.stringify(extractPrice({ text: page.text, title: page.title ?? "", url: page.url } as any)));
  console.log(" place:", place.status, place.matched, place.reason);
  for (const s of sem) console.log("  sem", s.phrase, s.status, s.confidence, JSON.stringify(s.snippet?.slice(0,80)), s.source_kind);
}
