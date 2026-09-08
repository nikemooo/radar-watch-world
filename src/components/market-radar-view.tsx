/**
 * Market Monitoring view — the radar detail face for value-tracking radars.
 *
 * Pure presentation over market_observations rows: current value with
 * verification status, change chips (24h / 7d / 30d / baseline), a sparkline
 * of the collected history, the alert rules with live condition state, and
 * the sources behind the latest value. All math comes from the pure modules
 * in src/lib/market, so the client can evaluate rule state without a server
 * round-trip.
 */
import type { Database } from "@/integrations/supabase/types";
import { useFormatDateTime, useT } from "@/lib/i18n";
import {
  computeMarketChanges,
  latestObservation,
  priceFreshness,
  type WindowChange,
} from "@/lib/market/history";
import { evaluateMarketRules, type MarketRuleStateMap } from "@/lib/market/rules";
import type { MarketMonitorSpec } from "@/lib/market/types";

type Observation = Database["public"]["Tables"]["market_observations"]["Row"];

function formatMarketValue(value: number, currency: string | null, unit: string | null): string {
  if (unit === "percent") return `${Number(value.toFixed(3))} %`;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: Math.abs(value) < 10 ? 4 : 2,
      }).format(value);
    } catch {
      /* fall through to plain number */
    }
  }
  const num =
    Math.abs(value) >= 1000
      ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : Math.abs(value) >= 1
        ? Number(value.toFixed(2)).toString()
        : Number(value.toPrecision(4)).toString();
  return unit ? `${num} ${unit}` : num;
}

