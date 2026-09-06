import { eventSimilarity, sameStory, strongTokens } from "../src/lib/market/events";
const a = { title: "Oil surges above $95 on renewed US-Iran fighting" };
const b = { title: "Brent rises over 2% after tit-for-tat strikes in the Gulf" };
console.log(strongTokens(a.title), strongTokens(b.title), eventSimilarity(a,b), sameStory(a,b));
