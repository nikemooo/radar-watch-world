import { collectMarketQuotes, consensusFromQuotes } from "../src/lib/market/sources.server";
const y = await import("../src/lib/market/yahoo.server");
const specs: any[] = [
 { instrument: { symbol:"BTC/USD", name:"Bitcoin", kind:"crypto", metric:"price", unit:"USD", currency:"USD", base_currency:"BTC", quote_currency:"USD", coingecko_id:"bitcoin", stooq_symbol:"btcusd" }, rules: [] },
 { instrument: { symbol:"XAU/USD", name:"Gold", kind:"commodity", metric:"price", unit:"USD", currency:"USD", stooq_symbol:"xauusd" }, rules: [] },
 { instrument: { symbol:"NVDA", name:"Nvidia", kind:"stock", metric:"price", unit:"USD", currency:"USD", stooq_symbol:"nvda.us" }, rules: [] },
 { instrument: { symbol:"EUR/USD", name:"Euro", kind:"forex", metric:"price", unit:"USD", base_currency:"EUR", quote_currency:"USD" }, rules: [] },
];
async function round(label: string) {
  for (const s of specs) {
    const r = await collectMarketQuotes(s, { allowWebSearch: true, rawRequest: s.instrument.name });
    const c = consensusFromQuotes(r.quotes);
    console.log(label, s.instrument.symbol, c ? `value=${c.value} sources=${c.quotes.map((q:any)=>q.source).join("+")}` : "NO VALUE",
      "attempts=" + r.attempts.map(a=>`${a.source}:${a.ok?"ok":"FAIL("+(a.error||"").slice(0,60)+")"}`).join(" "));
  }
}
await round("[normal]");
// simulate Yahoo outage: patch global fetch to reject yahoo hosts
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (/yahoo/i.test(url)) throw new Error("SIMULATED Yahoo outage (503)");
  return realFetch(input, init);
}) as any;
await round("[yahoo-down]");
