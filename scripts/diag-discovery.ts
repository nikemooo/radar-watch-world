/** AI-free discovery diagnostic: search -> index expansion -> item URL families. */
import { researchQueries } from "@/lib/search/providers.server";
import { expandIndexPages } from "@/lib/search/index-expansion.server";
import { detectItemFamilies } from "@/lib/search/url-shape";

const queries = [
  "BMW M340i xDrive till salu Sverige",
  "BMW M340i begagnad blocket",
  "BMW M340i xDrive 2023 säljes Sverige",
  "BMW M340i xDrive pris Sverige",
  "svart BMW M340i xDrive 2021 till salu",
];

const research = await researchQueries(queries, 10, queries.length);
console.log(`\nDOCS: ${research.documents.length}, cost ${research.costEstimate}`);

const expansion = await expandIndexPages(research.documents, 14);
console.log(`\nEXPANDED ${expansion.expanded.length} of ${expansion.attempted} (cost ${expansion.costEstimate})`);
for (const e of expansion.expanded) {
  console.log(`\n# ${e.url}  links=${e.linkCount} text=${e.textLength} items=${e.itemUrls.length}`);
  for (const f of e.families.slice(0, 3)) {
    console.log(`   pattern ${f.signature} (${f.urls.length}) e.g. ${f.urls.slice(0, 3).join(" , ")}`);
  }
}

const allItems = expansion.documents.flatMap((d) =>
  detectItemFamilies([...(d.links ?? [])], d.url).flatMap((f) => f.urls),
);
const blocket = allItems.filter((u) => u.includes("blocket.se/mobility/item"));
console.log(`\nTOTAL item-shaped URLs: ${allItems.length}`);
console.log(`Blocket item URLs discovered: ${blocket.length}`);
console.log(blocket.slice(0, 15).join("\n"));
