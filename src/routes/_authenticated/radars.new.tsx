import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { createRadar, interpretRadarRequest, runRadarNow } from "@/lib/radar.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  asConfig,
  frequencyLabel,
  radarModeLabel,
  recencyPresets,
  type RadarConfig,
  type RadarFrequency,
  type RadarMode,
  type RadarStart,
} from "@/lib/radar-types";
import { OPERATOR_LABEL, type MarketMonitorSpec } from "@/lib/market/types";
import { monitoringWindowLabel, type MonitoringWindow } from "@/lib/monitoring/temporal";
import { track } from "@/lib/analytics";
import { useFormatDateTime, useT, type TranslationKey } from "@/lib/i18n";


export const Route = createFileRoute("/_authenticated/radars/new")({
  // The home screen can hand over a natural-language request directly.
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search["q"] === "string" && search["q"].trim() ? (search["q"] as string) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "New radar — Radar" },
      { name: "description", content: "Describe what you want monitored and Radar builds the watch." },
      { property: "og:title", content: "New radar — Radar" },
      { property: "og:description", content: "Describe what you want monitored in plain language." },
    ],
  }),
  component: NewRadar,
});

const suggestions = [
  "Find me a black BMW M340i under 450,000 SEK in Sweden",
  "Tell me when anything material happens to Tesla stock",
  "Watch for remote senior React roles paying over $150k",
  "Alert me if flights from London to Tokyo drop below £600 in March",
  "Alert me if USD/EUR drops 5% from today's level",
  "Track the gold price and alert me under $2,000 per ounce",
];

