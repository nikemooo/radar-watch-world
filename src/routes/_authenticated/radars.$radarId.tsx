import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Loader2, Pause, Pencil, Play, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getSweepStatus, listRadarSources, runRadarNow } from "@/lib/radar.functions";
import { reverifyRadar } from "@/lib/verification.functions";
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
import { track } from "@/lib/analytics";
import { ListingRail, snapshotOf, type FindingLike } from "@/components/listing-card";
import { VerifyDialog } from "@/components/verify-dialog";
import { EditCriteriaDialog } from "@/components/edit-criteria-dialog";
import {
  effectiveVerdict,
  imageObservationsOf,
  outcomesOf,
  type UserVerdict,
} from "@/lib/monitoring/verification";


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
  const [editOpen, setEditOpen] = useState(false);
  const run = useServerFn(runRadarNow);
  const reverify = useServerFn(reverifyRadar);
  const fetchSources = useServerFn(listRadarSources);
  const fetchSweepStatus = useServerFn(getSweepStatus);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueIndex, setQueueIndex] = useState(0);

  // The persisted run row is the single source of truth for "is a sweep alive?".
  // Reading it also triggers server-side recovery of runs whose worker died,
  // so the page can never show an endless "Söker igenom marknaden…".
  const { data: sweepStatus } = useQuery({
    queryKey: ["sweep-status", radarId],
    queryFn: () => fetchSweepStatus({ data: { radarId } }),
    refetchInterval: (query) => (query.state.data?.state === "running" ? 5000 : false),
  });

  const { data: sources } = useQuery({
    queryKey: ["radar-sources", radarId],
    queryFn: () => fetchSources({ data: { radarId, limit: 25 } }),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["radar", radarId],
    refetchInterval: (query) => {
      const state = query.state.data;
      const running =
        state?.runs?.some((entry) => entry.status === "running") ||
        state?.radar?.scan_state === "INITIAL_SCAN_RUNNING";
      return running ? 4000 : false;
    },

    queryFn: async () => {
      const [radar, alerts, runs, decisions, findings, changes, verifications] = await Promise.all([
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
          .limit(100),
        supabase
          .from("finding_changes")
          .select("*")
          .eq("radar_id", radarId)
          .order("changed_at", { ascending: false })
          .limit(25),
        supabase.from("finding_verifications").select("*").eq("radar_id", radarId),
      ]);
      if (radar.error) throw radar.error;
      return {
        radar: radar.data,
        alerts: (alerts.data ?? []) as AlertRow[],
        runs: runs.data ?? [],
        decisions: decisions.data ?? [],
        findings: findings.data ?? [],
        changes: changes.data ?? [],
        verifications: verifications.data ?? [],
      };
    },
  });


  const sweep = useMutation({
    mutationFn: async () => run({ data: { radarId } }),
    onSuccess: (outcome) => {
      if (outcome.state === "running") {
        toast.success("Sökningen har startat — den fortsätter i bakgrunden.");
      } else {
        const r = outcome.result as { alertsCreated?: number; runType?: string; itemsFound?: number };
        const created = r?.alertsCreated ?? 0;
        toast.success(
          r?.runType === "baseline"
            ? `Marknadsskanningen är klar — ${r.itemsFound ?? 0} annonser hittades. Radar bevakar nu marknaden.`
            : created > 0
              ? `${created} ny${created > 1 ? "a" : "tt"} larm.`
              : "Kontrollen är klar — inget nytt.",
        );

      }
      queryClient.invalidateQueries({ queryKey: ["radar", radarId] });
      queryClient.invalidateQueries({ queryKey: ["sweep-status", radarId] });
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

  const recheck = useMutation({
    mutationFn: async () => reverify({ data: { radarId, useImages: true } }),
    onSuccess: (report) => {
      toast.success(
        `Omverifiering klar — ${report.after.match} matchar, ${report.after.unverified} behöver verifieras, ${report.after.reject} matchar inte.`,
      );
      queryClient.invalidateQueries({ queryKey: ["radar", radarId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const answer = useMutation({
    mutationFn: async (input: { finding: FindingLike; attribute: string; verdict: UserVerdict }) => {
      const { data: session } = await supabase.auth.getUser();
      const userId = session.user?.id;
      if (!userId) throw new Error("Du måste vara inloggad.");
      const { error } = await supabase.from("finding_verifications").upsert(
        {
          finding_id: input.finding.id,
          radar_id: radarId,
          user_id: userId,
          attribute: input.attribute,
          verdict: input.verdict,
          verification_source: "user",
        },
        { onConflict: "finding_id,attribute,user_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["radar", radarId] }),
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading) return <Skeleton className="h-72" />;
  if (!data?.radar) {
    return (
      <div className="panel p-10 text-center text-sm text-muted-foreground">
        Den här radarn finns inte längre.
      </div>
    );
  }

  const radar = data.radar;
  const config = asConfig(radar.config);
  const findings = data.findings as unknown as FindingLike[];
  const verdictOf = (f: FindingLike) => {
    const snapshot = snapshotOf(f.snapshot) as { criteria?: unknown; image_evidence?: unknown };
    return effectiveVerdict(
      outcomesOf(snapshot.criteria),
      data.verifications
        .filter((v) => v.finding_id === f.id)
        .map((v) => ({ attribute: v.attribute, verdict: v.verdict as UserVerdict, note: v.note })),
      imageObservationsOf(snapshot.image_evidence),
    );
  };
  const statusOf = (f: FindingLike) => verdictOf(f).status;
  const matched = findings.filter((f) => statusOf(f) === "match");
  const unverified = findings.filter((f) => statusOf(f) === "unverified");
  const rejected = findings.filter((f) => statusOf(f) === "reject");
  const running = sweepStatus?.state === "running";
  const interrupted = sweepStatus?.state === "failed" && !!sweepStatus.failureReason;
  const scanning = running || (radar.scan_state === "INITIAL_SCAN_RUNNING" && !sweepStatus);

  const openQueue = (finding?: FindingLike) => {
    const index = finding ? Math.max(unverified.findIndex((f) => f.id === finding.id), 0) : 0;
    setQueueIndex(index);
    setQueueOpen(true);
  };

  const statusLine = scanning
    ? `${sweepStatus?.phaseLabel ?? "Söker igenom marknaden"}…`
    : radar.scan_state === "MONITORING"
      ? "Bevakar marknaden"
      : "Redo att söka marknaden";


  return (
    <div className="space-y-8">
      <Link to="/radars" className="mono-label inline-flex items-center gap-1.5 hover:text-foreground">
        <ArrowLeft className="size-3" />
        Alla radars
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{radar.name}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 text-sm">
            <span className={scanning ? "text-muted-foreground" : "text-interesting"}>
              {scanning ? "🔎" : "🟢"} {statusLine}
            </span>
            <span className="text-muted-foreground">
              {findings.length} hittade · {matched.length} matchar · {unverified.length} behöver verifieras ·{" "}
              {rejected.length} matchar inte
            </span>
            <span className="text-muted-foreground">
              {radar.last_successful_sweep_at
                ? `Senaste kontroll ${new Date(radar.last_successful_sweep_at).toLocaleString("sv-SE")}`
                : "Ingen kontroll ännu"}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button className="gap-2" onClick={() => sweep.mutate()} disabled={sweep.isPending}>
            {sweep.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {sweep.isPending ? "Söker…" : "Sök nu"}
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => recheck.mutate()}
            disabled={recheck.isPending}
          >
            {recheck.isPending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            {recheck.isPending ? "Verifierar…" : "Verifiera om"}
          </Button>
          <Button variant="outline" className="gap-2" onClick={() => setEditOpen(true)}>
            <Pencil className="size-4" />
            Redigera kriterier
          </Button>
          <Button

            variant="outline"
            size="icon"
            aria-label={radar.status === "active" ? "Pausa radar" : "Återuppta radar"}
            onClick={() => update.mutate({ status: radar.status === "active" ? "paused" : "active" })}
          >
            {radar.status === "active" ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <Button variant="outline" size="icon" aria-label="Ta bort radar" onClick={() => remove.mutate()}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </header>

      {interrupted && (
        <section className="panel p-5">
          <p className="text-sm font-medium">Sökningen avbröts</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {sweepStatus?.error ?? "Bakgrundskörningen avslutades innan den blev klar."} Inga resultat gick
            förlorade — du kan starta om sökningen.
          </p>
          <Button className="mt-3 gap-2" onClick={() => sweep.mutate()} disabled={sweep.isPending}>
            <RefreshCw className="size-4" />
            Sök igen
          </Button>
        </section>
      )}

      {scanning && (
        <section className="panel p-5">
          <p className="text-sm font-medium">{sweepStatus?.phaseLabel ?? "Söker igenom marknaden"}…</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {sweepStatus && (sweepStatus.sourcesRetrieved > 0 || sweepStatus.candidates > 0)
              ? `${sweepStatus.sourcesRetrieved} källor lästa · ${sweepStatus.candidates} annonser hittade · ${sweepStatus.detailFetches} annonser lästa i detalj.`
              : "Hittar aktuella annonser · läser annonsdetaljer · jämför priser."}{" "}
            Det tar några minuter och fortsätter även om du lämnar sidan.
          </p>
          {!!sweepStatus?.continuations && (
            <p className="mt-1 text-xs text-muted-foreground">
              Sökningen avbröts och återupptogs {sweepStatus.continuations} gång
              {sweepStatus.continuations === 1 ? "" : "er"} — redan hämtad data används om, inget
              görs om i onödan.
            </p>
          )}
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
          </div>

        </section>
      )}

      <section>
        <h2 className="text-lg font-medium">Matchar dina kriterier</h2>
        {matched.length > 0 ? (
          <div className="mt-4">
            <ListingRail findings={matched} verdictOf={verdictOf} onVerify={openQueue} />
          </div>
        ) : (
          <div className="panel mt-4 p-6 text-sm">
            <p className="font-medium">Inga verifierade matchningar just nu</p>
            <p className="mt-1 text-muted-foreground">
              Radar fortsätter bevaka marknaden och meddelar dig när alla dina kriterier kan bekräftas.
              {findings.length > 0 && ` ${findings.length} annonser hittades och kontrollerades.`}
            </p>
          </div>
        )}
      </section>

      {unverified.length > 0 && (
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-medium">
                Behöver verifieras{" "}
                <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-sm">{unverified.length}</span>
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {unverified.length} annonser behöver verifieras — Radar kunde inte säkert bekräfta ett eller
                flera av dina kriterier.
              </p>
            </div>
            <Button variant="secondary" onClick={() => openQueue()}>
              Öppna verifieringskö
            </Button>
          </div>
          <div className="mt-4">
            <ListingRail findings={unverified} verdictOf={verdictOf} onVerify={openQueue} />
          </div>
        </section>
      )}

      <EditCriteriaDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        radarId={radarId}
        initialName={radar.name}
        initialFrequency={radar.frequency as RadarFrequency}
        initialRecencyDays={radar.recency_days ?? 30}
        config={config}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ["radar", radarId] })}
      />

      <VerifyDialog
        findings={unverified}
        index={queueIndex}
        onIndexChange={setQueueIndex}
        open={queueOpen && unverified.length > 0}
        onOpenChange={setQueueOpen}
        verdictOf={verdictOf}
        onAnswer={(input) => answer.mutate(input)}
      />


      {rejected.length > 0 && (
        <details className="panel p-5">
          <summary className="cursor-pointer text-sm font-medium">
            Matchar inte ({rejected.length}) — visa bortsorterade
          </summary>
          <ul className="mt-3 divide-y divide-border text-sm">
            {rejected.map((f) => (
              <li key={f.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                <a
                  href={f.primary_url ?? f.url ?? "#"}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="min-w-0 flex-1 truncate underline underline-offset-4"
                >
                  {f.title}
                </a>
                <span className="text-muted-foreground">{verdictOf(f).reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <section>
        <h2 className="text-lg font-medium">Senaste nytt</h2>
        {data.alerts.length ? (
          <div className="mt-4 space-y-3">
            {data.alerts.map((alert) => (
              <AlertCard key={alert.id} alert={alert} />
            ))}
          </div>
        ) : (
          <p className="panel mt-4 p-5 text-sm text-muted-foreground">
            Inget nytt ännu. Radar hör av sig när en ny annons dyker upp, ett pris ändras eller en annons
            försvinner.
          </p>
        )}
        {data.changes.length > 0 && (
          <ul className="panel mt-3 divide-y divide-border">
            {data.changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5 text-sm">
                <span className="mono-label">{c.attribute.replace(/_/g, " ")}</span>
                <span className="text-muted-foreground line-through">{c.previous_raw ?? c.previous_value}</span>
                <span>→ {c.new_raw ?? c.new_value}</span>
                <span className="mono-label ml-auto">
                  {new Date(c.changed_at).toLocaleString("sv-SE")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="panel p-5">
        <summary className="cursor-pointer text-sm font-medium">Inställningar</summary>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Select value={radar.frequency} onValueChange={(frequency) => update.mutate({ frequency })}>
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
            onValueChange={(v) => update.mutate({ recency_days: Number(v), recency_source: "user_override" })}
          >
            <SelectTrigger className="w-44" aria-label="Tidsfönster">
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
        </div>
        <p className="mt-4 text-sm text-muted-foreground">{config.interpretation || radar.raw_request}</p>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <Facts title="Bevakar" items={config.monitored_events} />
          <Facts title="Viktigast" items={config.important_criteria} />
          <Facts title="Sökstrategi" items={config.search_queries} />
          <Facts title="Utesluter" items={config.exclusions} />
        </div>
      </details>

      <details className="panel p-5">
        <summary className="cursor-pointer text-sm font-medium">Teknisk information</summary>

        <div className="mt-4 space-y-4">
          {data.runs.map((entry) => (
            <div key={entry.id} className="space-y-1 border-b border-border pb-3 text-xs text-muted-foreground last:border-0">
              <p className="text-sm text-foreground">
                {new Date(entry.started_at).toLocaleString("sv-SE")} · {entry.status} · {entry.run_type} ·{" "}
                {entry.items_found} found · {entry.new_items} new · {entry.alerts_created} alerts
              </p>
              <p>
                detail — {entry.candidates_discovered} candidates · budget {entry.detail_fetch_budget} ·{" "}
                {entry.detail_fetches_attempted} attempted · {entry.detail_fetches_ok} fetched ·{" "}
                {entry.detail_fetches_failed} blocked · {entry.detail_fetches_skipped_backoff} skipped (backoff) ·{" "}
                {entry.attributes_extracted} attributes · {entry.attributes_missing} missing
              </p>
              <p>
                criteria — {entry.criteria_matched} matched · {entry.criteria_rejected} rejected ·{" "}
                {entry.criteria_unverified} unverified · pagination {entry.pagination_pages_attempted} attempted /{" "}
                {entry.pagination_pages_succeeded} ok / {entry.pagination_pages_blocked} blocked
              </p>
              <p>
                comparables — {entry.usable_comparables} usable of {entry.comparable_observations} observations ·{" "}
                {entry.baselines_computed} baselines · {entry.baselines_insufficient} insufficient · est. cost $
                {Number(entry.cost_estimate ?? 0).toFixed(3)}
              </p>
              <p>
                suppressed — baseline {entry.suppressed_baseline} · recency {entry.suppressed_recency} · duplicate{" "}
                {entry.suppressed_duplicate} · relevance {entry.suppressed_relevance}
              </p>
              {entry.error && <p className="text-critical">{entry.error}</p>}
            </div>
          ))}

          {data.decisions.length > 0 && (
            <ul className="divide-y divide-border">
              {data.decisions.map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline gap-x-3 py-2 text-xs">
                  <span className={d.eligible ? "text-primary" : "text-muted-foreground"}>
                    {d.decision.replace(/_/g, " ")}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{d.title}</span>
                  <span className="text-muted-foreground">{d.reason}</span>
                </li>
              ))}
            </ul>
          )}

          {sources?.length ? (
            <ul className="divide-y divide-border">
              {sources.map((s) => (
                <li key={s.id} className="py-2 text-xs">
                  <a href={s.url} target="_blank" rel="noreferrer noopener" className="underline">
                    {s.title}
                  </a>
                  <span className="ml-2 text-muted-foreground">
                    {s.publisher ?? new URL(s.url).hostname} · retrieved{" "}
                    {new Date(s.retrieved_at).toLocaleString("sv-SE")}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
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
