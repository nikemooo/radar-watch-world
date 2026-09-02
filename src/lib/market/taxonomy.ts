/**
 * Event taxonomy — V3.
 *
 * The V2 classifier picked the first pattern family that matched, which made
 * almost every macro-flavoured story "monetary_policy". V3 scores the WHOLE
 * text: every family accumulates weighted evidence from the headline (weighted
 * heavier) and the body, and the winner must beat the runner-up by a margin —
 * otherwise the event stays deliberately unclassified as "other" instead of
 * being confidently wrong.
 *
 * Pure functions, no I/O, no asset-specific knowledge.
 */

export type EventCategory =
  | "geopolitics"
  | "military_conflict"
  | "sanctions"
  | "monetary_policy"
  | "inflation"
  | "employment"
  | "economic_data"
  | "fiscal_policy"
  | "regulation"
  | "legislation"
  | "corporate"
  | "earnings"
  | "product_launch"
  | "supply_chain"
  | "commodity_supply"
  | "energy"
  | "natural_disaster"
  | "cyber"
  | "market_structure"
  | "crypto"
  | "other";

export const EVENT_CATEGORIES: EventCategory[] = [
  "geopolitics",
  "military_conflict",
  "sanctions",
  "monetary_policy",
  "inflation",
  "employment",
  "economic_data",
  "fiscal_policy",
  "regulation",
  "legislation",
  "corporate",
  "earnings",
  "product_launch",
  "supply_chain",
  "commodity_supply",
  "energy",
  "natural_disaster",
  "cyber",
  "market_structure",
  "crypto",
  "other",
];

export function asEventCategory(value: unknown): EventCategory {
  return typeof value === "string" && (EVENT_CATEGORIES as string[]).includes(value)
    ? (value as EventCategory)
    : "other";
}

/**
 * Weighted signals. Weight expresses how DECISIVE a term is for its family:
 * "fomc" all but settles monetary_policy, whereas "rate" alone barely hints.
 */
const SIGNALS: Record<Exclude<EventCategory, "other">, [RegExp, number][]> = {
  monetary_policy: [
    [/\b(fomc|federal reserve|the fed\b|ecb|riksbank|bank of japan|boj\b|bank of england|pboc)\b/i, 3],
    [/\b(rate (cut|hike|decision|path)|styrränta|räntebesked|policy rate|benchmark rate)\b/i, 3],
    [/\b(quantitative (easing|tightening)|balance sheet runoff|dot plot|hawkish|dovish)\b/i, 2],
    [/\b(interest rates?|penningpolitik|monetary policy)\b/i, 1],
  ],
  inflation: [
    [/\b(cpi|core inflation|inflation rate|ppi|pce|kpi(f)?|konsumentpris)\b/i, 3],
    [/\b(price pressures|disinflation|deflation|inflationsförväntningar)\b/i, 2],
    [/\binflation\b/i, 1],
  ],
  employment: [
    [/\b(nonfarm payrolls|payrolls|jobs report|unemployment rate|jobless claims|arbetslöshet|sysselsättning)\b/i, 3],
    [/\b(layoffs|hiring freeze|labour market|labor market|varsel)\b/i, 2],
  ],
  economic_data: [
    [/\b(gdp|bnp|pmi|ism\b|retail sales|industrial production|trade balance|consumer confidence|housing starts)\b/i, 3],
    [/\b(economic data|statistics office|scb|eurostat|forecast (cut|raised))\b/i, 1],
  ],
  fiscal_policy: [
    [/\b(budget (deal|bill|deficit)|government shutdown|debt ceiling|stimulus package|tax (cut|hike|reform)|statsbudget)\b/i, 3],
    [/\b(treasury (issuance|auction)|sovereign debt|fiscal)\b/i, 2],
  ],
  sanctions: [
    [/\b(sanction[s]?|embargo|export controls?|export restrictions?|entity list|price cap|sanktioner|exportförbud)\b/i, 3],
    [/\b(tariff|tull|trade war|import duty|blacklist)\b/i, 2],
  ],
  military_conflict: [
    [/\b(air ?strike[s]?|missile|drone attack|invasion|offensive|troops|ceasefire|shelling|war\b|krig|militär)\b/i, 3],
    [/\b(attack(ed|s)?|killed|casualties|militants|centcom|nato)\b/i, 1],
  ],
  geopolitics: [
    [/\b(summit|treaty|diplomat|foreign minister|election|coup|referendum|opec\+? meeting|alliance|peace talks)\b/i, 3],
    [/\b(tension[s]?|geopolitic|bilateral|relations with)\b/i, 1],
  ],
  regulation: [
    [/\b(regulator|sec\b|cftc|fca\b|antitrust|approval of|licence|license|compliance order|banned|förbud)\b/i, 3],
    [/\b(oversight|guideline[s]?|rulemaking|regelverk)\b/i, 1],
  ],
  legislation: [
    [/\b(bill passed|senate|congress|parliament|riksdag|lawmakers|legislation|vote[ds]? on the bill|lagförslag)\b/i, 3],
  ],
  earnings: [
    [/\b(earnings|quarterly results|q[1-4] (results|report)|guidance|eps\b|revenue (beat|miss)|kvartalsrapport)\b/i, 3],
    [/\b(profit|omsättning|margins|outlook raised|outlook cut)\b/i, 1],
  ],
  corporate: [
    [/\b(acquisition|merger|takeover|buyback|dividend|ceo (steps|resign|appoint)|spin-?off|uppköp|restructuring)\b/i, 3],
    [/\b(partnership|contract win|investment of|stake in)\b/i, 1],
  ],
  product_launch: [
    [/\b(unveil(ed|s)?|launch(ed|es)? (the )?new|announce[sd]? (the )?new (chip|product|model)|next-generation|lanserar)\b/i, 3],
  ],
  supply_chain: [
    [/\b(supply chain|shipping|freight|port (closure|congestion)|logistics|bottleneck|leveranskedja|container)\b/i, 3],
    [/\b(delays|backlog|shortage of components)\b/i, 1],
  ],
  commodity_supply: [
    [/\b(production cut|output cut|quota|mine (closure|strike)|harvest|inventories|stockpile|reserves release|utbudsminskning)\b/i, 3],
    [/\b(supply (glut|deficit)|shortage|överskott|brist)\b/i, 2],
  ],
  energy: [
    [/\b(crude|brent|wti|opec|refinery|pipeline|lng|natural gas|barrel|elpris|oljepris)\b/i, 3],
    [/\b(energy prices|power grid|electricity)\b/i, 1],
  ],
  natural_disaster: [
    [/\b(hurricane|earthquake|flood|wildfire|typhoon|drought|storm damage|volcano|jordbävning|översvämning)\b/i, 3],
  ],
  cyber: [
    [/\b(cyberattack|ransomware|data breach|hacked|exploit|security incident|dataintrång)\b/i, 3],
  ],
  market_structure: [
    [/\b(circuit breaker|liquidity crunch|margin call|short squeeze|index rebalanc|delisting|trading halt|flash crash)\b/i, 3],
    [/\b(rally|sell-?off|plunge|surge|record high|all-time high|correction|rasar|stiger kraftigt)\b/i, 1],
  ],
  crypto: [
    [/\b(bitcoin|ethereum|stablecoin|spot etf|on-chain|halving|defi|exchange hack|kryptobörs)\b/i, 3],
    [/\b(crypto|token|blockchain|wallet)\b/i, 1],
  ],
};

