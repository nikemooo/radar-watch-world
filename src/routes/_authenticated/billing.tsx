import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  cancelSubscription,
  changePlan,
  createPortalSession,
  getBillingState,
  resumeSubscription,
} from "@/utils/payments.functions";
import { PLAN_RANK, type PlanRow } from "@/lib/billing/plans";
import { formatSweepInterval, planFeatures } from "@/lib/billing/plan-features";
import { MarketSelect } from "@/components/market-select";
import { useMarketPricing } from "@/hooks/use-market";
import { useStripeCheckout } from "@/hooks/useStripeCheckout";
import { useI18n, type TranslationKey } from "@/lib/i18n";


export const Route = createFileRoute("/_authenticated/billing")({
  head: () => ({
    meta: [
      { title: "Billing — Radar" },
      { name: "description", content: "Your Radar plan, limits, invoices and upgrade options." },
      { property: "og:title", content: "Billing — Radar" },
      { property: "og:description", content: "Your Radar plan, limits, invoices and upgrade options." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Billing,
});

function Billing() {
  const queryClient = useQueryClient();
  const { t, locale } = useI18n();
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [busy, setBusy] = useState<string | null>(null);

  const asDate = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleDateString(locale) : t("billing.periodEndFallback");


  const fetchState = useServerFn(getBillingState);
  const portal = useServerFn(createPortalSession);
  const change = useServerFn(changePlan);
  const cancel = useServerFn(cancelSubscription);
  const resume = useServerFn(resumeSubscription);

  const { openCheckout, closeCheckout, isOpen: checkoutOpen, checkoutElement } = useStripeCheckout();

  const { data, isLoading } = useQuery({ queryKey: ["billing"], queryFn: () => fetchState({}) });
  const { markets, market, setMarket, priceFor, format } = useMarketPricing({
    billingCurrency: (data as { subscription?: { currency?: string | null } } | undefined)?.subscription?.currency ?? null,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["billing"] });

  const unwrap = <T,>(result: T | { error: string }): T => {
    if (result && typeof result === "object" && "error" in (result as Record<string, unknown>)) {
      throw new Error((result as { error: string }).error);
    }
    return result as T;
  };

  const startCheckout = (planKey: string) => {
    openCheckout({
      planKey,
      interval,
      returnUrl: `${window.location.origin}/checkout/return`,
      marketCode: market.code,
      localeHint: navigator.language,
      onError: (message) => {
        toast.error(message);
        closeCheckout();
      },
    });
  };

  const switchPlan = async (planKey: string) => {
    setBusy(planKey);
    try {
      const result = unwrap(await change({ data: { planKey, interval } }));
      toast.success(
        result.effect === "immediate"
          ? t("billing.toast.upgraded")
          : t("billing.toast.scheduled", { date: asDate(result.effectiveAt) }),
      );
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("billing.toast.changeFailed"));
    } finally {
      setBusy(null);
    }
  };

  const openPortal = async () => {
    setBusy("portal");
    try {
      const result = unwrap(await portal({ data: { returnUrl: `${window.location.origin}/billing` } }));
      window.open(result.url, "_blank");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("billing.toast.portalFailed"));
    } finally {
      setBusy(null);
    }
  };

  const doCancel = async () => {
    setBusy("cancel");
    try {
      const result = unwrap(await cancel({}));
      toast.success(t("billing.toast.cancelScheduled", { date: asDate(result.effectiveAt) }));
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("billing.toast.cancelFailed"));
    } finally {
      setBusy(null);
    }
  };

  const doResume = async () => {
    setBusy("resume");
    try {
      unwrap(await resume({}));
      toast.success(t("billing.toast.resumed"));
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("billing.toast.resumeFailed"));
    } finally {
      setBusy(null);
    }
  };


  if (isLoading || !data) return <Skeleton className="h-72" />;

  const plans = (data.plans ?? []) as unknown as PlanRow[];
  const current = plans.find((p) => p.key === data.planKey);
  const sub = data.subscription;
  const marketLocked = Boolean((data as { marketLocked?: boolean }).marketLocked);
  const lockedCode = (data as { marketCode?: string }).marketCode ?? market.code;

  return (
    <div className="space-y-6">
      <header>
        <p className="mono-label">Plan and usage</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Billing</h1>
      </header>

      {current && (
        <section className="panel space-y-3 p-5">
          <p className="mono-label">Current plan</p>
          <p className="text-xl font-medium">
            {current.name}
            {data.isInternal && <span className="ml-2 text-xs text-muted-foreground">internal test account</span>}
          </p>
          <p className="text-sm text-muted-foreground">
            {sub
              ? `Status: ${sub.status.replace("_", " ")} · billed ${sub.billing_interval === "year" ? "yearly" : "monthly"}${
                  sub.cancel_at_period_end ? " · cancels at period end" : ""
                }`
              : `Status: free plan · ${format(0, market.currency)}/mo · no payment method needed`}
          </p>
          <p className="text-sm text-muted-foreground">
            {data.radarCount} of {current.max_radars} radars used · sweeps as often as every{" "}
            {current.min_check_interval_minutes} minutes ·{" "}
            {current.max_alerts_per_month === null
              ? "unlimited alerts"
              : `${data.alertsThisMonth}/${current.max_alerts_per_month} alerts this month`}{" "}
            · {current.history_days}-day history
          </p>
          {sub?.pending_plan_key && (
            <p className="text-sm text-important">
              Scheduled change to {plans.find((p) => p.key === sub.pending_plan_key)?.name ?? sub.pending_plan_key} on{" "}
              {sub.pending_effective_at ? new Date(sub.pending_effective_at).toLocaleDateString() : "period end"}.
            </p>
          )}
          {sub?.current_period_end && !sub.pending_plan_key && (
            <p className="text-sm text-muted-foreground">
              {sub.cancel_at_period_end ? "Access ends" : "Next billing date"}:{" "}
              {new Date(sub.current_period_end).toLocaleDateString()}.
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {sub?.stripe_customer_id && (
              <Button variant="outline" size="sm" onClick={openPortal} disabled={busy === "portal"}>
                {busy === "portal" ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ExternalLink className="mr-2 size-4" />}
                Manage payment & invoices
              </Button>
            )}
            {sub?.stripe_subscription_id && !sub.cancel_at_period_end && (
              <Button variant="ghost" size="sm" onClick={doCancel} disabled={busy === "cancel"}>
                Cancel at period end
              </Button>
            )}
            {sub?.cancel_at_period_end && (
              <Button variant="outline" size="sm" onClick={doResume} disabled={busy === "resume"}>
                Resume subscription
              </Button>
            )}
          </div>
        </section>
      )}

      <div className="space-y-3">
        <MarketSelect
          markets={markets}
          value={marketLocked ? lockedCode : market.code}
          onChange={(code) => void setMarket(code)}
          disabled={marketLocked}
          hint={
            marketLocked
              ? "Billing currency is locked to your active subscription."
              : `Prices shown in ${market.currency}`
          }
        />
      </div>

      <div className="flex items-center gap-2">
        <Button variant={interval === "month" ? "default" : "outline"} size="sm" onClick={() => setInterval("month")}>
          Monthly
        </Button>
        <Button variant={interval === "year" ? "default" : "outline"} size="sm" onClick={() => setInterval("year")}>
          Yearly (2 months free)
        </Button>
      </div>

      {checkoutOpen && (
        <section className="panel space-y-3 p-5">
          <div className="flex items-center justify-between">
            <p className="mono-label">Checkout</p>
            <Button variant="ghost" size="sm" onClick={closeCheckout}>
              <X className="size-4" />
              Close
            </Button>
          </div>
          {checkoutElement}
        </section>
      )}

      <div className="grid gap-5 md:grid-cols-3">
        {plans.map((plan) => {
          const features = Array.isArray(plan.features) ? (plan.features as string[]) : [];
          const isCurrent = plan.key === data.planKey;
          const price = priceFor(plan.key, interval);
          const upgrade = (PLAN_RANK[plan.key] ?? 0) > (PLAN_RANK[data.planKey] ?? 0);
          const label = isCurrent
            ? "Current plan"
            : plan.key === "free"
              ? "Downgrade at period end"
              : upgrade
                ? "Upgrade now"
                : "Downgrade at period end";
          const onClick = () =>
            sub?.stripe_subscription_id ? switchPlan(plan.key) : startCheckout(plan.key);

          return (
            <div
              key={plan.key}
              className={`panel flex flex-col p-5 ${isCurrent ? "border-primary/50 ring-1 ring-primary/30" : ""}`}
            >
              <h2 className="font-medium">{plan.name}</h2>
              <p className="mt-2 font-mono text-2xl">
                {price ? format(price.amount_minor, price.currency) : "Free"}
                {price && (
                  <span className="text-sm text-muted-foreground">/{interval === "year" ? "yr" : "mo"}</span>
                )}
              </p>
              <ul className="mt-5 flex-1 space-y-2 text-sm">
                {features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-interesting" />
                    {feature}
                  </li>
                ))}
              </ul>
              <Button
                className="mt-5 w-full"
                variant={isCurrent ? "outline" : upgrade ? "default" : "secondary"}
                disabled={isCurrent || busy === plan.key || (plan.key === "free" && !sub?.stripe_subscription_id) || checkoutOpen}
                onClick={onClick}
              >
                {busy === plan.key && <Loader2 className="mr-2 size-4 animate-spin" />}
                {label}
              </Button>
            </div>
          );
        })}
      </div>

      <p className="text-sm text-muted-foreground">
        Payments run in test mode. Upgrades apply immediately and are prorated; cancellations and downgrades take
        effect at the end of the current billing period.
      </p>
    </div>
  );
}
