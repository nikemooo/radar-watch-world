import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  MARKET_STORAGE_KEY,
  findPlanPrice,
  formatMoney,
  resolveMarket,
  type BillingInterval,
  type Market,
  type PlanPrice,
} from "@/lib/billing/markets";

type Signals = {
  /** Billing country/currency taken from an existing subscription, when known. */
  billingCountry?: string | null;
  billingCurrency?: string | null;
  accountCountry?: string | null;
};

/**
 * Market + localized price catalog for the current visitor.
 * Priority: explicit selection > billing country/currency > account country > browser locale.
 */
export function useMarketPricing(signals: Signals = {}) {
  const queryClient = useQueryClient();
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [profileCode, setProfileCode] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["market-catalog"],
    queryFn: async () => {
      const [markets, prices] = await Promise.all([
        supabase.from("markets").select("*").eq("active", true).order("sort_order"),
        supabase.from("plan_prices").select("*").eq("active", true),
      ]);
      if (markets.error) throw markets.error;
      if (prices.error) throw prices.error;
      return {
        markets: (markets.data ?? []) as unknown as Market[],
        prices: (prices.data ?? []) as unknown as PlanPrice[],
      };
    },
  });

  // Explicit selection: local storage first (works signed out), then the profile.
  useEffect(() => {
    const stored = window.localStorage.getItem(MARKET_STORAGE_KEY);
    if (stored) setSelectedCode(stored);
    let cancelled = false;
    void (async () => {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("market_code")
        .eq("id", session.session.user.id)
        .maybeSingle();
      const code = (profile as { market_code?: string | null } | null)?.market_code ?? null;
      if (!cancelled && code) {
        setProfileCode(code);
        if (!stored) setSelectedCode(code);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const markets = data?.markets ?? [];
  const prices = data?.prices ?? [];

  const { market, source } = resolveMarket(markets, {
    selectedCode: selectedCode ?? profileCode,
    billingCountry: signals.billingCountry ?? null,
    billingCurrency: signals.billingCurrency ?? null,
    accountCountry: signals.accountCountry ?? null,
    locale: typeof navigator !== "undefined" ? navigator.language : null,
  });

  const setMarket = useCallback(
    async (code: string) => {
      setSelectedCode(code);
      window.localStorage.setItem(MARKET_STORAGE_KEY, code);
      const { data: session } = await supabase.auth.getSession();
      if (session.session) {
        await supabase.from("profiles").update({ market_code: code } as never).eq("id", session.session.user.id);
      }
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
    [queryClient],
  );

  const priceFor = useCallback(
    (planKey: string, interval: BillingInterval) => findPlanPrice(prices, planKey, market.code, interval),
    [prices, market.code],
  );

  const format = useCallback(
    (amountMinor: number, currency?: string) => formatMoney(amountMinor, currency ?? market.currency, market.locale),
    [market.currency, market.locale],
  );

  return { markets, prices, market, marketSource: source, setMarket, priceFor, format, isLoading };
}