function NewRadar() {
  const navigate = useNavigate();
  const { q } = Route.useSearch();
  const t = useT();
  const formatDateTime = useFormatDateTime();
  const interpret = useServerFn(interpretRadarRequest);
  const createRadarFn = useServerFn(createRadar);
  const startSweep = useServerFn(runRadarNow);
  const [request, setRequest] = useState(q ?? "");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("general");
  const [frequency, setFrequency] = useState<RadarFrequency>("smart");
  const [monitoringWindow, setMonitoringWindow] = useState<MonitoringWindow>("rolling");
  const [recencyDays, setRecencyDays] = useState(30);
  const [mode, setMode] = useState<RadarMode>("find_and_watch");
  const [start, setStart] = useState<RadarStart>("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [config, setConfig] = useState<RadarConfig | null>(null);
  const [step, setStep] = useState<"describe" | "confirm">("describe");
  const [busy, setBusy] = useState(false);

  const analyze = async () => {
    setBusy(true);
    try {
      const result = await interpret({ data: { request } });
      const parsed = asConfig(result.config);
      setConfig(parsed);
      setName(result.name || parsed.target || request.slice(0, 60));
      setCategory(result.category || "general");
      if (result.suggested_frequency) setFrequency(result.suggested_frequency);
      if (result.monitoring_window) setMonitoringWindow(result.monitoring_window);
      if (result.recency_days) setRecencyDays(result.recency_days);
      setStep("confirm");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("new.interpretFailed"));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!config) return;
    setBusy(true);
    try {
      const created = await createRadarFn({
        data: {
          name,
          category,
          frequency,
          raw_request: request,
          monitoring_window: monitoringWindow,
          recency_days: recencyDays,
          mode,
          start,
          scheduled_start_at: start === "scheduled" && scheduledAt ? new Date(scheduledAt).toISOString() : null,
          config,
        },
      });
      await track("radar_created", { category, frequency });
      if (start === "now") {
        // The server already claimed the first sweep during creation. Only ask
        // for one here if that did not happen, so we never start it twice.
        if (!created.started) startSweep({ data: { radarId: created.id } }).catch(() => undefined);
        toast.success(t("new.createdNow"));
      } else if (start === "scheduled") {
        toast.success(t("new.createdScheduled", { time: formatDateTime(scheduledAt) }));
      } else {
        toast.success(t("new.createdManual"));
      }
      navigate({ to: "/radars/$radarId", params: { radarId: created.id } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("new.createFailed"));
    } finally {
      setBusy(false);
    }
  };


  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header>
        {step === "confirm" && (
          <button
            className="mono-label mb-3 inline-flex items-center gap-1.5 hover:text-foreground"
            onClick={() => setStep("describe")}
          >
            <ArrowLeft className="size-3" />
            {t("new.editRequest")}
          </button>
        )}
        <p className="mono-label">{t("new.step", { step: step === "describe" ? 1 : 2 })}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {step === "describe" ? t("new.titleDescribe") : t("new.titleConfirm")}
        </h1>
      </header>

      {step === "describe" ? (
        <div className="panel space-y-4 p-5">
          <Textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={4}
            placeholder={t("new.placeholder")}
            className="resize-none text-base"
          />
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => setRequest(s)}
                className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
          <Button onClick={analyze} disabled={busy || request.trim().length < 8} className="w-full gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {busy ? t("new.interpreting") : t("new.interpret")}
          </Button>
        </div>
      ) : (
        config && (
          <div className="space-y-5">
            <div className="panel space-y-4 p-5">
              <p className="mono-label">
                {t(config.kind === "market_monitoring" ? "new.kindBadge.market" : "new.kindBadge.product")}
              </p>
              <p className="text-sm text-muted-foreground">{config.interpretation}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="radar-name">{t("new.name")}</Label>
                  <Input id="radar-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("new.frequency")}</Label>
                  <Select value={frequency} onValueChange={(v) => setFrequency(v as RadarFrequency)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(frequencyLabel) as RadarFrequency[]).map((key) => (
                        <SelectItem key={key} value={key}>
                          {t(`freq.${key}` as TranslationKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t("new.window")}</Label>
                  <Select
                    value={monitoringWindow}
                    onValueChange={(v) => setMonitoringWindow(v as MonitoringWindow)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(monitoringWindowLabel) as MonitoringWindow[]).map((key) => (
                        <SelectItem key={key} value={key}>
                          {t(`window.${key}` as TranslationKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("new.recency")}</Label>
                  <Select value={String(recencyDays)} onValueChange={(v) => setRecencyDays(Number(v))}>
                    <SelectTrigger>
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
                  <p className="text-xs text-muted-foreground">
                    Radar suggested {recencyDays} days for this subject. Older information is kept as
                    history but never alerted as new.
                  </p>
                </div>
              </div>
            </div>

            {config.kind === "market_monitoring" && config.market && (
              <MarketConfirm spec={config.market} />
            )}

            <div className="panel space-y-5 p-5">
              {config.kind === "product_discovery" && (
              <div className="space-y-2">
                <Label>{t("new.mode")}</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(Object.keys(radarModeLabel) as RadarMode[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setMode(key)}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        mode === key ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30"
                      }`}
                    >
                      <p className="text-sm font-medium">{t(`mode.${key}` as TranslationKey)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{t(`mode.${key}.desc` as TranslationKey)}</p>
                    </button>
                  ))}
                </div>
              </div>
              )}

              <div className="space-y-2">
                <Label>{t("new.startWhen")}</Label>
                <div className="grid gap-2 sm:grid-cols-3">
                  {(
                    [
                      ["now", t("new.start.now")],
                      ["scheduled", t("new.start.scheduled")],
                      ["manual", t("new.start.manual")],
                    ] as [RadarStart, string][]
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setStart(key)}
                      className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                        start === key ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {start === "scheduled" && (
                  <div className="space-y-1.5 pt-1">
                    <Label htmlFor="scheduled-at">{t("new.startAt")}</Label>
                    <Input
                      id="scheduled-at"
                      type="datetime-local"
                      value={scheduledAt}
                      onChange={(e) => setScheduledAt(e.target.value)}
                    />
                  </div>
                )}
              </div>
            </div>



            <div className="panel grid gap-5 p-5 sm:grid-cols-2">
              <Facts title={t("new.facts.watching")} items={config.monitored_events} />
              <Facts title={t("new.facts.important")} items={config.important_criteria} />
              <Facts title={t("new.facts.strategy")} items={config.search_queries} />
              <Facts title={t("new.facts.excluding")} items={config.exclusions} />
              {config.locations.length > 0 && <Facts title={t("new.facts.locations")} items={config.locations} />}
              {(config.price_min !== null || config.price_max !== null) && (
                <Facts
                  title={t("new.facts.priceRange")}
                  items={[
                    `${config.price_min ?? t("new.any")} – ${config.price_max ?? t("new.any")} ${config.currency ?? ""}`.trim(),
                  ]}
                />
              )}
            </div>

            <Button
              onClick={create}
              disabled={busy || (start === "scheduled" && !scheduledAt)}
              className="w-full gap-2"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {start === "now" ? t("new.activateAndSearch") : t("new.activate")}

            </Button>
          </div>
        )
      )}
    </div>
  );
}

function MarketConfirm({ spec }: { spec: MarketMonitorSpec }) {
  const t = useT();
  const inst = spec.instrument;
  return (
    <div className="panel space-y-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="mono-label">{t("new.kindBadge.market")}</p>
        <p className="mono-label">{inst.kind}</p>
      </div>
      <div>
        <p className="text-lg font-medium">{inst.symbol}</p>
        <p className="text-sm text-muted-foreground">
          {inst.name} · {inst.metric.replace(/_/g, " ")}
        </p>
      </div>
      <div>
        <p className="mono-label">{t("new.market.rules")}</p>
        {spec.rules.length > 0 ? (
          <ul className="mt-2 space-y-1.5 text-sm">
            {spec.rules.map((rule) => (
              <li key={rule.id} className="flex gap-2 text-muted-foreground">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
                {rule.label ||
                  (rule.type === "threshold"
                    ? `${OPERATOR_LABEL[rule.operator]} ${rule.value}`
                    : `${rule.direction} ${rule.pct}% (${rule.window})`)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">{t("new.market.noRules")}</p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("new.market.sourceHint")}</p>
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
