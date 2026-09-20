import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { type StripeEnv, createStripeClient, getStripeErrorMessage } from "@/lib/stripe.server";

const ENV: StripeEnv = "sandbox";

type Result<T> = T | { error: string };

/** Plans, current entitlements and subscription state for the billing page. */
export const getBillingState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getEntitlements, remainingAlerts } = await import("@/lib/billing/entitlements.server");
    const e = await getEntitlements(context.supabase, context.userId, ENV);
    const { data: plans } = await context.supabase.from("plans").select("*").eq("active", true).order("sort_order");
    const { resolveBillingMarket } = await import("@/lib/billing/market.server");
    const m = await resolveBillingMarket(context.supabase, context.userId, { environment: ENV });
    return {
      environment: ENV,
      plans: plans ?? [],
      markets: m.markets,
      planPrices: m.prices,
      marketCode: m.market.code,
      marketLocked: m.locked,
      planKey: e.planKey,
      isInternal: e.isInternal,
      radarCount: e.radarCount,
      alertsThisMonth: e.alertsThisMonth,
      alertsRemaining: remainingAlerts(e),
      subscription: e.subscription,
    };
  });

/** Start a Stripe Embedded Checkout session for a paid plan. */
export const createCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: {
    planKey: string;
    interval: "month" | "year";
    returnUrl: string;
    marketCode?: string | null;
    localeHint?: string | null;
    environment: StripeEnv;
  }) => {
    if (!input?.planKey || !input?.returnUrl) throw new Error("Missing plan or return URL.");
    return {
      planKey: input.planKey,
      interval: input.interval === "year" ? "year" : "month",
      returnUrl: input.returnUrl,
      marketCode: typeof input.marketCode === "string" ? input.marketCode.toLowerCase() : null,
      localeHint: typeof input.localeHint === "string" ? input.localeHint : null,
      environment: input.environment === "live" ? "live" : "sandbox",
    } as const;
  })
  .handler(async ({ data, context }): Promise<Result<{ clientSecret: string }>> => {
    const { supabase, userId, claims } = context as { supabase: any; userId: string; claims?: { email?: string } };
    const { data: plan } = await supabase.from("plans").select("key").eq("key", data.planKey).maybeSingle();
    if (!plan) return { error: "Unknown plan." };
    if (data.planKey === "free") return { error: "The Free plan does not require a subscription." };

    const { resolveBillingMarket, resolvePlanPrice, resolveStripePrice } = await import(
      "@/lib/billing/market.server"
    );
    const resolved = await resolveBillingMarket(supabase, userId, {
      requestedCode: data.marketCode,
      localeHint: data.localeHint,
      environment: data.environment,
    });
    const planPrice = await resolvePlanPrice(supabase, data.planKey, resolved.market.code, data.interval);
    if (!planPrice) return { error: `This plan is not available in ${resolved.market.name} yet.` };
    const { data: existing } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id, stripe_subscription_id, status")
      .eq("user_id", userId)
      .eq("environment", data.environment)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(existing.status)) {
      return { error: "You already have an active subscription — use plan change instead." };
    }

    try {
      const stripe = createStripeClient(data.environment);
      const resolvedPrice = await resolveStripePrice(stripe, planPrice);
      if (resolvedPrice.error) return { error: resolvedPrice.error };

      // Launch offer: applied automatically while the coupon secret is configured.
      const foundingCoupon = process.env['STRIPE_FOUNDING_COUPON'];

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: resolvedPrice.priceId, quantity: 1 }],
        ui_mode: "embedded_page",
        return_url: data.returnUrl,
        client_reference_id: userId,
        ...(foundingCoupon ? { discounts: [{ coupon: foundingCoupon }] } : {}),

        ...(existing?.stripe_customer_id
          ? { customer: existing.stripe_customer_id }
          : claims?.email
            ? { customer_email: claims.email }
            : {}),
        subscription_data: {
          metadata: {
            user_id: userId,
            plan_key: data.planKey,
            market_code: resolved.market.code,
            currency: planPrice.currency,
          },
        },
        metadata: {
          user_id: userId,
          plan_key: data.planKey,
          environment: data.environment,
          market_code: resolved.market.code,
          currency: planPrice.currency,
        },
        managed_payments: { enabled: true },
      } as any);

      if (!session.client_secret) return { error: "Stripe did not return a client secret." };
      return { clientSecret: session.client_secret };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

