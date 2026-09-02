/**
 * Category-agnostic monitoring configuration.
 * Every Radar — cars, stocks, watches, flights, jobs, news — is described
 * with the same structure. No category is special-cased.
 */
import type { AttributeSpec } from "./monitoring/normalize";
import type { HardConstraint } from "./monitoring/criteria";
import type { MarketMonitorSpec } from "./market/types";

export type { AttributeSpec, HardConstraint, MarketMonitorSpec };

/**
 * Which engine serves the radar. product_discovery hunts items/listings;
 * market_monitoring tracks a measurable datapoint over time. The two engines
 * are fully separate — this field is only the dispatch key.
 */
export type RadarKind = "product_discovery" | "market_monitoring";

export function asRadarKind(value: unknown): RadarKind {
  return value === "market_monitoring" ? "market_monitoring" : "product_discovery";
}

export type RadarFrequency = "smart" | "instant" | "daily" | "weekly";

/**
 * Two ways to use a radar. The mode never changes what counts as a match —
 * it only changes how eagerly the first sweep collects current inventory.
 */
export type RadarMode = "find_and_watch" | "monitor_market";

export const radarModeLabel: Record<RadarMode, string> = {
  find_and_watch: "Hitta nu + bevaka",
  monitor_market: "Övervaka marknaden",
};

export const radarModeDescription: Record<RadarMode, string> = {
  find_and_watch:
    "Hitta allt relevant som finns på marknaden just nu och fortsätt sedan leta efter nya möjligheter.",
  monitor_market:
    "Följ marknaden över tid och upptäck förändringar, prisrörelser och nya relevanta observationer.",
};

export function asRadarMode(value: unknown): RadarMode {
  return value === "monitor_market" ? "monitor_market" : "find_and_watch";
}

/** How the first sweep is kicked off. Scheduling is a Pro Plus feature. */
export type RadarStart = "now" | "scheduled" | "manual";


export type Importance = "critical" | "important" | "interesting" | "minor";

export interface RadarConfig {
  /** Which engine serves this radar — never changes mid-life. */
  kind: RadarKind;
  target: string;
  interpretation: string;
  locations: string[];
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  time_period: string | null;
  preferences: string[];
  important_criteria: string[];
  monitored_events: string[];
  search_queries: string[];
  exclusions: string[];
  /** Item-level attributes that matter for THIS radar (category-agnostic). */
  attribute_schema: AttributeSpec[];
  /** Machine-checkable requirements derived from the user's own wording. */
  hard_constraints: HardConstraint[];
  /** Market Monitoring only: instrument + alert rules. Null for product radars. */
  market: MarketMonitorSpec | null;
  /** UI language the radar was created in — AI interpretations follow it. */
  language?: string;
}

export const emptyConfig: RadarConfig = {
  kind: "product_discovery",
  target: "",
  interpretation: "",
  locations: [],
  price_min: null,
  price_max: null,
  currency: null,
  time_period: null,
  preferences: [],
  important_criteria: [],
  monitored_events: [],
  search_queries: [],
  exclusions: [],
  attribute_schema: [],
  hard_constraints: [],
  market: null,
};

export function asConfig(value: unknown): RadarConfig {
  if (!value || typeof value !== "object") return emptyConfig;
  return { ...emptyConfig, ...(value as Partial<RadarConfig>) };
}

export interface AlertSource {
  title: string;
  url: string;
  publisher?: string;
}

export function asSources(value: unknown): AlertSource[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (s): s is AlertSource => !!s && typeof s === "object" && typeof (s as AlertSource).url === "string",
  );
}

export const importanceOrder: Importance[] = ["critical", "important", "interesting", "minor"];

export const importanceLabel: Record<Importance, string> = {
  critical: "Critical",
  important: "Important",
  interesting: "Interesting",
  minor: "No action needed",
};

export const frequencyLabel: Record<RadarFrequency, string> = {
  smart: "Smart (recommended)",
  instant: "Instant",
  daily: "Daily",
  weekly: "Weekly",
};

export const recencyPresets = [
  { days: 1, label: "Last 24 hours" },
  { days: 3, label: "Last 3 days" },
  { days: 7, label: "Last week" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 365, label: "Last year" },
  { days: 1825, label: "Evergreen (5 years)" },
];

export function frequencyToMinutes(freq: string): number {
  switch (freq) {
    case "instant":
      return 30;
    case "daily":
      return 60 * 24;
    case "weekly":
      return 60 * 24 * 7;
    default:
      return 60 * 4; // smart
  }
}
