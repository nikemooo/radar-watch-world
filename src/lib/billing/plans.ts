export type PlanKey = "free" | "lite" | "plus" | "pro" | "pro_plus";
export type BillingInterval = "month" | "year";

export type PlanRow = {
  key: string;
  name: string;
  currency: string;
  price_amount: number;
  price_amount_yearly: number;
  max_radars: number;
  min_check_interval_minutes: number;
  max_alerts_per_month: number | null;
  history_days: number;
  detail_fetch_level: string;
  max_detail_fetches: number;
  priority_processing: boolean;
  features: unknown;
  stripe_price_id: string | null;
  stripe_price_id_yearly: string | null;
  sort_order: number;
};

export const PLAN_RANK: Record<string, number> = { free: 0, lite: 1, plus: 2, pro: 3, pro_plus: 4 };

export function isUpgrade(from: string, to: string): boolean {
  return (PLAN_RANK[to] ?? 0) > (PLAN_RANK[from] ?? 0);
}

export function formatPlanPrice(amountMinor: number, currency: string): string {
  if (amountMinor === 0) return "0";
  return new Intl.NumberFormat("sv-SE").format(Math.round(amountMinor / 100)) + " " + currency.toUpperCase();
}

export function priceIdFor(plan: PlanRow, interval: BillingInterval): string | null {
  return interval === "year" ? plan.stripe_price_id_yearly : plan.stripe_price_id;
}
