/**
 * One-off: creates the Stripe product and per-market prices for the Plus plan.
 * Run with: bun scripts/create-plus-prices.ts
 */
import { createStripeClient } from "../src/lib/stripe.server";

const MARKETS: Array<{ market: string; currency: string; month: number; year: number }> = [
  { market: "se", currency: "sek", month: 19900, year: 199000 },
  { market: "us", currency: "usd", month: 1999, year: 19900 },
  { market: "eu", currency: "eur", month: 1999, year: 19900 },
  { market: "gb", currency: "gbp", month: 1699, year: 16990 },
  { market: "ca", currency: "cad", month: 2699, year: 26990 },
  { market: "au", currency: "aud", month: 3299, year: 32990 },
];

const stripe = createStripeClient("sandbox");

const product = await stripe.products.create({
  name: "Radar Plus",
  description: "3 Radars, daily sweeps, unlimited alerts, full detail fetching, 30-day history.",
  tax_code: "txcd_10103001",
});

const rows: string[] = [];
for (const m of MARKETS) {
  for (const interval of ["month", "year"] as const) {
    const price = await stripe.prices.create({
      product: product.id,
      currency: m.currency,
      unit_amount: interval === "month" ? m.month : m.year,
      recurring: { interval },
    });
    rows.push(
      `('plus','${m.market}','${m.currency.toUpperCase()}','${interval}',${
        interval === "month" ? m.month : m.year
      },'${price.id}',true)`,
    );
  }
}

console.log(`product: ${product.id}`);
console.log(
  "insert into public.plan_prices (plan_key, market_code, currency, billing_interval, amount_minor, stripe_price_id, active) values\n" +
    rows.join(",\n") +
    ";",
);
