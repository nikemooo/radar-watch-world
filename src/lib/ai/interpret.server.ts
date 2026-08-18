import { chatJson, MODELS } from "./gateway.server";
import type { RadarConfig } from "../radar-types";
import {
  asMonitoringWindow,
  clampRecencyDays,
  type MonitoringWindow,
} from "../monitoring/temporal";

const configSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "category",
    "config",
    "suggested_frequency",
    "monitoring_window",
    "recency_days",
  ],
  properties: {
    name: { type: "string" },
    category: { type: "string" },
    suggested_frequency: { type: "string", enum: ["smart", "instant", "daily", "weekly"] },
    monitoring_window: { type: "string", enum: ["realtime", "rolling", "evergreen"] },
    recency_days: { type: "number" },
    config: {
      type: "object",
      additionalProperties: false,
      required: [
        "target",
        "interpretation",
        "locations",
        "price_min",
        "price_max",
        "currency",
        "time_period",
        "preferences",
        "important_criteria",
        "monitored_events",
        "search_queries",
        "exclusions",
        "attribute_schema",
        "hard_constraints",
      ],
      properties: {
        target: { type: "string" },
        interpretation: { type: "string" },
        locations: { type: "array", items: { type: "string" } },
        price_min: { type: ["number", "null"] },
        price_max: { type: ["number", "null"] },
        currency: { type: ["string", "null"] },
        time_period: { type: ["string", "null"] },
        preferences: { type: "array", items: { type: "string" } },
        important_criteria: { type: "array", items: { type: "string" } },
        monitored_events: { type: "array", items: { type: "string" } },
        search_queries: { type: "array", items: { type: "string" } },
        exclusions: { type: "array", items: { type: "string" } },
        hard_constraints: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["attribute", "op", "value", "aliases", "currency", "label"],
            properties: {
              attribute: { type: "string" },
              op: { type: "string", enum: ["lte", "lt", "gte", "gt", "eq", "neq", "includes", "excludes"] },
              value: { type: ["string", "number"] },
              aliases: { type: "array", items: { type: "string" } },
              currency: { type: ["string", "null"] },
              label: { type: "string" },
            },
          },
        },
        attribute_schema: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "label", "kind"],
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              kind: {
                type: "string",
                enum: ["text", "number", "money", "distance", "area", "date", "year", "url"],
              },
            },
          },
        },
      },
    },
  },
} as const;

export interface InterpretedRadar {
  name: string;
  category: string;
  suggested_frequency: "smart" | "instant" | "daily" | "weekly";
  monitoring_window: MonitoringWindow;
  recency_days: number;
  config: RadarConfig;
}

export async function interpretRequest(request: string): Promise<InterpretedRadar> {
  const result = await chatJson<InterpretedRadar>({
    model: MODELS.fast,
    schemaName: "radar_configuration",
    schema: configSchema,
    system:
      "You convert a natural-language monitoring request into a structured monitoring configuration " +
      "for a category-agnostic personal intelligence platform. The subject may be anything monitorable " +
      "through public information: vehicles, watches, real estate, flights, stocks, forex, crypto, " +
      "companies, competitors, products, collectibles, jobs, news, sports, technology or business " +
      "opportunities. Never assume a category that the user did not imply. " +
      "search_queries must be 3-5 concrete web search queries that would surface relevant public sources. " +
      "monitored_events lists the concrete event types worth alerting on. " +
      "interpretation is one short paragraph, written to the user, restating what will be monitored. " +
      "Do not invent constraints the user did not state; leave unknown fields null or empty. " +
      "monitoring_window describes how time-sensitive the subject is: 'realtime' for fast-moving prices, " +
      "flights or breaking news, 'rolling' for marketplaces and ongoing coverage, 'evergreen' for slow " +
      "research topics. recency_days is how old information may be and still count as a genuine discovery: " +
      "news and company monitoring typically 1-7, travel 1-3, marketplaces 30-90, evergreen research 180-730. " +
      "Infer it from the request; the user can override it later. " +
      "attribute_schema lists 5-10 item-level attributes that matter for this subject, each with a snake_case key, " +
      "a short human label and a kind: 'money' for prices, 'distance' for mileage/range, 'area' for size, " +
      "'year' for model/build years, 'date' for dates, 'number' for counts, 'url' for links, 'text' otherwise. " +
      "Derive them from the subject itself (a car needs make/model/year/mileage/colour/price/location/seller/listing_url; " +
      "a watch needs brand/model/reference/condition/price/seller/listing_url; a property needs location/price/area/rooms/property_type/listing_url). " +
      "Always include a price attribute when the subject can be bought, and always include a listing_url attribute for marketplace subjects. " +
      "hard_constraints turns the requirements the user ACTUALLY stated into machine-checkable rules over attribute_schema keys: " +
      "numeric bounds use lte/lt/gte/gt/eq/neq with a numeric value (and currency for money), text requirements use includes/excludes " +
      "with a single token value. For every text token, list aliases with the equivalent spellings and local-language words a listing " +
      "may use (for colour black: black, svart, schwarz, noir, nero; for a variant: the exact variant spellings). " +
      "label is a short human-readable form of the rule. Never invent a constraint the user did not state, and never turn a soft " +
      "preference into a hard constraint — if the user only said they prefer something, leave it in preferences.",
    user: request,
  });

  return {
    ...result,
    monitoring_window: asMonitoringWindow(result.monitoring_window),
    recency_days: clampRecencyDays(result.recency_days),
  };
}
