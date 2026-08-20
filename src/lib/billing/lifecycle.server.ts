import type { SupabaseClient } from "@supabase/supabase-js";

export type LifecycleEvent =
  | { type: "subscription_started"; userId: string; planKey: string; environment: string; marketCode: string | null; currency: string | null }
  | { type: "subscription_cancelled"; userId: string; planKey: string; environment: string; effectiveAt: string | null }
  | { type: "subscription_resumed"; userId: string; planKey: string; environment: string }
  | { type: "plan_upgraded"; userId: string; fromPlanKey: string; toPlanKey: string; environment: string; effect: "immediate" | "period_end"; effectiveAt: string | null }
  | { type: "plan_downgraded"; userId: string; fromPlanKey: string; toPlanKey: string; environment: string; effect: "immediate" | "period_end"; effectiveAt: string | null }
  | { type: "payment_succeeded"; userId: string; planKey: string; environment: string; invoiceId?: string | null }
  | { type: "payment_failed"; userId: string; planKey: string; environment: string; invoiceId?: string | null };

export type LifecycleResult = { ok: true; actions: string[] } | { ok: false; error: string };

/**
 * Central business-logic hook for all billing lifecycle events.
 * Add side effects here (feature flags, usage resets, notifications, webhooks to
 * external systems) without touching payment-provider code.
 */
export async function runBillingLifecycle(
  db: SupabaseClient<any, any, any>,
  event: LifecycleEvent,
): Promise<LifecycleResult> {
  const actions: string[] = [];

  switch (event.type) {
    case "subscription_started": {
      await db.from("profiles").update({ plan_key: event.planKey }).eq("id", event.userId);
      actions.push(`profile.plan_key set to ${event.planKey}`);
      break;
    }

    case "subscription_cancelled": {
      actions.push(`subscription will downgrade to free at ${event.effectiveAt ?? "period end"}`);
      break;
    }

    case "subscription_resumed": {
      actions.push(`cancellation reversed; subscription stays on ${event.planKey}`);
      break;
    }

    case "plan_upgraded": {
      if (event.effect === "immediate") {
        await db.from("profiles").update({ plan_key: event.toPlanKey }).eq("id", event.userId);
        actions.push(`immediate upgrade applied: ${event.fromPlanKey} -> ${event.toPlanKey}`);
      } else {
        actions.push(`upgrade scheduled at ${event.effectiveAt ?? "period end"}: ${event.fromPlanKey} -> ${event.toPlanKey}`);
      }
      break;
    }

    case "plan_downgraded": {
      if (event.effect === "immediate") {
        await db.from("profiles").update({ plan_key: event.toPlanKey }).eq("id", event.userId);
        actions.push(`immediate downgrade applied: ${event.fromPlanKey} -> ${event.toPlanKey}`);
      } else {
        actions.push(`downgrade scheduled at ${event.effectiveAt ?? "period end"}: ${event.fromPlanKey} -> ${event.toPlanKey}`);
      }
      break;
    }

    case "payment_succeeded": {
      actions.push(`payment recorded for ${event.planKey}`);
      break;
    }

    case "payment_failed": {
      actions.push(`payment failed for ${event.planKey}; Stripe retries automatically`);
      break;
    }
  }

  return { ok: true, actions };
}
