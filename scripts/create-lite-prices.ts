/**
 * Reference catalog for the Radar Lite payment product.
 * The product and prices are provisioned through Lovable Payments using these
 * permanent IDs; this file documents the values used by the database catalog.
 */
export const LITE_PRODUCT_ID = "radar_lite_plan";

export const LITE_PRICES = [
  { market: "se", currency: "sek", month: 14900, year: 149000, monthId: "radar_lite_se_monthly", yearId: "radar_lite_se_yearly" },
  { market: "us", currency: "usd", month: 1499, year: 14990, monthId: "radar_lite_us_monthly", yearId: "radar_lite_us_yearly" },
  { market: "eu", currency: "eur", month: 1499, year: 14990, monthId: "radar_lite_eu_monthly", yearId: "radar_lite_eu_yearly" },
  { market: "gb", currency: "gbp", month: 1299, year: 12990, monthId: "radar_lite_gb_monthly", yearId: "radar_lite_gb_yearly" },
  { market: "ca", currency: "cad", month: 1999, year: 19990, monthId: "radar_lite_ca_monthly", yearId: "radar_lite_ca_yearly" },
  { market: "au", currency: "aud", month: 2499, year: 24990, monthId: "radar_lite_au_monthly", yearId: "radar_lite_au_yearly" },
] as const;