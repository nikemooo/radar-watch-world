import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { createRadar, interpretRadarRequest } from "@/lib/radar.functions";
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
  recencyPresets,
  type RadarConfig,
  type RadarFrequency,
} from "@/lib/radar-types";
import { monitoringWindowLabel, type MonitoringWindow } from "@/lib/monitoring/temporal";
import { track } from "@/lib/analytics";

export const Route = createFileRoute("/_authenticated/radars/new")({
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
];

function NewRadar() {
  const navigate = useNavigate();
  const interpret = useServerFn(interpretRadarRequest);
  const createRadarFn = useServerFn(createRadar);
  const [request, setRequest] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("general");
  const [frequency, setFrequency] = useState<RadarFrequency>("smart");
  const [monitoringWindow, setMonitoringWindow] = useState<MonitoringWindow>("rolling");
  const [recencyDays, setRecencyDays] = useState(30);
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
      toast.error(error instanceof Error ? error.message : "Could not interpret that request.");
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
          config,
        },
      });
      await track("radar_created", { category, frequency });
      toast.success("Radar created. The first sweep records a baseline — no alerts yet.");
      navigate({ to: "/radars/$radarId", params: { radarId: created.id } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create radar.");
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
            Edit request
          </button>
        )}
        <p className="mono-label">Step {step === "describe" ? "1" : "2"} of 2</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {step === "describe" ? "What should Radar watch?" : "Confirm the watch"}
        </h1>
      </header>

      {step === "describe" ? (
        <div className="panel space-y-4 p-5">
          <Textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={4}
            placeholder="Describe it the way you'd tell a person…"
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
            {busy ? "Interpreting…" : "Interpret request"}
          </Button>
        </div>
      ) : (
        config && (
          <div className="space-y-5">
            <div className="panel space-y-4 p-5">
              <p className="text-sm text-muted-foreground">{config.interpretation}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="radar-name">Radar name</Label>
                  <Input id="radar-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Check frequency</Label>
                  <Select value={frequency} onValueChange={(v) => setFrequency(v as RadarFrequency)}>
                    <SelectTrigger>
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
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Monitoring window</Label>
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
                          {monitoringWindowLabel[key]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>How recent must information be?</Label>
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

            <div className="panel grid gap-5 p-5 sm:grid-cols-2">
              <Facts title="Watching for" items={config.monitored_events} />
              <Facts title="Matters most" items={config.important_criteria} />
              <Facts title="Search strategy" items={config.search_queries} />
              <Facts title="Excluding" items={config.exclusions} />
              {config.locations.length > 0 && <Facts title="Locations" items={config.locations} />}
              {(config.price_min !== null || config.price_max !== null) && (
                <Facts
                  title="Price range"
                  items={[
                    `${config.price_min ?? "any"} – ${config.price_max ?? "any"} ${config.currency ?? ""}`.trim(),
                  ]}
                />
              )}
            </div>

            <Button onClick={create} disabled={busy} className="w-full gap-2">
              {busy && <Loader2 className="size-4 animate-spin" />}
              Activate radar
            </Button>
          </div>
        )
      )}
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
