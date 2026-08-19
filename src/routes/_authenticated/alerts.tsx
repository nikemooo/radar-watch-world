import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AlertCard, type AlertRow } from "@/components/alert-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { track } from "@/lib/analytics";

export const Route = createFileRoute("/_authenticated/alerts")({
  // The dashboard metrics deep-link straight into a filtered inbox.
  validateSearch: (search: Record<string, unknown>): { filter?: Filter } => {
    const raw = search["filter"];
    return raw === "new" || raw === "saved" || raw === "critical" || raw === "all"
      ? { filter: raw }
      : {};
  },
  head: () => ({
    meta: [
      { title: "Alerts — Radar" },
      { name: "description", content: "Everything Radar decided was worth your attention." },
      { property: "og:title", content: "Alerts — Radar" },
      { property: "og:description", content: "Everything Radar decided was worth your attention." },
    ],
  }),
  component: Alerts,
});

type Filter = "all" | "new" | "saved" | "critical";

function Alerts() {
  const queryClient = useQueryClient();
  const { filter: initialFilter } = Route.useSearch();
  const [filter, setFilter] = useState<Filter>(initialFilter ?? "all");


  const { data, isLoading } = useQuery({
    queryKey: ["alerts", filter],
    queryFn: async () => {
      let query = supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(100);
      if (filter === "new") query = query.eq("status", "new");
      if (filter === "saved") query = query.eq("status", "saved");
      if (filter === "critical") query = query.in("importance", ["critical", "important"]);
      const [alerts, radars] = await Promise.all([query, supabase.from("radars").select("id, name")]);
      if (alerts.error) throw alerts.error;
      return {
        alerts: (alerts.data ?? []) as AlertRow[],
        radars: new Map((radars.data ?? []).map((r) => [r.id, r.name])),
      };
    },
  });

  const patch = useMutation({
    mutationFn: async ({ id, values }: { id: string; values: { status?: string; feedback?: string } }) => {
      const { error } = await supabase.from("alerts").update(values).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <p className="mono-label">Intelligence inbox</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Alerts</h1>
      </header>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="new">Unread</TabsTrigger>
          <TabsTrigger value="critical">Needs attention</TabsTrigger>
          <TabsTrigger value="saved">Saved</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : data?.alerts.length ? (
        <div className="space-y-3">
          {data.alerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              radarName={alert.radar_id ? data.radars.get(alert.radar_id) : undefined}
              onSave={() => {
                void track("alert_saved");
                patch.mutate({
                  id: alert.id,
                  values: { status: alert.status === "saved" ? "read" : "saved" },
                });
              }}
              onDismiss={() => patch.mutate({ id: alert.id, values: { status: "dismissed" } })}
              onFeedback={(value) => {
                void track("alert_feedback", { value });
                patch.mutate({ id: alert.id, values: { feedback: value } });
              }}
            />
          ))}
        </div>
      ) : (
        <p className="panel p-10 text-center text-sm text-muted-foreground">
          Nothing here. Radar only surfaces changes that matter — silence means nothing changed.
        </p>
      )}
    </div>
  );
}
