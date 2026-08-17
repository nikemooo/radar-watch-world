import { createFileRoute } from "@tanstack/react-router";
import type Stripe from "stripe";
import { createStripeClient, type StripeEnv } from "@/lib/stripe.server";

async function planKeyForPrice(db: any, priceId: string | null | undefined): Promise<string | null> {
  if (!priceId) return null;
  const { data } = await db
    .from("plans")
    .select("key")
    .or(`stripe_price_id.eq.${priceId},stripe_price_id_yearly.eq.${priceId}`)
    .maybeSingle();
  return data?.key ?? null;
}

async function syncSubscription(db: any, sub: Stripe.Subscription, environment: StripeEnv) {
  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? null;
  const planKey = (await planKeyForPrice(db, priceId)) ?? "pro";
  const periodEndUnix = (item as any)?.current_period_end ?? (sub as any).current_period_end ?? null;
  const periodEnd = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null;
  const userId = (sub.metadata?.user_id as string | undefined) ?? null;

  const { data: existing } = await db
    .from("subscriptions")
    .select("id, user_id, pending_plan_key")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();

  const resolvedUserId = existing?.user_id ?? userId;
  if (!resolvedUserId) return;

  const row = {
    user_id: resolvedUserId,
    provider: "stripe",
    environment,
    plan_key: planKey,
    status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end,
    cancel_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
    current_period_end: periodEnd,
    billing_interval: item?.price?.recurring?.interval === "year" ? "year" : "month",
    price_id: priceId,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
    stripe_subscription_id: sub.id,
    ...(existing?.pending_plan_key && existing.pending_plan_key === planKey
      ? { pending_plan_key: null, pending_effective_at: null }
      : {}),
  };

  if (existing) {
    await db.from("subscriptions").update(row).eq("id", existing.id);
  } else {
    await db.from("subscriptions").insert(row);
  }

  const active = ["active", "trialing", "past_due"].includes(sub.status);
  await db
    .from("profiles")
    .update({ plan_key: active ? planKey : "free" })
    .eq("id", resolvedUserId);
}

export const Route = createFileRoute("/api/public/stripe-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const environment: StripeEnv = url.searchParams.get("env") === "live" ? "live" : "sandbox";
        const secret =
          environment === "live"
            ? process.env["PAYMENTS_LIVE_WEBHOOK_SECRET"]
            : process.env["PAYMENTS_SANDBOX_WEBHOOK_SECRET"];
        if (!secret) return new Response("Webhook secret not configured", { status: 500 });

        const signature = request.headers.get("stripe-signature");
        if (!signature) return new Response("Missing signature", { status: 401 });
        const body = await request.text();

        const stripe = createStripeClient(environment);
        let event: Stripe.Event;
        try {
          event = await stripe.webhooks.constructEventAsync(body, signature, secret);
        } catch {
          return new Response("Invalid signature", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        try {
          switch (event.type) {
            case "checkout.session.completed": {
              const session = event.data.object as Stripe.Checkout.Session;
              const userId = session.client_reference_id ?? (session.metadata?.user_id as string | undefined);
              const subscriptionId =
                typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
              if (userId && subscriptionId) {
                const sub = await stripe.subscriptions.retrieve(subscriptionId);
                if (!sub.metadata?.user_id) {
                  await stripe.subscriptions.update(subscriptionId, {
                    metadata: { ...sub.metadata, user_id: userId, plan_key: session.metadata?.plan_key ?? "" },
                  });
                  (sub.metadata as Record<string, string>).user_id = userId;
                }
                await syncSubscription(supabaseAdmin, sub, environment);
              }
              break;
            }
            case "customer.subscription.created":
            case "customer.subscription.updated":
            case "customer.subscription.deleted": {
              await syncSubscription(supabaseAdmin, event.data.object as Stripe.Subscription, environment);
              break;
            }
            case "invoice.paid":
            case "invoice.payment_failed": {
              const invoice = event.data.object as Stripe.Invoice;
              const subId =
                typeof (invoice as any).subscription === "string"
                  ? (invoice as any).subscription
                  : (invoice as any).subscription?.id;
              if (subId) {
                const sub = await stripe.subscriptions.retrieve(subId);
                await syncSubscription(supabaseAdmin, sub, environment);
              }
              break;
            }
            default:
              break;
          }
        } catch (error) {
          console.error("stripe webhook handling failed", event.type, error);
          return new Response("Handler error", { status: 500 });
        }

        return new Response("ok");
      },
    },
  },
});
