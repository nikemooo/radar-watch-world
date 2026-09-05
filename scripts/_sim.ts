import { eventSimilarity, sameStory, strongTokens, titleSimilarity } from "@/lib/market/events";
const t = [
 "Bitcoin hits $77,000 wall as the Fed gets trapped between weak jobs and $90 oil",
 "Bitcoin falls below $77,000 with Federal Reserves trapped between jobs and oil",
 "Bitcoin Falls Below $77,500 as US-Iran Strikes Rattle Markets and IBIT Leads $236 Million ETF Outflow - WalletInvestor.com",
 "Bitcoin Pauses After Reclaiming $80,000 as Sept. 15 Clarity Act Vote Looms",
];
for(let i=0;i<t.length;i++)for(let j=i+1;j<t.length;j++)
 console.log(i,j,titleSimilarity(t[i]!,t[j]!).toFixed(2), eventSimilarity({title:t[i]!},{title:t[j]!}).toFixed(2), sameStory({title:t[i]!},{title:t[j]!}));
console.log(strongTokens(t[0]!)); console.log(strongTokens(t[1]!));
