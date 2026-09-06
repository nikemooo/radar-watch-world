import { classifyEventType, eventSimilarity } from "../src/lib/market/events";
import { normalizeCategory, relatedCategories } from "../src/lib/market/taxonomy";
const a = { title: "Oil surges above $95 on renewed US-Iran fighting", entities: ["Iran","USA","Brent"] };
const b = { title: "Brent rises over 2% after tit-for-tat strikes by U.S. and Iran", entities: ["Iran","USA","Brent"] };
const ta = classifyEventType(a.title), tb = classifyEventType(b.title);
console.log(ta, tb, relatedCategories(normalizeCategory(ta), normalizeCategory(tb)), eventSimilarity(a,b));
