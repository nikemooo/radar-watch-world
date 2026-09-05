import { measureReaction, describeReactions } from "@/lib/market/reaction.server";
const evs = ["2026-09-02T17:31:38Z","2026-09-02T18:03:32Z","2026-09-02T13:08:21Z"];
for (const e of evs) {
  const r = await measureReaction({ symbol: "NVDA", name: "NVIDIA Corporation", kind: "stock", eventIso: e, preferredWindow: "1h" });
  console.log(e, r.provider, r.window, r.changePct, "res", r.resolutionHours, "coarse", r.coarse, r.priceBeforeAt, r.priceAfterAt, r.unavailableReason);
}
const g = await measureReaction({ symbol: "XAU/USD", name: "Gold", kind: "commodity", eventIso: "2026-09-02T13:00:00Z", preferredWindow: "4h" });
console.log("gold", g.provider, g.changePct, g.window, g.coarse, g.unavailableReason);
const b = await measureReaction({ symbol: "BTC", name: "Bitcoin", kind: "crypto", eventIso: "2026-09-02T13:00:00Z", preferredWindow: "4h" });
console.log("btc", b.provider, b.changePct, b.window, b.coarse, b.unavailableReason);
console.log(describeReactions([g,b]));
