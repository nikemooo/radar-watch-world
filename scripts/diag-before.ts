import { researchQueries } from "../src/lib/search/providers.server";
import { selectIndexPages } from "../src/lib/search/index-expansion.server";
import { detectItemFamilies } from "../src/lib/search/url-shape";

const queries = [
  "BMW M340i xDrive svart 2021 till salu Sverige",
  "BMW M340i xDrive begagnad till salu blocket",
  "BMW M340i xDrive 2022 svart pris kr",
];
const r = await researchQueries(queries, 8, 3);
const host = (u: string) => { try { return new URL(u).host.replace(/^www\./,""); } catch { return u; } };
const harvest = (d: any) => {
  const s = new Set<string>(d.links ?? []);
  for (const m of d.snippet.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) s.add(m[0].replace(/[.,;]+$/,""));
  return [...s];
};
for (const d of r.documents) {
  const links = harvest(d);
  const fams = detectItemFamilies(links, d.url);
  const own = fams.filter(f => f.signature.startsWith(host(d.url)));
  const best = own[0] ?? fams[0];
  const score = best ? best.urls.length * (own.length>0?2:1) * best.variableSegments : 0;
  console.log(JSON.stringify({host: host(d.url), url: d.url, links: links.length, sameHostLinks: links.filter(l=>host(l)===host(d.url)).length, text: d.snippet.length, sig: best?.signature ?? null, items: best?.urls.length ?? 0, score}));
}
const picked = selectIndexPages(r.documents, 14);
console.log("SELECTED:", JSON.stringify(picked.map(p=>p.url), null, 1));
