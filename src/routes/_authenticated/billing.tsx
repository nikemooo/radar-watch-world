import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/billing")({
  head: () => ({
    meta: [
      { title: "Billing — Radar" },
      { name: "description", content: "Your Radar plan, limits and upgrade options." },
      { property: "og:title", content: "Billing — Radar" },
      { property: "og:description", content: "Your Radar plan, limits and upgrade options." },
    ],
  }),
  component: Billing,
});

function Billing() {
  const { data, isLoading } = useQuery({
    queryKey: ["billing"],
    queryFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      const [plans, profile, radars] = await Promise.all([
        supabase.from("plans").select("*").eq("active", true).order("sort_order"),
        userData.user
          ? supabase.from("profiles").select("plan_key").eq("id", userData.user.id).maybeSingle()
          : Promise.resolve({ data: null }),
        supabase.from("radars").select("id", { count: "exact", head: true }),
      ]);
      return {
        plans: plans.data ?? [],
        planKey: profile.data?.plan_key ?? "free",
        radarCount: radars.count ?? 0,
      };
    },
  });

  if (isLoading) return <Skeleton className="h-72" />;

  const current = data?.plans.find((p) => p.key === data.planKey);

  return (
    <div className="space-y-6">
      <header>
        <p className="mono-label">Plan and usage</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Billing</h1>
      </header>

      {current && (
        <section className="panel p-5">
          <p className="mono-label">Current plan</p>
          <p className="mt-2 text-xl font-medium">{current.name}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {data?.radarCount} of {current.max_radars} radars used · checks as often as every{" "}
            {current.min_check_interval_minutes} minutes
          </p>
        </section>
      )}

      <div className="grid gap-5 md:grid-cols-3">
        {(data?.plans ?? []).map((plan) => {
          const features = Array.isArray(plan.features) ? (plan.features as string[]) : [];
          const isCurrent = plan.key === data?.planKey;
          return (
            <div
              key={plan.key}
              className={`panel flex flex-col p-5 ${isCurrent ? "border-primary/50 ring-1 ring-primary/30" : ""}`}
            >
              <h2 className="font-medium">{plan.name}</h2>
              <p className="mt-2 font-mono text-2xl">
                {plan.price_amount === 0 ? "Free" : `$${(plan.price_amount / 100).toFixed(0)}`}
                {plan.price_amount > 0 && (
                  <span className="text-sm text-muted-foreground">/{plan.interval}</span>
                )}
              </p>
              <ul className="mt-5 flex-1 space-y-2 text-sm">
                <li className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-interesting" />
                  {plan.max_radars} radars
                </li>
                {features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-interesting" />
                    {feature}
                  </li>
                ))}
              </ul>
              <Button className="mt-5 w-full" variant={isCurrent ? "outline" : "default"} disabled={isCurrent}>
                {isCurrent ? "Current plan" : "Upgrade"}
              </Button>
            </div>
          );
        })}
      </div>

      <p className="text-sm text-muted-foreground">
        Payment processing isn't connected yet — plan changes become live once checkout is enabled.
      </p>
    </div>
  );
}
