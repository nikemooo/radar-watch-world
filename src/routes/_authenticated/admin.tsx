import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsAdmin } from "@/components/app-shell";
import { getSearchOpsMetrics } from "@/lib/radar.functions";


export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Admin — Radar" },
      { name: "description", content: "Platform health, monitoring volume and product analytics." },
      { property: "og:title", content: "Admin — Radar" },
      { property: "og:description", content: "Platform health and product analytics." },
    ],
  }),
  component: Admin,
});

function Admin() {
  const { data: isAdmin, isLoading: checking } = useIsAdmin();
  const searchOps = useServerFn(getSearchOpsMetrics);

  const { data: ops } = useQuery({
    queryKey: ["search-ops"],
    enabled: isAdmin === true,
    queryFn: () => searchOps({}),
  });



  const { data, isLoading } = useQuery({
    queryKey: ["admin-metrics"],
    enabled: isAdmin === true,
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 864e5).toISOString();
      const [radars, alerts, runs, events] = await Promise.all([
        supabase.from("radars").select("id", { count: "exact", head: true }),
        supabase.from("alerts").select("id", { count: "exact", head: true }),
        supabase
          .from("monitor_runs")
          .select("id, status, cost_estimate, started_at")
          .gte("started_at", since),
        supabase
          .from("analytics_events")
          .select("event, created_at")
          .gte("created_at", since)
          .limit(500),
      ]);
      const runRows = runs.data ?? [];
      const counts = new Map<string, number>();
      for (const row of events.data ?? []) counts.set(row.event, (counts.get(row.event) ?? 0) + 1);
      return {
        radars: radars.count ?? 0,
        alerts: alerts.count ?? 0,
        runs: runRows.length,
        errors: runRows.filter((r) => r.status === "error").length,
        cost: runRows.reduce((sum, r) => sum + Number(r.cost_estimate ?? 0), 0),
        events: [...counts.entries()].sort((a, b) => b[1] - a[1]),
      };
    },
  });

  if (checking) return <Skeleton className="h-48" />;
  if (!isAdmin) {
    return (
      <p className="panel p-10 text-center text-sm text-muted-foreground">
        You don't have access to this area.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="mono-label">Operations</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Admin</h1>
      </header>

      {isLoading ? (
        <Skeleton className="h-48" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Radars (visible)" value={String(data?.radars ?? 0)} />
            <Metric label="Alerts (visible)" value={String(data?.alerts ?? 0)} />
            <Metric label="Sweeps · 7d" value={String(data?.runs ?? 0)} />
            <Metric label="Failed sweeps · 7d" value={String(data?.errors ?? 0)} />
          </div>

          <section className="panel p-5">
            <p className="mono-label">Research providers</p>
            <ul className="mt-3 space-y-2 text-sm">
              {(ops?.providers ?? []).map((p) => (
                <li key={p.id} className="flex items-center justify-between border-b border-border py-1.5 last:border-0">
                  <span>
                    {p.label}
                    {p.primary && <span className="ml-2 mono-label">primary</span>}
                  </span>
                  <span
                    className={
                      p.configured
                        ? "font-mono text-xs text-[hsl(var(--interesting,190_90%_45%))]"
                        : "font-mono text-xs text-muted-foreground"
                    }
                  >
                    {p.configured ? "key configured" : "key missing"}
                  </span>
                </li>
              ))}
              {!ops && <li className="text-muted-foreground">Loading provider status…</li>}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              API keys are stored server-side only and are never sent to the browser.
            </p>
          </section>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Search requests · 7d" value={String(ops?.requests ?? 0)} />
            <Metric label="Successful requests" value={String(ops?.successes ?? 0)} />
            <Metric label="Failed requests" value={String(ops?.failures ?? 0)} />
            <Metric label="Sources retrieved" value={String(ops?.sources ?? 0)} />
          </div>

          <section className="panel grid gap-4 p-5 sm:grid-cols-3">
            <div>
              <p className="mono-label">Estimated search cost · 7d</p>
              <p className="mt-2 font-mono text-2xl">${(ops?.costEstimate ?? 0).toFixed(3)}</p>
            </div>
            <div>
              <p className="mono-label">Last successful sweep</p>
              <p className="mt-2 font-mono text-sm">
                {ops?.lastSuccessAt ? new Date(ops.lastSuccessAt).toLocaleString() : "—"}
              </p>
            </div>
            <div>
              <p className="mono-label">Last failed sweep</p>
              <p className="mt-2 font-mono text-sm">
                {ops?.lastFailureAt ? new Date(ops.lastFailureAt).toLocaleString() : "—"}
              </p>
              {ops?.lastFailureError && (
                <p className="mt-1 text-xs text-muted-foreground">{ops.lastFailureError}</p>
              )}
            </div>
          </section>

          <section className="panel p-5">
            <p className="mono-label">Estimated research cost · 7d</p>
            <p className="mt-2 font-mono text-2xl">${(data?.cost ?? 0).toFixed(2)}</p>
          </section>


          <section className="panel p-5">
            <p className="mono-label">Product events · 7d</p>
            <ul className="mt-3 space-y-1.5 text-sm">
              {(data?.events ?? []).map(([event, count]) => (
                <li key={event} className="flex justify-between border-b border-border py-1.5 last:border-0">
                  <span>{event}</span>
                  <span className="font-mono text-muted-foreground">{count}</span>
                </li>
              ))}
              {!data?.events.length && <li className="text-muted-foreground">No events recorded yet.</li>}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel p-4">
      <p className="mono-label">{label}</p>
      <p className="mt-2 font-mono text-2xl">{value}</p>
    </div>
  );
}
