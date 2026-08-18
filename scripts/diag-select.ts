import { researchQueries } from "../src/lib/search/providers.server";
import { selectIndexPages } from "../src/lib/search/index-expansion.server";
const queries = [
  "BMW M340i xDrive svart 2021 till salu Sverige",
  "BMW M340i xDrive begagnad till salu blocket",
  "BMW M340i xDrive 2022 svart pris kr",
];
const r = await researchQueries(queries, 8, 3);
const { picked, telemetry } = selectIndexPages(r.documents, 8);
for (const t of telemetry) console.log(JSON.stringify(t));
console.log("PICKED:", picked.map((p) => p.url));
