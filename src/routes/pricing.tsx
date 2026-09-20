import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/radar-mark";
import { MarketSelect } from "@/components/market-select";
import { useMarketPricing } from "@/hooks/use-market";
import { useT } from "@/lib/i18n";
import { planFeatures, type PlanShape } from "@/lib/billing/plan-features";


export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — Radar Intelligence" },
      {
        name: "description",
        content: "Simple plans for continuous personal monitoring. Start free, upgrade for faster checks and more radars.",
      },
      { property: "og:title", content: "Pricing — Radar Intelligence" },
      { property: "og:description", content: "Start free. Upgrade for faster checks and more radars." },
    ],
  }),
  component: Pricing,
});

function Pricing() {
  const t = useT();
  const { markets, market, setMarket, priceFor, format } = useMarketPricing();
  const { data: plans } = useQuery({
    queryKey: ["plans"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("plans")
        .select("*")
        .eq("active", true)
        .order("sort_order");
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5">
        <Link to="/">
          <Wordmark />
        </Link>
        <Button asChild size="sm">
          <Link to="/auth">{t("pricing.signIn")}</Link>
        </Button>
      </header>

      <section className="mx-auto w-full max-w-5xl px-5 py-14">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("pricing.title")}</h1>
        <p className="mt-3 max-w-xl text-muted-foreground">{t("pricing.intro")}</p>

        <div className="mt-6">
          <MarketSelect
            markets={markets}
            value={market.code}
            onChange={(code) => void setMarket(code)}
            hint={t("billing.pricesIn", { currency: market.currency })}
          />
        </div>

        <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-5">
          {(plans ?? []).map((plan) => {
            const features = planFeatures(plan as unknown as PlanShape, t);
            const highlighted = plan.key === "plus";
            const monthly = priceFor(plan.key, "month");
            const yearly = priceFor(plan.key, "year");
            return (
              <div
                key={plan.key}
                className={`panel flex flex-col p-6 ${highlighted ? "border-primary/50 ring-1 ring-primary/30" : ""}`}
              >
                {highlighted && <span className="mono-label text-primary">{t("pricing.popular")}</span>}
                <h2 className="mt-1 text-lg font-medium">{plan.name}</h2>
                <p className="mt-3 font-mono text-3xl">
                  {monthly ? format(monthly.amount_minor, monthly.currency) : t("billing.free")}
                  {monthly && <span className="text-sm text-muted-foreground">{t("pricing.perMonth")}</span>}
                </p>
                {yearly && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("pricing.orYear", { price: format(yearly.amount_minor, yearly.currency) })}
                  </p>
                )}

                <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                  {features.map((feature) => (
                    <li key={feature} className="flex gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-interesting" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Button asChild className="mt-6 w-full" variant={highlighted ? "default" : "outline"}>
                  <Link to="/auth">
                    {plan.price_amount === 0 ? t("pricing.startFree") : t("pricing.getStarted")}
                  </Link>
                </Button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

