import { useT } from "@/lib/i18n";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Activity, Bell, Plus, Radar as RadarIcon, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getOnboardingState } from "@/lib/onboarding.functions";
import { AlertCard, type AlertRow } from "@/components/alert-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RadarMark } from "@/components/radar-mark";
import { Textarea } from "@/components/ui/textarea";
import { buildThemes } from "@/lib/market/themes";

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

/** Natural-language entry point: describe it here, refine it on the next screen. */
function QuickCreate() {
  const t = useT();
  const navigate = useNavigate();
  const [request, setRequest] = useState("");
  const submit = () => {
    const q = request.trim();
    if (!q) return;
    void navigate({ to: "/radars/new", search: { q } });
  };
  return (
    <section className="panel p-5">
      <h2 className="text-lg font-medium">{t("dashboard.quick.title")}</h2>
      <Textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        placeholder={t("dashboard.quick.placeholder")}
        rows={3}
        className="mt-3 resize-none"
      />
      <div className="mt-3 flex justify-end">
        <Button onClick={submit} disabled={!request.trim()} className="gap-2">
          <Sparkles className="size-4" />
          {t("dashboard.quick.cta")}
        </Button>
      </div>
    </section>
  );
}

function Dashboard() {
  const navigate = useNavigate();
  const t = useT();
  const onboardingState = useServerFn(getOnboardingState);

  // First-time users go through onboarding once; everyone else stays here.
  const { data: onboarding } = useQuery({
    queryKey: ["onboarding-state"],
    queryFn: () => onboardingState({}),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (onboarding && !onboarding.onboardingDone && onboarding.radarCount === 0) {
      navigate({ to: "/onboarding", replace: true });
    }
  }, [onboarding, navigate]);

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
      const { data: events } = await supabase
        .from("market_events")
        .select(
          "id, title, severity, importance_score, event_type, source_count, published_at, detected_at, radar_id, entities, market_reactions, last_updated_at",
        )
        .order("last_updated_at", { ascending: false })
        .limit(40);
      return {
        radars: radars.data ?? [],
        alerts: (alerts.data ?? []) as AlertRow[],
        weekAlerts: weekAlerts.data ?? [],
        lastRun: runs.data?.[0] ?? null,
        events: events ?? [],
      };
    },
  });

  // Individual headlines are noise; themes are what is actually moving markets.
  const themes = buildThemes(data?.events ?? []);

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
          <p className="mono-label">{t("dashboard.eyebrow")}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("dashboard.title")}</h1>
        </div>
        <Button asChild className="gap-2">
          <Link to="/radars/new">
            <Plus className="size-4" />
            {t("dashboard.newRadar")}
          </Link>
        </Button>
      </header>

      <QuickCreate />

      {empty ? (
        <div className="panel px-5 py-10 text-center sm:px-8 sm:py-14">
          <RadarMark className="mx-auto size-14" />
          <h2 className="mt-6 text-xl font-semibold tracking-tight">{t("dashboard.empty.title")}</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            {t("dashboard.empty.body")}
          </p>
          <ul className="mx-auto mt-7 grid max-w-lg gap-2 text-left">
            {[
              { emoji: "🚗", text: t("dashboard.empty.example.car") },
              { emoji: "⌚", text: t("dashboard.empty.example.watch") },
              { emoji: "📈", text: t("dashboard.empty.example.news") },
            ].map((e) => (
              <li
                key={e.text}
                className="flex items-start gap-3 rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground"
              >
                <span className="text-base leading-none">{e.emoji}</span>
                {e.text}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-xs text-muted-foreground">
            {t("dashboard.empty.footnote")}
          </p>
          <Button asChild className="mt-7 h-12 w-full max-w-xs text-base">
            <Link to="/radars/new">{t("dashboard.empty.cta")}</Link>
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat icon={RadarIcon} label={t("dashboard.stat.activeRadars")} value={String(activeRadars)} to="/radars" />
            <Stat
              icon={Bell}
              label={t("dashboard.stat.alertsThisWeek")}
              value={String(data?.weekAlerts.length ?? 0)}
              to="/alerts"
            />
            <Stat
              icon={Sparkles}
              label={t("dashboard.stat.needsAttention")}
              value={String(critical)}
              to="/alerts"
              search={{ filter: "critical" as const }}
            />
          </div>


          {themes.length > 0 && (
            <section>
              <h2 className="text-lg font-medium">{t("dashboard.themes.title")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("dashboard.themes.subtitle")}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {themes.map((theme) => (
                  <article key={theme.id} className="panel p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="mono-label">{theme.category.replace(/_/g, " ")}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {t("dashboard.themes.count", { n: String(theme.eventCount) })}
                      </span>
                    </div>
                    <h3 className="mt-2 truncate text-sm font-medium">{theme.label}</h3>
                    {theme.moves.length > 0 ? (
                      <ul className="mt-3 flex flex-wrap gap-2">
                        {theme.moves.map((move) => (
                          <li
                            key={move.symbol}
                            className={`rounded-md border border-border px-2 py-1 font-mono text-xs ${
                              move.changePct >= 0 ? "text-interesting" : "text-critical"
                            }`}
                          >
                            {move.symbol} {move.changePct >= 0 ? "+" : ""}
                            {move.changePct.toFixed(2)}%
                            {move.window ? ` · ${move.window}` : ""}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-3 text-xs text-muted-foreground">{t("dashboard.themes.noData")}</p>
                    )}
                    <Link
                      to="/events/$eventId"
                      params={{ eventId: theme.eventIds[0]! }}
                      className="mono-label mt-3 inline-block text-primary hover:underline"
                    >
                      {t("dashboard.themes.open")}
                    </Link>
                  </article>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="text-lg font-medium">{t("dashboard.events.title")}</h2>
            {data?.events.length ? (
              <ul className="mt-4 space-y-2">
                {data.events.slice(0, 6).map((event) => (
                  <li key={event.id}>
                    <Link
                      to="/events/$eventId"
                      params={{ eventId: event.id }}
                      className="panel flex flex-wrap items-center gap-3 p-4 transition-colors hover:border-primary/50"
                    >
                      <span className="mono-label">{(event.event_type ?? "other").replace(/_/g, " ")}</span>
                      <span className="min-w-0 flex-1 truncate text-sm">{event.title}</span>
                      <span className="mono-label">{event.source_count} src</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {event.importance_score ?? 0}/100
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="panel mt-4 p-5 text-sm text-muted-foreground">{t("dashboard.events.empty")}</p>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">{t("dashboard.latest")}</h2>
              <Button asChild variant="ghost" size="sm">
                <Link to="/alerts">{t("common.viewAll")}</Link>
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
                {t("dashboard.noAlerts")}
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
  to,
  search,
}: {
  icon: typeof Bell;
  label: string;
  value: string;
  to: "/radars" | "/alerts";
  search?: { filter: "critical" };
}) {
  return (
    <Link
      to={to}
      search={search as never}
      className="panel block p-4 transition-colors hover:border-primary/50"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" />
        <span className="mono-label">{label}</span>
      </div>
      <p className="mt-3 font-mono text-3xl">{value}</p>
    </Link>
  );

}
