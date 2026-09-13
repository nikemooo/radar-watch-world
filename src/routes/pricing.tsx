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
          <Link to="/auth">Sign in</Link>
        </Button>
      </header>

      <section className="mx-auto w-full max-w-5xl px-5 py-14">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Pricing</h1>
        <p className="mt-3 max-w-xl text-muted-foreground">
          Every plan runs the same intelligence engine. Higher tiers simply watch more things, more often.
        </p>

        <div className="mt-6">
          <MarketSelect
            markets={markets}
            value={market.code}
            onChange={(code) => void setMarket(code)}
            hint={`Prices shown in ${market.currency}`}
          />
        </div>

        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {(plans ?? []).map((plan, index) => {
            const features = Array.isArray(plan.features) ? (plan.features as string[]) : [];
            const highlighted = index === 1;
            const monthly = priceFor(plan.key, "month");
            const yearly = priceFor(plan.key, "year");
            return (
              <div
                key={plan.key}
                className={`panel flex flex-col p-6 ${highlighted ? "border-primary/50 ring-1 ring-primary/30" : ""}`}
              >
                {highlighted && <span className="mono-label text-primary">Most popular</span>}
                <h2 className="mt-1 text-lg font-medium">{plan.name}</h2>
                <p className="mt-3 font-mono text-3xl">
                  {monthly ? format(monthly.amount_minor, monthly.currency) : "Free"}
                  {monthly && <span className="text-sm text-muted-foreground">/month</span>}
                </p>
                {yearly && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    or {format(yearly.amount_minor, yearly.currency)}/year
                  </p>
                )}

                <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                  <li className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-interesting" />
                    {plan.max_radars} active radars
                  </li>
                  <li className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-interesting" />
                    Checks as often as every {plan.min_check_interval_minutes} min
                  </li>
                  {features.map((feature) => (
                    <li key={feature} className="flex gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-interesting" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Button asChild className="mt-6 w-full" variant={highlighted ? "default" : "outline"}>
                  <Link to="/auth">{plan.price_amount === 0 ? "Start free" : "Get started"}</Link>
                </Button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
