import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanRow } from "./plans";

type Db = SupabaseClient<any, any, any>;

export type Entitlements = {
  planKey: string;
  plan: PlanRow;
  isInternal: boolean;
  radarCount: number;
  alertsThisMonth: number;
  subscription: {
    status: string;
    cancel_at_period_end: boolean;
    current_period_end: string | null;
    pending_plan_key: string | null;
    pending_effective_at: string | null;
    billing_interval: string;
    stripe_subscription_id: string | null;
    stripe_customer_id: string | null;
  } | null;
};

const ACTIVE = new Set(["active", "trialing", "past_due"]);

/** Resolve the caller's effective plan from their subscription row (source of truth). */
export async function getEntitlements(db: Db, userId: string, environment = "sandbox"): Promise<Entitlements> {
  const [{ data: plans }, { data: profile }, { data: sub }, { count }] = await Promise.all([
    db.from("plans").select("*").order("sort_order"),
    db.from("profiles").select("plan_key, is_internal").eq("id", userId).maybeSingle(),
    db
      .from("subscriptions")
      .select("*")
      .eq("user_id", userId)
      .eq("environment", environment)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from("radars").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);

  const allPlans = (plans ?? []) as PlanRow[];
  const free = allPlans.find((p) => p.key === "free")!;

  let planKey = "free";
  if (sub) {
    const periodOk = !sub.current_period_end || new Date(sub.current_period_end).getTime() > Date.now();
    if ((ACTIVE.has(sub.status) || sub.status === "canceled") && periodOk) planKey = sub.plan_key;
  } else if (profile?.is_internal && profile?.plan_key) {
    planKey = profile.plan_key;
  }

  const plan = allPlans.find((p) => p.key === planKey) ?? free;

  let alertsThisMonth = 0;
  if (plan.max_alerts_per_month !== null) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { count: alertCount } = await db
      .from("alerts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", monthStart.toISOString());
    alertsThisMonth = alertCount ?? 0;
  }

  return {
    planKey: plan.key,
    plan,
    isInternal: Boolean(profile?.is_internal),
    radarCount: count ?? 0,
    alertsThisMonth,
    subscription: sub
      ? {
          status: sub.status,
          cancel_at_period_end: sub.cancel_at_period_end,
          current_period_end: sub.current_period_end,
          pending_plan_key: sub.pending_plan_key ?? null,
          pending_effective_at: sub.pending_effective_at ?? null,
          billing_interval: sub.billing_interval ?? "month",
          stripe_subscription_id: sub.stripe_subscription_id ?? null,
          stripe_customer_id: sub.stripe_customer_id ?? null,
        }
      : null,
  };
}

/** Remaining alert allowance for this month; null means unlimited. */
export function remainingAlerts(e: Entitlements): number | null {
  if (e.isInternal) return null;
  if (e.plan.max_alerts_per_month === null) return null;
  return Math.max(0, e.plan.max_alerts_per_month - e.alertsThisMonth);
}

/** Minimum minutes between sweeps allowed by the plan. */
export function minSweepIntervalMinutes(e: Entitlements): number {
  return e.isInternal ? 0 : e.plan.min_check_interval_minutes;
}
