import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bell, Plus, Radar as RadarIcon, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AlertCard, type AlertRow } from "@/components/alert-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RadarMark } from "@/components/radar-mark";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — Radar" },
      { name: "description", content: "Your live monitoring overview and latest intelligence." },
      { property: "og:title", content: "Dashboard — Radar" },
      { property: "og:description", content: "Your live monitoring overview and latest intelligence." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 864e5).toISOString();
      const [radars, alerts, weekAlerts, runs] = await Promise.all([
        supabase.from("radars").select("id, name, status, last_run_at, category").order("created_at", { ascending: false }),
        supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(8),
        supabase.from("alerts").select("id, importance").gte("created_at", since),
        supabase.from("monitor_runs").select("id, status, items_found, started_at").order("started_at", { ascending: false }).limit(1),
      ]);
      return {
        radars: radars.data ?? [],
        alerts: (alerts.data ?? []) as AlertRow[],
        weekAlerts: weekAlerts.data ?? [],
        lastRun: runs.data?.[0] ?? null,
      };
    },
  });

  const radarNames = new Map((data?.radars ?? []).map((r) => [r.id, r.name]));
  const activeRadars = (data?.radars ?? []).filter((r) => r.status === "active").length;
  const critical = (data?.weekAlerts ?? []).filter(
    (a) => a.importance === "critical" || a.importance === "important",
  ).length;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-56" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const empty = (data?.radars.length ?? 0) === 0;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mono-label">Situation overview</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Dashboard</h1>
        </div>
        <Button asChild className="gap-2">
          <Link to="/radars/new">
            <Plus className="size-4" />
            New radar
          </Link>
        </Button>
      </header>

      {empty ? (
        <div className="panel flex flex-col items-center px-6 py-16 text-center">
          <RadarMark className="size-14" />
          <h2 className="mt-6 text-lg font-medium">Nothing on your radar yet</h2>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Describe anything you want watched — a car, a stock, a job market, a price. Radar handles
            the rest.
          </p>
          <Button asChild className="mt-6">
            <Link to="/radars/new">Create your first radar</Link>
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat icon={RadarIcon} label="Active radars" value={String(activeRadars)} />
            <Stat icon={Bell} label="Alerts this week" value={String(data?.weekAlerts.length ?? 0)} />
            <Stat icon={Sparkles} label="Needs attention" value={String(critical)} />
          </div>

          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">Latest intelligence</h2>
              <Button asChild variant="ghost" size="sm">
                <Link to="/alerts">View all</Link>
              </Button>
            </div>
            {data?.alerts.length ? (
              <div className="mt-4 space-y-3">
                {data.alerts.map((alert) => (
                  <AlertCard
                    key={alert.id}
                    alert={alert}
                    radarName={alert.radar_id ? radarNames.get(alert.radar_id) : undefined}
                  />
                ))}
              </div>
            ) : (
              <div className="panel mt-4 flex items-center gap-3 p-5 text-sm text-muted-foreground">
                <Activity className="size-4" />
                No alerts yet. Radar is watching — you'll be told the moment something meaningful changes.
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bell;
  label: string;
  value: string;
}) {
  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" />
        <span className="mono-label">{label}</span>
      </div>
      <p className="mt-3 font-mono text-3xl">{value}</p>
    </div>
  );
}
