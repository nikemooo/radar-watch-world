export type BillingInterval = "month" | "year";

export type Market = {
  code: string;
  name: string;
  currency: string;
  locale: string;
  country_codes: string[];
  sort_order: number;
  active?: boolean;
};

export type PlanPrice = {
  plan_key: string;
  market_code: string;
  billing_interval: BillingInterval;
  currency: string;
  amount_minor: number;
  stripe_price_id: string;
  active?: boolean;
};

/** Fallback when nothing about the visitor is known. */
export const FALLBACK_MARKET_CODE = "us";
export const MARKET_STORAGE_KEY = "radar.market";

/** Format a minor-unit amount using the market's own locale and currency. */
export function formatMoney(amountMinor: number, currency: string, locale = "en-US"): string {
  const major = amountMinor / 100;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(major);
}

export function marketByCode(markets: Market[], code: string | null | undefined): Market | undefined {
  if (!code) return undefined;
  return markets.find((m) => m.code === code.toLowerCase());
}

export function marketForCountry(markets: Market[], country: string | null | undefined): Market | undefined {
  if (!country) return undefined;
  const cc = country.toUpperCase();
  return markets.find((m) => m.country_codes.includes(cc));
}

export function marketForCurrency(markets: Market[], currency: string | null | undefined): Market | undefined {
  if (!currency) return undefined;
  const c = currency.toUpperCase();
  return markets.find((m) => m.currency.toUpperCase() === c);
}

/** Country code from a BCP-47 locale such as `en-GB` or `sv-SE`. */
export function countryFromLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const region = locale.split("-").find((part) => /^[A-Za-z]{2}$/.test(part) && part === part.toUpperCase());
  return region ? region.toUpperCase() : null;
}

/**
 * Resolve the market to price in, in strict priority order:
 * 1. explicit user selection, 2. billing country from the payment method,
 * 3. account country, 4. browser locale. IP geolocation is never used.
 */
export function resolveMarket(
  markets: Market[],
  signals: {
    selectedCode?: string | null;
    billingCountry?: string | null;
    billingCurrency?: string | null;
    accountCountry?: string | null;
    locale?: string | null;
  },
): { market: Market; source: "selected" | "billing" | "account" | "locale" | "fallback" } {
  const fallback =
    marketByCode(markets, FALLBACK_MARKET_CODE) ?? markets[0] ?? {
      code: FALLBACK_MARKET_CODE,
      name: "United States",
      currency: "USD",
      locale: "en-US",
      country_codes: ["US"],
      sort_order: 0,
    };

  const selected = marketByCode(markets, signals.selectedCode);
  if (selected) return { market: selected, source: "selected" };

  const billing =
    marketForCountry(markets, signals.billingCountry) ?? marketForCurrency(markets, signals.billingCurrency);
  if (billing) return { market: billing, source: "billing" };

  const account = marketForCountry(markets, signals.accountCountry);
  if (account) return { market: account, source: "account" };

  const fromLocale = marketForCountry(markets, countryFromLocale(signals.locale));
  if (fromLocale) return { market: fromLocale, source: "locale" };

  return { market: fallback, source: "fallback" };
}

export function findPlanPrice(
  prices: PlanPrice[],
  planKey: string,
  marketCode: string,
  interval: BillingInterval,
): PlanPrice | undefined {
  return prices.find(
    (p) =>
      p.plan_key === planKey &&
      p.market_code === marketCode &&
      p.billing_interval === interval &&
      p.active !== false,
  );
}
