import { collectMarketQuotes, consensusFromQuotes } from "@/lib/market/sources.server";
const specs: any[] = [
 { instrument: { symbol: "XAU/USD", name: "Gold", kind: "commodity", metric: "spot_price", currency: "USD", unit: "USD/oz", stooq_symbol: "xauusd" }, rules: [] },
 { instrument: { symbol: "BTC/USD", name: "Bitcoin", kind: "crypto", metric: "spot_price", currency: "USD", coingecko_id: "bitcoin", stooq_symbol: "btcusd", base_currency: "BTC", quote_currency: "USD" }, rules: [] },
 { instrument: { symbol: "NVDA", name: "NVIDIA Corporation", kind: "stock", metric: "share_price", currency: "USD", stooq_symbol: "nvda.us" }, rules: [] },
 { instrument: { symbol: "USD/EUR", name: "USD to EUR", kind: "forex", metric: "exchange_rate", base_currency: "USD", quote_currency: "EUR", currency: "EUR", stooq_symbol: "usdeur" }, rules: [] },
];
let ok = 0, total = 0;
for (let round = 0; round < 3; round++) {
  for (const s of specs) {
    total++;
    const r = await collectMarketQuotes(s, { allowWebSearch: false, rawRequest: s.instrument.name });
    const c = consensusFromQuotes(r.quotes);
    if (c) ok++;
    console.log(round, s.instrument.symbol, c ? `${c.value} ${c.status} conf=${c.confidence}` : "FAIL", JSON.stringify(r.attempts));
  }
}
console.log(`success ${ok}/${total}`);
