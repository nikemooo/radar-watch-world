import { chatJson, MODELS } from "./gateway.server";
import type { RadarConfig } from "../radar-types";

const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "category", "config", "suggested_frequency"],
  properties: {
    name: { type: "string" },
    category: { type: "string" },
    suggested_frequency: { type: "string", enum: ["smart", "instant", "daily", "weekly"] },
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
      },
    },
  },
} as const;

export interface InterpretedRadar {
  name: string;
  category: string;
  suggested_frequency: "smart" | "instant" | "daily" | "weekly";
  config: RadarConfig;
}

export async function interpretRequest(request: string): Promise<InterpretedRadar> {
  return chatJson<InterpretedRadar>({
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
      "Do not invent constraints the user did not state; leave unknown fields null or empty.",
    user: request,
  });
}