function Sparkline({ points }: { points: { t: string; v: number }[] }) {
  const W = 560;
  const H = 120;
  const P = 8;
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.abs(max) * 0.01 || 1;
  const x = (i: number) => P + (i / Math.max(points.length - 1, 1)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P);
  const last = points[points.length - 1]!;
  if (points.length === 1) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" aria-hidden>
        <circle cx={W / 2} cy={H / 2} r={4} className="fill-primary" />
      </svg>
    );
  }
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const area = `${path} L${x(points.length - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="none" aria-hidden>
      <path d={area} className="fill-primary/10" stroke="none" />
      <path d={path} fill="none" className="stroke-primary" strokeWidth={1.5} />
      <circle cx={x(points.length - 1)} cy={y(last.v)} r={3} className="fill-primary" />
    </svg>
  );
}

function ChangeChip({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null || !Number.isFinite(pct)) return null;
  const up = pct > 0.0001;
  const down = pct < -0.0001;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={up ? "text-primary" : down ? "text-critical" : "text-muted-foreground"}>
        {up ? "▲" : down ? "▼" : "·"} {up ? "+" : ""}
        {pct.toFixed(2)} %
      </span>
    </span>
  );
}

interface SourceEntry {
  source?: string;
  sourceUrl?: string;
  value?: number;
  observedAt?: string;
}

export function MarketRadarView({
  spec,
  observations,
  ruleState,
}: {
  spec: MarketMonitorSpec;
  observations: Observation[];
  ruleState: MarketRuleStateMap;
}) {
  const t = useT();
  const formatDateTime = useFormatDateTime();
  const inst = spec.instrument;

  const relevant = observations.filter(
    (o) => o.instrument === inst.symbol && o.metric === inst.metric && Number.isFinite(Number(o.value)),
  );
  const points = relevant.map((o) => ({ t: o.observed_at, v: Number(o.value) }));
  // Several sweeps can legitimately record the same source timestamp (a
  // weekend or holiday for a stock); the newest retrieval wins the tie.
  const latest = latestObservation(relevant);
  const freshness = latest ? priceFreshness(inst.kind, latest.observed_at, latest.retrieved_at) : null;
  const ageLabel = (ms: number) => {
    const h = Math.round(ms / 36e5);
    return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
  };

  if (!latest || points.length === 0) {
    return (
      <section className="panel p-6 text-sm text-muted-foreground">
        {t("market.awaitingBaseline")}
      </section>
    );
  }

  const current = Number(latest.value);
  const baselineValue = points[0]!.v;
  const changes = computeMarketChanges(points);
  const evaluation = evaluateMarketRules(spec.rules, {
    current,
    baselineValue,
    changes,
    state: ruleState,
  });
  const baselinePct =
    points.length > 1 && baselineValue !== 0 ? ((current - baselineValue) / baselineValue) * 100 : null;
  const sources: SourceEntry[] = Array.isArray(latest.sources)
    ? (latest.sources as SourceEntry[])
    : [];
  const fmt = (v: number) => formatMarketValue(v, latest.currency ?? inst.currency, latest.unit ?? inst.unit);

  return (
    <div className="space-y-6">
      <section className="panel p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="mono-label">
              {t("market.badge")} · {inst.kind}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{inst.name}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight">{fmt(current)}</p>
            <p className="mono-label mt-2">
              {t("market.observedAt", { when: formatDateTime(latest.observed_at) })}
              {latest.retrieved_at && (
                <> · {t("market.checkedAt", { when: formatDateTime(latest.retrieved_at) })}</>
              )}
            </p>
            {freshness && freshness.state !== "fresh" && (
              <p className="mt-2 inline-block rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                {t(freshness.state === "last_close" ? "market.lastClose" : "market.stale", {
                  when: formatDateTime(latest.observed_at),
                  age: ageLabel(freshness.ageMs),
                })}
              </p>
            )}
          </div>
          <div className="text-right">
            <span
              className={`inline-block rounded-full border px-3 py-1 text-xs ${
                latest.status === "VERIFIED"
                  ? "border-primary/40 text-primary"
                  : "border-border text-muted-foreground"
              }`}
            >
              {latest.status === "VERIFIED"
                ? t("market.verified", { count: sources.length || 1 })
                : t("market.probable")}
            </span>
            <p className="mono-label mt-2">
              {t("market.confidence", { pct: Math.round(Number(latest.confidence) * 100) })}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <ChangeChip label={t("market.change.24h")} pct={changes?.windows["24h"]?.pct ?? null} />
          <ChangeChip label={t("market.change.7d")} pct={changes?.windows["7d"]?.pct ?? null} />
          <ChangeChip label={t("market.change.30d")} pct={changes?.windows["30d"]?.pct ?? null} />
          <ChangeChip label={t("market.change.baseline")} pct={baselinePct} />
          {!changes?.windows["24h"] && !changes?.windows["7d"] && !changes?.windows["30d"] && baselinePct === null && (
            <span className="text-xs text-muted-foreground">{t("market.noHistory")}</span>
          )}
        </div>
      </section>

      <section className="panel p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-medium">{t("market.history.title")}</h2>
          <span className="mono-label">{t("market.observations", { count: points.length })}</span>
        </div>
        <div className="mt-4">
          <Sparkline points={points.slice(-90)} />
        </div>
        <div className="mono-label mt-2 flex justify-between">
          <span>{formatDateTime(points[0]!.t)}</span>
          <span>{formatDateTime(points[points.length - 1]!.t)}</span>
        </div>
      </section>

      <section className="panel p-5">
        <h2 className="text-lg font-medium">{t("market.rules.title")}</h2>
        {evaluation.statuses.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t("market.rules.empty")}</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {evaluation.statuses.map((s) => (
              <li key={s.rule.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    s.evaluable && s.conditionMet ? "bg-primary" : "bg-muted-foreground"
                  }`}
                />
                <span className="min-w-0 flex-1 text-sm">{s.rule.label}</span>
                <span className="mono-label">
                  {!s.evaluable
                    ? t("market.rules.collecting")
                    : s.conditionMet
                      ? t("market.rules.met")
                      : t("market.rules.notMet")}
                </span>
                <span className="mono-label">
                  {s.lastTriggeredAt
                    ? t("market.rules.lastFired", { when: formatDateTime(s.lastTriggeredAt) })
                    : t("market.rules.never")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sources.length > 0 && (
        <section className="panel p-5">
          <h2 className="text-lg font-medium">{t("market.sources.title")}</h2>
          <ul className="mt-2 divide-y divide-border">
            {sources.map((s, i) => (
              <li key={`${s.source}-${i}`} className="flex flex-wrap items-baseline gap-x-3 py-2 text-sm">
                <a
                  href={s.sourceUrl ?? "#"}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-4"
                >
                  {s.source ?? "source"}
                </a>
                {typeof s.value === "number" && (
                  <span className="text-muted-foreground">{fmt(s.value)}</span>
                )}
                {s.observedAt && (
                  <span className="mono-label ml-auto">{formatDateTime(s.observedAt)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export type { WindowChange };
