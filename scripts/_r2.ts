import { measureReaction, resolveFeed } from "@/lib/market/reaction.server";
import { yahooSeries } from "@/lib/market/yahoo.server";
console.log(resolveFeed("XAU/USD","Guld"));
for (const iso of ["2026-09-05T10:00:00Z","2026-08-20T10:00:00Z","2026-05-01T10:00:00Z"]) {
  const r = await measureReaction({symbol:"XAU/USD",name:"Guld",kind:"commodity",eventIso:iso,preferredWindow:"4h"});
  console.log(iso, r.available, r.changePct, r.window, r.resolutionHours, r.unavailableReason);
}
const s = await yahooSeries("GC=F", Date.parse("2026-09-05T10:00:00Z"));
console.log("pts", s.points.length, s.resolutionHours, new Date(s.points[0]!.t).toISOString(), new Date(s.points.at(-1)!.t).toISOString());
