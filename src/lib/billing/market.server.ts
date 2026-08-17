import type Stripe from "stripe";
import { FALLBACK_MARKET_CODE, resolveMarket, type Market, type PlanPrice } from "./markets";

type Db = { from: (table: string) => any };

export async function loadCatalog(db: Db): Promise<{ markets: Market[]; prices: PlanPrice[] }> {
  const [markets, prices] = await Promise.all([
    db.from("markets").select("*").eq("active", true).order("sort_order"),
    db.from("plan_prices").select("*").eq("active", true),
  ]);
  return {
    markets: (markets.data ?? []) as Market[],
    prices: (prices.data ?? []) as PlanPrice[],
  };
}

/**
 * Server-side market resolution. An existing paid subscription locks the market
 * (Stripe cannot change a subscription's currency), otherwise: explicit request >
 * stored profile choice > subscription currency > locale hint > fallback.
 */
export async function resolveBillingMarket(
  db: Db,
  userId: string,
  opts: { requestedCode?: string | null; localeHint?: string | null; environment: string },
): Promise<{ market: Market; locked: boolean; markets: Market[]; prices: PlanPrice[] }> {
  const { markets, prices } = await loadCatalog(db);
  const [{ data: profile }, { data: sub }] = await Promise.all([
    db.from("profiles").select("market_code").eq("id", userId).maybeSingle(),
    db
      .from("subscriptions")
      .select("market_code, currency, status, stripe_subscription_id")
      .eq("user_id", userId)
      .eq("environment", opts.environment)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const activeSub =
    sub?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(sub.status) ? sub : null;

  if (activeSub) {
    const locked = resolveMarket(markets, {
      selectedCode: activeSub.market_code,
      billingCurrency: activeSub.currency,
    });
    return { market: locked.market, locked: true, markets, prices };
  }

  const resolved = resolveMarket(markets, {
    selectedCode: opts.requestedCode ?? profile?.market_code ?? null,
    billingCurrency: sub?.currency ?? null,
    locale: opts.localeHint ?? null,
  });
  return { market: resolved.market, locked: false, markets, prices };
}

/** The single source of truth for which Stripe Price a (plan, market, interval) maps to. */
export async function resolvePlanPrice(
  db: Db,
  planKey: string,
  marketCode: string,
  interval: "month" | "year",
): Promise<PlanPrice | null> {
  const { data } = await db
    .from("plan_prices")
    .select("*")
    .eq("plan_key", planKey)
    .eq("market_code", marketCode)
    .eq("billing_interval", interval)
    .eq("active", true)
    .maybeSingle();
  return (data as PlanPrice | null) ?? null;
}

/** Confirm the Stripe Price still matches the catalog (currency, amount, interval, live status). */
export async function assertStripePriceMatches(stripe: Stripe, expected: PlanPrice): Promise<string | null> {
  const price = await stripe.prices.retrieve(expected.stripe_price_id);
  if (!price.active) return "That price is no longer available.";
  if ((price.currency ?? "").toUpperCase() !== expected.currency.toUpperCase()) {
    return `Currency mismatch for ${expected.plan_key} in ${expected.market_code}.`;
  }
  if (price.unit_amount !== expected.amount_minor) {
    return `Amount mismatch for ${expected.plan_key} in ${expected.market_code}.`;
  }
  if (price.recurring?.interval !== expected.billing_interval) {
    return `Billing interval mismatch for ${expected.plan_key}.`;
  }
  return null;
}

export const DEFAULT_MARKET = FALLBACK_MARKET_CODE;
