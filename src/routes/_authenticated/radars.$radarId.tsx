import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Loader2, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { listRadarSources, runRadarNow } from "@/lib/radar.functions";
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
import { asConfig, frequencyLabel, recencyPresets, type RadarFrequency } from "@/lib/radar-types";
import { isFactual, type AttributeValue } from "@/lib/monitoring/normalize";
import { track } from "@/lib/analytics";
import { BaselinePanel } from "@/components/baseline-panel";

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
  const fetchSources = useServerFn(listRadarSources);

  const { data: sources } = useQuery({
    queryKey: ["radar-sources", radarId],
    queryFn: () => fetchSources({ data: { radarId, limit: 25 } }),
  });



  const { data, isLoading } = useQuery({
    queryKey: ["radar", radarId],
    queryFn: async () => {
      const [radar, alerts, runs, decisions, findings, changes] = await Promise.all([
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
        supabase
          .from("alert_decisions")
          .select("*")
          .eq("radar_id", radarId)
          .order("created_at", { ascending: false })
          .limit(25),
        supabase
          .from("findings")
          .select("*")
          .eq("radar_id", radarId)
          .order("last_seen_at", { ascending: false })
          .limit(40),
        supabase
          .from("finding_changes")
          .select("*")
          .eq("radar_id", radarId)
          .order("changed_at", { ascending: false })
          .limit(25),
      ]);
      if (radar.error) throw radar.error;
      return {
        radar: radar.data,
        alerts: (alerts.data ?? []) as AlertRow[],
        runs: runs.data ?? [],
        decisions: decisions.data ?? [],
        findings: findings.data ?? [],
        changes: changes.data ?? [],
      };
    },
  });

  const sweep = useMutation({
    mutationFn: async () => run({ data: { radarId } }),
    onSuccess: (outcome) => {
      if (outcome.state === "running") {
        toast.success("Sweep started — it keeps running in the background.");
      } else {
        const r = outcome.result as { alertsCreated?: number; runType?: string; itemsFound?: number };
        const created = r?.alertsCreated ?? 0;
        toast.success(
          r?.runType === "baseline"
            ? `Baseline recorded — ${r.itemsFound ?? 0} findings saved as history, no alerts.`
            : created > 0
              ? `${created} new alert${created > 1 ? "s" : ""}.`
              : "Sweep complete — nothing new.",
        );
      }
      queryClient.invalidateQueries({ queryKey: ["radar", radarId] });
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      queryClient.invalidateQueries({ queryKey: ["radar-sources", radarId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const update = useMutation({
    mutationFn: async (patch: {
      status?: string;
      frequency?: string;
      recency_days?: number;
      recency_source?: string;
    }) => {
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
          <Select
            value={String(radar.recency_days)}
            onValueChange={(v) =>
              update.mutate({ recency_days: Number(v), recency_source: "user_override" })
            }
          >
            <SelectTrigger className="w-44" aria-label="Recency window">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {recencyPresets.map((p) => (
                <SelectItem key={p.days} value={String(p.days)}>
                  {p.label}
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

      <section className="panel flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
        <span className="mono-label">
          {radar.baseline_completed ? "Baseline complete" : "Baseline pending"}
        </span>
        <span className="text-muted-foreground">
          {radar.baseline_completed
            ? "Only genuinely new or changed information is alerted."
            : "The first sweep records a snapshot without alerting."}
        </span>
        <span className="ml-auto text-muted-foreground">
          Window: last {radar.recency_days} days ·{" "}
          {radar.last_successful_sweep_at
            ? `last successful sweep ${new Date(radar.last_successful_sweep_at).toLocaleString()}`
            : "no successful sweep yet"}
        </span>
      </section>

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
                <span className="rounded-full border border-border px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
                  {entry.run_type}
                </span>
                <span className="ml-auto text-muted-foreground">
                  {entry.items_found} found · {entry.new_items} new · {entry.alerts_created} alerts
                </span>
                <span className="w-full text-xs text-muted-foreground">
                  detail — {entry.candidates_discovered} candidates · budget {entry.detail_fetch_budget} ·{" "}
                  {entry.detail_fetches_attempted} attempted · {entry.detail_fetches_ok} fetched ·{" "}
                  {entry.detail_fetches_failed} blocked · {entry.detail_fetches_skipped_backoff} skipped (backoff) ·{" "}
                  {entry.attributes_extracted} attributes · {entry.attributes_missing} missing
                </span>
                <span className="w-full text-xs text-muted-foreground">
                  comparables — {entry.usable_comparables} usable of {entry.comparable_observations} observations (
                  {Number(entry.comparable_coverage ?? 0).toFixed(1)}% coverage) · {entry.baselines_computed} baselines
                  computed · {entry.baselines_backfilled} backfilled · {entry.baselines_insufficient} insufficient ·
                  est. cost ${Number(entry.cost_estimate ?? 0).toFixed(3)} of ${Number(entry.cost_ceiling ?? 0).toFixed(3)} ceiling
                </span>

                <span className="w-full text-xs text-muted-foreground">
                  comparables — {entry.comparable_observations} observations ·{" "}
                  {entry.baselines_computed} baselines calculated · {entry.baselines_insufficient} insufficient
                </span>
                <span className="w-full text-xs text-muted-foreground">
                  suppressed — baseline {entry.suppressed_baseline} · recency {entry.suppressed_recency} ·
                  duplicate {entry.suppressed_duplicate} · relevance {entry.suppressed_relevance}
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

      {data.decisions.length > 0 && (
        <section>
          <h2 className="text-lg font-medium">Alert decisions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Why each finding did or did not become an alert. Baseline history is kept, never deleted.
          </p>
          <ul className="panel mt-4 divide-y divide-border">
            {data.decisions.map((d) => (
              <li key={d.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm">
                <span className={d.eligible ? "text-primary" : "text-muted-foreground"}>
                  {d.decision.replace(/_/g, " ")}
                </span>
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                <span className="mono-label">
                  {d.published_at ? new Date(d.published_at).toLocaleDateString() : "undated"}
                </span>
                <p className="w-full text-xs text-muted-foreground">{d.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.findings.length > 0 && (
        <section>
          <h2 className="text-lg font-medium">Tracked items</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Item-level data read from individual pages. Only values the source states are shown as facts.
          </p>
          <ul className="panel mt-4 divide-y divide-border">
            {data.findings.map((f) => {
              const attributes = Object.values(
                (f.attributes ?? {}) as unknown as Record<string, AttributeValue>,
              ).filter((a) => a && typeof a === "object" && a.raw);
              return (
                <li key={f.id} className="p-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <a
                      href={f.primary_url ?? f.url ?? "#"}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-sm font-medium underline underline-offset-4"
                    >
                      {f.title}
                    </a>
                    <span className="mono-label">
                      {f.detail_status === "fetched"
                        ? "detail page read"
                        : f.detail_status === "failed"
                          ? "detail page unavailable"
                          : "index source only"}
                    </span>
                    {f.availability && <span className="mono-label">{f.availability}</span>}
                  </div>
                  {attributes.length > 0 ? (
                    <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                      {attributes.map((a) => (
                        <div key={a.key} className="flex gap-2">
                          <dt className="mono-label">{a.key.replace(/_/g, " ")}</dt>
                          <dd className={isFactual(a) ? "" : "text-muted-foreground italic"}>
                            {a.raw}
                            {!isFactual(a) && " (inferred)"}
                            {a.value !== null && (a.currency || a.unit) && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                = {a.value} {a.currency ?? a.unit}
                              </span>
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      No item-level attributes available from the source — fields remain unknown.
                    </p>
                  )}
                  <BaselinePanel baseline={f.baseline} />
                  {f.discovery_url && f.discovery_url !== (f.primary_url ?? f.url) && (
                    <p className="mono-label mt-2">
                      discovered on{" "}
                      <a href={f.discovery_url} target="_blank" rel="noreferrer noopener" className="underline">
                        {new URL(f.discovery_url).hostname}
                      </a>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {data.changes.length > 0 && (
        <section>
          <h2 className="text-lg font-medium">Attribute changes</h2>
          <ul className="panel mt-4 divide-y divide-border">
            {data.changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-3 text-sm">
                <span className="mono-label">{c.attribute.replace(/_/g, " ")}</span>
                <span className="text-muted-foreground line-through">{c.previous_raw ?? c.previous_value}</span>
                <span>→ {c.new_raw ?? c.new_value}</span>
                <span className="mono-label ml-auto">{new Date(c.changed_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

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