export interface CategoryScore {
  category: EventCategory;
  score: number;
}

/**
 * Score every family over the full text. The headline counts double because a
 * headline states the event, while the body may merely mention context.
 */
export function scoreCategories(headline: string, body = ""): CategoryScore[] {
  const scores: CategoryScore[] = [];
  for (const [category, signals] of Object.entries(SIGNALS) as [
    Exclude<EventCategory, "other">,
    [RegExp, number][],
  ][]) {
    let score = 0;
    for (const [pattern, weight] of signals) {
      const inHead = pattern.test(headline);
      const bodyHits = (body.match(new RegExp(pattern.source, "gi")) ?? []).length;
      if (inHead) score += weight * 2;
      if (bodyHits > 0) score += weight * Math.min(bodyHits, 3) * 0.5;
    }
    if (score > 0) scores.push({ category, score: Math.round(score * 100) / 100 });
  }
  return scores.sort((a, b) => b.score - a.score);
}

/**
 * Context-aware classification. Requires both a floor and a margin over the
 * runner-up: an ambiguous story is honestly "other" rather than mislabelled.
 */
export function classifyEvent(headline: string, body = ""): EventCategory {
  const scores = scoreCategories(headline, body);
  const top = scores[0];
  if (!top || top.score < 2) return "other";
  const second = scores[1];
  if (second && top.score - second.score < 0.75) {
    // Two families are equally supported; prefer the more specific one.
    return SPECIFICITY.indexOf(top.category) <= SPECIFICITY.indexOf(second.category)
      ? top.category
      : second.category;
  }
  return top.category;
}

/** Most specific first — used only to break near-ties. */
const SPECIFICITY: EventCategory[] = [
  "military_conflict",
  "sanctions",
  "natural_disaster",
  "cyber",
  "earnings",
  "product_launch",
  "monetary_policy",
  "inflation",
  "employment",
  "commodity_supply",
  "supply_chain",
  "legislation",
  "regulation",
  "fiscal_policy",
  "crypto",
  "energy",
  "corporate",
  "economic_data",
  "geopolitics",
  "market_structure",
  "other",
];

/** Up to three supporting categories, for UI facets and theme grouping. */
export function eventCategories(headline: string, body = ""): EventCategory[] {
  const scores = scoreCategories(headline, body).filter((s) => s.score >= 1.5);
  return scores.slice(0, 3).map((s) => s.category);
}

/** V2 stored a coarser set; map legacy values forward so history keeps working. */
const LEGACY_MAP: Record<string, EventCategory> = {
  conflict: "military_conflict",
  macro_data: "economic_data",
  supply: "commodity_supply",
  legal: "legislation",
  market_move: "market_structure",
};

export function normalizeCategory(value: unknown): EventCategory {
  if (typeof value !== "string") return "other";
  return LEGACY_MAP[value] ?? asEventCategory(value);
}

/** Two categories that describe compatible kinds of happening. */
export function relatedCategories(a: EventCategory, b: EventCategory): boolean {
  if (a === b) return true;
  const families: EventCategory[][] = [
    ["military_conflict", "geopolitics", "sanctions"],
    ["monetary_policy", "inflation", "employment", "economic_data", "fiscal_policy"],
    ["commodity_supply", "supply_chain", "energy"],
    ["regulation", "legislation"],
    ["corporate", "earnings", "product_launch"],
  ];
  return families.some((f) => f.includes(a) && f.includes(b));
}
