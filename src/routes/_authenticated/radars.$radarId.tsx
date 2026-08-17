import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Loader2, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { runRadarNow } from "@/lib/radar.functions";
import { AlertCard, type AlertRow } from "@/components/alert-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { asConfig, frequencyLabel, type RadarFrequency } from "@/lib/radar-types";
import { track } from "@/lib/analytics";

export const Route = createFileRoute("/_authenticated/radars/$radarId")({
  head: () => ({
    meta: [
      { title: "Radar detail — Radar" },
      { name: "description", content: "What this radar is watching, and everything it has found." },
      { property: "og:title", content: "Radar detail — Radar" },
      { property: "og:description", content: "What this radar is watching and what it found." },
    ],
  }),
  component: RadarDetail,
});

function RadarDetail() {
  const { radarId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const run = useServerFn(runRadarNow);

  const { data, isLoading } = useQuery({
    queryKey: ["radar", radarId],
    queryFn: async () => {
      const [radar, alerts, runs] = await Promise.all([
        supabase.from("radars").select("*").eq("id", radarId).maybeSingle(),
        supabase
          .from("alerts")
          .select("*")
          .eq("radar_id", radarId)
          .order("created_at", { ascending: false })
          .limit(50),
        supabase
          .from("monitor_runs")
          .select("*")
          .eq("radar_id", radarId)
          .order("started_at", { ascending: false })
          .limit(5),
      ]);
      if (radar.error) throw radar.error;
      return {
        radar: radar.data,
        alerts: (alerts.data ?? []) as AlertRow[],
        runs: runs.data ?? [],
      };
    },
  });

  const sweep = useMutation({
    mutationFn: async () => run({ data: { radarId } }),
    onSuccess: (result) => {
      const created = (result as { alertsCreated?: number })?.alertsCreated ?? 0;
      toast.success(created > 0 ? `${created} new alert${created > 1 ? "s" : ""}.` : "Sweep complete — nothing new.");
      queryClient.invalidateQueries({ queryKey: ["radar", radarId] });
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const update = useMutation({
    mutationFn: async (patch: { status?: string; frequency?: string }) => {
      const { error } = await supabase.from("radars").update(patch).eq("id", radarId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["radar", radarId] }),
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("radars").delete().eq("id", radarId);
      if (error) throw error;
    },
    onSuccess: async () => {
      await track("radar_deleted");
      queryClient.invalidateQueries({ queryKey: ["radars"] });
      navigate({ to: "/radars" });
    },
  });

  if (isLoading) return <Skeleton className="h-72" />;
  if (!data?.radar) {
    return (
      <div className="panel p-10 text-center text-sm text-muted-foreground">
        This radar no longer exists.
      </div>
    );
  }

  const radar = data.radar;
  const config = asConfig(radar.config);

  return (
    <div className="space-y-7">
      <Link to="/radars" className="mono-label inline-flex items-center gap-1.5 hover:text-foreground">
        <ArrowLeft className="size-3" />
        All radars
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{radar.name}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {config.interpretation || radar.raw_request}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={radar.frequency}
            onValueChange={(frequency) => update.mutate({ frequency })}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(frequencyLabel) as RadarFrequency[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {frequencyLabel[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            aria-label={radar.status === "active" ? "Pause radar" : "Resume radar"}
            onClick={() => update.mutate({ status: radar.status === "active" ? "paused" : "active" })}
          >
            {radar.status === "active" ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Delete radar"
            onClick={() => remove.mutate()}
          >
            <Trash2 className="size-4" />
          </Button>
          <Button className="gap-2" onClick={() => sweep.mutate()} disabled={sweep.isPending}>
            {sweep.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            {sweep.isPending ? "Sweeping…" : "Run now"}
          </Button>
        </div>
      </header>

      <section className="panel grid gap-5 p-5 sm:grid-cols-2">
        <Facts title="Watching for" items={config.monitored_events} />
        <Facts title="Matters most" items={config.important_criteria} />
        <Facts title="Search strategy" items={config.search_queries} />
        <Facts title="Excluding" items={config.exclusions} />
      </section>

      {data.runs.length > 0 && (
        <section>
          <h2 className="mono-label">Recent sweeps</h2>
          <div className="panel mt-3 divide-y divide-border">
            {data.runs.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span className="mono-label">{new Date(entry.started_at).toLocaleString()}</span>
                <span className={entry.status === "error" ? "text-critical" : "text-muted-foreground"}>
                  {entry.status}
                </span>
                <span className="ml-auto text-muted-foreground">
                  {entry.items_found} found · {entry.new_items} new · {entry.alerts_created} alerts
                </span>
                {entry.error && <p className="w-full text-xs text-critical">{entry.error}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-lg font-medium">Findings</h2>
        {data.alerts.length ? (
          <div className="mt-4 space-y-3">
            {data.alerts.map((alert) => (
              <AlertCard key={alert.id} alert={alert} />
            ))}
          </div>
        ) : (
          <p className="panel mt-4 p-5 text-sm text-muted-foreground">
            Nothing found yet. Run a sweep to check right now.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium">Retrieved sources</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every source Radar read during its sweeps. Alerts may only cite these.
        </p>
        {sources?.length ? (
          <ul className="panel mt-4 divide-y divide-border">
            {sources.map((s) => (
              <li key={s.id} className="p-4">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-sm font-medium underline underline-offset-4"
                >
                  {s.title}
                </a>
                <p className="mono-label mt-1">
                  {s.publisher ?? new URL(s.url).hostname} ·{" "}
                  {s.published_at ? new Date(s.published_at).toLocaleDateString() : "no publish date"} ·
                  retrieved {new Date(s.retrieved_at).toLocaleString()}
                </p>
                {s.snippet && (
                  <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{s.snippet}</p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="panel mt-4 p-5 text-sm text-muted-foreground">
            No sources retrieved yet.
          </p>
        )}
      </section>

    </div>
  );
}

function Facts({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <p className="mono-label">{title}</p>
      <ul className="mt-2 space-y-1.5 text-sm">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-muted-foreground">
            <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