/** Open the Stripe customer portal for payment methods and invoices. */
export const createPortalSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { returnUrl?: string }) => ({ returnUrl: input?.returnUrl }))
  .handler(async ({ data, context }): Promise<Result<{ url: string }>> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .eq("environment", ENV)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!sub?.stripe_customer_id) return { error: "No billing account yet — subscribe first." };
    try {
      const stripe = createStripeClient(ENV);
      const portal = await stripe.billingPortal.sessions.create({
        customer: sub.stripe_customer_id,
        ...(data.returnUrl ? { return_url: data.returnUrl } : {}),
      });
      return { url: portal.url };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

/**
 * Change plan on an existing subscription.
 * Upgrades apply immediately with prorated billing; downgrades are scheduled
 * for the end of the current billing period, so access is kept until then.
 */
export const changePlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { planKey: string; interval: "month" | "year" }) => {
    if (!input?.planKey) throw new Error("Missing plan.");
    return { planKey: input.planKey, interval: input.interval === "year" ? "year" : "month" } as const;
  })
  .handler(async ({ data, context }): Promise<Result<{ effect: "immediate" | "period_end"; effectiveAt: string | null; planKey: string }>> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { isUpgrade } = await import("@/lib/billing/plans");
    const { getEntitlements } = await import("@/lib/billing/entitlements.server");
    const { runBillingLifecycle } = await import("@/lib/billing/lifecycle.server");

    const e = await getEntitlements(supabase, userId, ENV);
    const subId = e.subscription?.stripe_subscription_id;
    if (!subId) return { error: "No active subscription to change." };
    if (data.planKey === e.planKey && data.interval === e.subscription?.billing_interval) {
      return { error: "You are already on this plan." };
    }

    const { data: plan } = await supabase.from("plans").select("key").eq("key", data.planKey).maybeSingle();
    if (!plan) return { error: "Unknown plan." };

    const { resolveBillingMarket, resolvePlanPrice, resolveStripePrice } = await import("@/lib/billing/market.server");
    const resolved = await resolveBillingMarket(supabase, userId, { environment: ENV });
    const planPrice =
      data.planKey === "free" ? null : await resolvePlanPrice(supabase, data.planKey, resolved.market.code, data.interval);
    if (data.planKey !== "free" && !planPrice) {
      return { error: `This plan is not available in ${resolved.market.name} yet.` };
    }
    try {
      const stripe = createStripeClient(ENV);
      const sub = await stripe.subscriptions.retrieve(subId);
      const item = sub.items.data[0];
      if (!item) return { error: "Subscription has no billable item." };
      const periodEnd = (sub as any).current_period_end ?? null;
      const periodEndIso = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;

      // Downgrade to Free = cancel at period end.
      if (data.planKey === "free") {
        await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
        await supabase
          .from("subscriptions")
          .update({ cancel_at_period_end: true, pending_plan_key: "free", pending_effective_at: periodEndIso })
          .eq("stripe_subscription_id", subId);
        await runBillingLifecycle(supabase, {
          type: "subscription_cancelled",
          userId,
          planKey: e.planKey,
          environment: ENV,
          effectiveAt: periodEndIso,
        });
        return { effect: "period_end", effectiveAt: periodEndIso, planKey: "free" };
      }

      const resolvedNewPrice = planPrice ? await resolveStripePrice(stripe, planPrice) : null;
      if (resolvedNewPrice?.error) return { error: resolvedNewPrice.error };
      const newPriceId = resolvedNewPrice?.priceId ?? null;
      if (!newPriceId) return { error: "This plan is not purchasable." };

      if (isUpgrade(e.planKey, data.planKey)) {
        // Immediate switch, charge only the prorated difference.
        await stripe.subscriptions.update(subId, {
          items: [{ id: item.id, price: newPriceId }],
          proration_behavior: "always_invoice",
          cancel_at_period_end: false,
          metadata: { user_id: userId, plan_key: data.planKey },
        });
        await supabase
          .from("subscriptions")
          .update({
            plan_key: data.planKey,
            price_id: newPriceId,
            billing_interval: data.interval,
            cancel_at_period_end: false,
            pending_plan_key: null,
            pending_effective_at: null,
          })
          .eq("stripe_subscription_id", subId);
        await supabase.from("profiles").update({ plan_key: data.planKey }).eq("id", userId);
        await runBillingLifecycle(supabase, {
          type: "plan_upgraded",
          userId,
          fromPlanKey: e.planKey,
          toPlanKey: data.planKey,
          environment: ENV,
          effect: "immediate",
          effectiveAt: new Date().toISOString(),
        });
        return { effect: "immediate", effectiveAt: new Date().toISOString(), planKey: data.planKey };
      }

      // Downgrade between paid plans: schedule the new price for the next period.
      let scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id;
      if (!scheduleId) {
        const created = await stripe.subscriptionSchedules.create({ from_subscription: subId });
        scheduleId = created.id;
      }
      const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
      const currentPhase = schedule.phases[schedule.phases.length - 1];
      if (!currentPhase) return { error: "Subscription schedule has no active phase." };
      await stripe.subscriptionSchedules.update(scheduleId, {
        end_behavior: "release",
        phases: [
          {
            items: [{ price: (item.price.id as string), quantity: 1 }],
            start_date: currentPhase.start_date,
            end_date: currentPhase.end_date,
          },
          { items: [{ price: newPriceId, quantity: 1 }], iterations: 1 },
        ],
        proration_behavior: "none",
      } as any);
      await supabase
        .from("subscriptions")
        .update({ pending_plan_key: data.planKey, pending_effective_at: periodEndIso })
        .eq("stripe_subscription_id", subId);
      await runBillingLifecycle(supabase, {
        type: "plan_downgraded",
        userId,
        fromPlanKey: e.planKey,
        toPlanKey: data.planKey,
        environment: ENV,
        effect: "period_end",
        effectiveAt: periodEndIso,
      });
      return { effect: "period_end", effectiveAt: periodEndIso, planKey: data.planKey };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

/** Cancel at the end of the current billing period (access is kept until then). */
export const cancelSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Result<{ effectiveAt: string | null }>> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { getEntitlements } = await import("@/lib/billing/entitlements.server");
    const { runBillingLifecycle } = await import("@/lib/billing/lifecycle.server");
    const e = await getEntitlements(supabase, userId, ENV);

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_subscription_id, current_period_end")
      .eq("user_id", userId)
      .eq("environment", ENV)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!sub?.stripe_subscription_id) return { error: "No active subscription." };
    try {
      const stripe = createStripeClient(ENV);
      await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
      await supabase
        .from("subscriptions")
        .update({ cancel_at_period_end: true, pending_plan_key: "free", pending_effective_at: sub.current_period_end })
        .eq("stripe_subscription_id", sub.stripe_subscription_id);
      await runBillingLifecycle(supabase, {
        type: "subscription_cancelled",
        userId,
        planKey: e.planKey,
        environment: ENV,
        effectiveAt: sub.current_period_end,
      });
      return { effectiveAt: sub.current_period_end };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

/** Undo a scheduled cancellation before the period ends. */
export const resumeSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Result<{ ok: true }>> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { getEntitlements } = await import("@/lib/billing/entitlements.server");
    const { runBillingLifecycle } = await import("@/lib/billing/lifecycle.server");
    const e = await getEntitlements(supabase, userId, ENV);

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_subscription_id")
      .eq("user_id", userId)
      .eq("environment", ENV)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!sub?.stripe_subscription_id) return { error: "No subscription to resume." };
    try {
      const stripe = createStripeClient(ENV);
      await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: false });
      await supabase
        .from("subscriptions")
        .update({ cancel_at_period_end: false, pending_plan_key: null, pending_effective_at: null })
        .eq("stripe_subscription_id", sub.stripe_subscription_id);
      await runBillingLifecycle(supabase, {
        type: "subscription_resumed",
        userId,
        planKey: e.planKey,
        environment: ENV,
      });
      return { ok: true };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });
