import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Loader2, Lock, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  createRadar,
  getSweepStatus,
  interpretRadarRequest,
  runRadarNow,
} from "@/lib/radar.functions";
import { completeOnboarding, getOnboardingState } from "@/lib/onboarding.functions";
import { AlertCard, type AlertRow } from "@/components/alert-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RadarMark, Wordmark } from "@/components/radar-mark";
import { asConfig, frequencyToMinutes, type RadarConfig, type RadarFrequency } from "@/lib/radar-types";
import type { MonitoringWindow } from "@/lib/monitoring/temporal";
import { track } from "@/lib/analytics";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({
    meta: [
      { title: "Get started — Radar" },
      {
        name: "description",
        content: "Tell Radar what to watch for and it monitors the web on your behalf.",
      },
      { property: "og:title", content: "Get started — Radar" },
      {
        property: "og:description",
        content: "Create your first Radar in under a minute — cars, watches, property, markets.",
      },
    ],
  }),
  component: Onboarding,
});

const heroExamples = [
  { emoji: "🚗", text: "Find a black BMW M340i, 2022 or newer, under 600,000 SEK." },
  { emoji: "⌚", text: "Find a Rolex Submariner below market price." },
  { emoji: "📈", text: "Keep me updated on major NVIDIA news and events." },
];

const rotatingPlaceholders = [
  "Find a black BMW M340i from 2022 or newer under 600,000 SEK.",
  "Tell me when NVIDIA has major news that could affect the stock.",
  "Find Rolex Submariners priced unusually low compared with similar watches.",
  "Find a 2-bedroom apartment in central Stockholm under 5 million SEK.",
  "Find business-class flights from Stockholm to Dubai under 15,000 SEK.",
];

const inspiration: { label: string; example: string }[] = [
  { label: "Cars", example: "Find a black BMW M340i from 2022 or newer under 600,000 SEK." },
  { label: "Watches", example: "Find Rolex Submariners priced unusually low compared with similar watches." },
  { label: "Investments", example: "Tell me when NVIDIA has major news that could affect the stock." },
  { label: "Travel", example: "Find business-class flights from Stockholm to Dubai under 15,000 SEK." },
  { label: "Real estate", example: "Find a 2-bedroom apartment in central Stockholm under 5 million SEK." },
  { label: "Products", example: "Tell me when the Sony WH-1000XM5 drops below 2,500 SEK anywhere in Sweden." },
  { label: "Companies", example: "Keep me updated on funding rounds and leadership changes at Klarna." },
  { label: "Something else", example: "Let me know when tickets for the next Formula 1 race in Monaco go on sale." },
];

const frequencyChoices: { value: RadarFrequency; label: string; hint: string }[] = [
  { value: "daily", label: "Daily", hint: "One check every day" },
  { value: "smart", label: "Every few hours", hint: "Roughly every 6 hours" },
  { value: "instant", label: "Every hour", hint: "Fastest available" },
];

const sweepProgress = [
  "Searching the web…",
  "Checking relevant sources…",
  "Comparing what we found…",
  "Evaluating potential matches…",
];

type Step =
  | "intro"
  | "describe"
  | "interpreting"
  | "confirm"
  | "creating"
  | "sweeping"
  | "result"
  | "notify";

function Onboarding() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const loadState = useServerFn(getOnboardingState);
  const interpret = useServerFn(interpretRadarRequest);
  const createRadarFn = useServerFn(createRadar);
  const runSweep = useServerFn(runRadarNow);
  const sweepStatus = useServerFn(getSweepStatus);
  const finish = useServerFn(completeOnboarding);

  const [state, setState] = useState<Awaited<ReturnType<typeof getOnboardingState>> | null>(null);
  const [step, setStep] = useState<Step>("intro");
  const [request, setRequest] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("general");
  const [monitoringWindow, setMonitoringWindow] = useState<MonitoringWindow>("rolling");
  const [recencyDays, setRecencyDays] = useState(30);
  const [config, setConfig] = useState<RadarConfig | null>(null);
  const [frequency, setFrequency] = useState<RadarFrequency>("daily");
  const [radarId, setRadarId] = useState<string | null>(null);
  const [interpretPhase, setInterpretPhase] = useState(0);
  const [sweepPhase, setSweepPhase] = useState(0);
  const [alert, setAlert] = useState<AlertRow | null>(null);
  const [sweepFailed, setSweepFailed] = useState(false);
  const [listingsFound, setListingsFound] = useState(0);
  const [notify, setNotify] = useState<"in_app" | "email" | "both">("both");
  const [busy, setBusy] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadState({}).then((s) => {
      if (cancelled) return;
      setState(s);
      if (s.onboardingDone || s.radarCount > 0) {
        navigate({ to: "/dashboard", replace: true });
        return;
      }
      if (!started.current) {
        started.current = true;
        void track("onboarding_started");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadState, navigate]);

  useEffect(() => {
    const t = window.setInterval(
      () => setPlaceholderIndex((i) => (i + 1) % rotatingPlaceholders.length),
      3500,
    );
    return () => window.clearInterval(t);
  }, []);

  /**
   * Polls the persisted monitor_run row until the sweep really finishes.
   * Only the run row decides success or failure — never a dropped request.
   */
  const waitForSweep = async (
    id: string,
    since: string,
  ): Promise<"completed" | "failed"> => {
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const status = await sweepStatus({ data: { radarId: id, since } });
        if (status.state === "completed") return "completed";
        if (status.state === "failed") return "failed";
      } catch {
        // transient network error while polling — keep waiting
      }
    }
    return "failed";
  };


  const skip = async () => {
    await track("onboarding_skipped");
    await finish({ data: {} }).catch(() => undefined);
    navigate({ to: "/dashboard", replace: true });
  };

  const analyze = async () => {
    setStep("interpreting");
    setInterpretPhase(0);
    const phases = window.setInterval(() => setInterpretPhase((p) => Math.min(p + 1, 2)), 1800);
    try {
      await track("first_radar_prompt_submitted");
      const result = await interpret({ data: { request } });
      const parsed = asConfig(result.config);
      if (!parsed.target && (parsed.search_queries ?? []).length === 0) {
        throw new Error("Radar couldn't confidently understand that request.");
      }
      setConfig(parsed);
      setName(result.name || parsed.target || request.slice(0, 60));
      setCategory(result.category || "general");
      if (result.monitoring_window) setMonitoringWindow(result.monitoring_window);
      if (result.recency_days) setRecencyDays(result.recency_days);
      await track("radar_interpretation_completed", { category: result.category });
      setStep("confirm");
    } catch {
      toast.error("Radar couldn't confidently understand that request. Try describing it again.");
      setStep("describe");
    } finally {
      window.clearInterval(phases);
    }
  };

  const start = async () => {
    if (!config) return;
    setBusy(true);
    setStep("creating");
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
      setRadarId(created.id);
      await track("radar_created", { category, frequency, source: "onboarding" });
      queryClient.invalidateQueries();
      setStep("sweeping");
      setSweepPhase(0);
      const phases = window.setInterval(
        () => setSweepPhase((p) => Math.min(p + 1, sweepProgress.length - 1)),
        4000,
      );
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      try {
        // A full first sweep can run for minutes, so the server hands back
        // "running" and the persisted monitor_run row is the source of truth.
        // A dropped request is NOT a failed sweep — only the run row decides.
        let outcome = await runSweep({ data: { radarId: created.id } }).catch(
          () => ({ state: "running" as const, startedAt }),
        );
        let succeeded = outcome.state === "completed";
        if (!succeeded) {
          const since = "startedAt" in outcome ? outcome.startedAt : startedAt;
          const final = await waitForSweep(created.id, since);
          succeeded = final === "completed";
        }
        if (!succeeded) {
          setSweepFailed(true);
        } else {
          await track("first_sweep_completed");
          const { count } = await supabase
            .from("findings")
            .select("id", { count: "exact", head: true })
            .eq("radar_id", created.id);
          setListingsFound(count ?? 0);
          const { data: alerts } = await supabase
            .from("alerts")
            .select("*")
            .eq("radar_id", created.id)
            .order("created_at", { ascending: false })
            .limit(1);
          const strongest = (alerts?.[0] ?? null) as AlertRow | null;
          setAlert(strongest);
          if (strongest) await track("first_alert_seen", { alert_id: strongest.id });
        }
      } catch {
        setSweepFailed(true);
      } finally {
        window.clearInterval(phases);
      }
      setStep("result");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create radar.");
      setStep("confirm");
    } finally {
      setBusy(false);
    }
  };

  const complete = async (destination: "radar" | "another") => {
    setBusy(true);
    try {
      await finish({ data: { notificationEmail: notify !== "in_app" } });
      await track("onboarding_completed", { destination });
    } catch {
      // never block the user on a preference write
    } finally {
      setBusy(false);
    }
    if (destination === "another") navigate({ to: "/radars/new" });
    else if (radarId) navigate({ to: "/radars/$radarId", params: { radarId } });
    else navigate({ to: "/dashboard" });
  };

  if (!state) {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <p className="text-sm">Preparing your Radar…</p>
        </div>
      </Screen>
    );
  }

  if (state.atRadarLimit) {
    return (
      <Screen>
        <div className="w-full max-w-md text-center">
          <RadarMark className="mx-auto size-12" />
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">
            You've reached your {state.planName} plan limit.
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Your plan includes {state.maxRadars} active radars. Nothing was changed or removed.
          </p>
          <div className="mt-8 space-y-3">
            <Button
              className="h-12 w-full text-base"
              onClick={async () => {
                await track("upgrade_clicked", { source: "onboarding_limit" });
                navigate({ to: "/billing" });
              }}
            >
              Upgrade to Pro
            </Button>
            <Button variant="ghost" className="h-12 w-full" onClick={() => navigate({ to: "/dashboard" })}>
              Back to dashboard
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  /* ---------------------------------------------------------------- screens */

  if (step === "intro") {
    return (
      <Screen>
        <div className="w-full max-w-md">
          <Wordmark />
          <h1 className="mt-8 text-3xl font-semibold leading-tight tracking-tight">
            Tell Radar what you're looking for.
          </h1>
          <p className="mt-3 text-base text-muted-foreground">
            Radar continuously monitors the web for you and alerts you when something worth knowing
            appears.
          </p>

          <ul className="mt-8 space-y-3">
            {heroExamples.map((e) => (
              <li key={e.text} className="panel flex items-start gap-3 p-4 text-sm">
                <span className="text-lg leading-none">{e.emoji}</span>
                <span className="text-muted-foreground">{e.text}</span>
              </li>
            ))}
          </ul>

          <p className="mt-5 text-xs text-muted-foreground">
            Cars, watches, property, investments, travel, products, companies — if it's on the web,
            Radar can monitor it.
          </p>

          <div className="mt-8 space-y-3">
            <Button className="h-12 w-full text-base" onClick={() => setStep("describe")}>
              Create my first Radar
            </Button>
            <Button variant="ghost" className="h-12 w-full" onClick={skip}>
              Skip for now
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  if (step === "describe") {
    return (
      <Screen>
        <div className="w-full max-w-md">
          <BackButton onClick={() => setStep("intro")} />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">What should Radar watch for?</h1>
          <Textarea
            autoFocus
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={5}
            placeholder="Describe what you're looking for in your own words..."
            className="mt-5 resize-none text-base"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            e.g. “{rotatingPlaceholders[placeholderIndex]}”
          </p>

          <p className="mono-label mt-6">Need inspiration?</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {inspiration.map((i) => (
              <button
                key={i.label}
                onClick={() => setRequest(i.example)}
                className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {i.label}
              </button>
            ))}
          </div>

          <Button
            className="mt-8 h-12 w-full gap-2 text-base"
            disabled={request.trim().length < 8}
            onClick={analyze}
          >
            <Sparkles className="size-4" />
            Continue
          </Button>
        </div>
      </Screen>
    );
  }

  if (step === "interpreting" || step === "creating") {
    const messages =
      step === "creating"
        ? ["Building your Radar…"]
        : ["Understanding what you want…", "Building your Radar…", "Checking the web…"];
    return (
      <Screen>
        <div className="flex w-full max-w-md flex-col items-center text-center">
          <RadarMark className="size-12" />
          <p className="mt-6 text-base">{messages[Math.min(interpretPhase, messages.length - 1)]}</p>
          <p className="mt-2 text-sm text-muted-foreground">This usually takes a few seconds.</p>
        </div>
      </Screen>
    );
  }

  if (step === "confirm" && config) {
    const understood = summarize(config);
    return (
      <Screen>
        <div className="w-full max-w-md">
          <BackButton onClick={() => setStep("describe")} label="Edit" />
          <p className="mono-label mt-4">You asked for</p>
          <p className="mt-1 text-sm text-muted-foreground">“{request}”</p>

          <p className="mono-label mt-6">Radar understood</p>
          <ul className="mt-3 space-y-2">
            {understood.map((line) => (
              <li key={line} className="panel px-4 py-3 text-sm">
                {line}
              </li>
            ))}
          </ul>

          <p className="mt-7 text-sm font-medium">How often should Radar check?</p>
          <div className="mt-3 space-y-2">
            {frequencyChoices.map((choice) => {
              const locked = frequencyToMinutes(choice.value) < state.minIntervalMinutes;
              const selected = frequency === choice.value;
              return (
                <button
                  key={choice.value}
                  disabled={locked}
                  onClick={() => setFrequency(choice.value)}
                  className={[
                    "flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors",
                    selected && !locked ? "border-primary bg-primary/5" : "border-border",
                    locked ? "opacity-60" : "hover:border-primary/60",
                  ].join(" ")}
                >
                  <span>
                    <span className="block text-sm font-medium">{choice.label}</span>
                    <span className="block text-xs text-muted-foreground">{choice.hint}</span>
                  </span>
                  {locked ? (
                    <span className="mono-label flex items-center gap-1.5">
                      <Lock className="size-3" />
                      {choice.value === "instant" ? "Available with Pro+" : "Available with Pro"}
                    </span>
                  ) : (
                    selected && <Check className="size-4 text-primary" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-8 space-y-3">
            <Button className="h-12 w-full text-base" disabled={busy} onClick={start}>
              Start Radar
            </Button>
            <Button variant="ghost" className="h-12 w-full" onClick={() => setStep("describe")}>
              Edit
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  if (step === "sweeping") {
    return (
      <Screen>
        <div className="flex w-full max-w-md flex-col items-center text-center">
          <RadarMark className="size-12" />
          <h1 className="mt-6 text-xl font-semibold">Radar is searching…</h1>
          <p className="mt-2 text-sm text-muted-foreground">{sweepProgress[sweepPhase]}</p>
          <p className="mt-6 text-xs text-muted-foreground">
            The first run is a full market scan — it lists everything matching right now instead of
            alerting you just because the Radar is new.
          </p>
        </div>
      </Screen>
    );
  }

  if (step === "result") {
    return (
      <Screen>
        <div className="w-full max-w-md">
          {sweepFailed ? (
            <>
              <h1 className="text-xl font-semibold">Radar couldn't complete the first check.</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                We'll try again automatically. Your Radar is saved and active.
              </p>
            </>
          ) : alert ? (
            <>
              <h1 className="text-xl font-semibold">Radar found something.</h1>
              <div className="mt-4">
                <AlertCard alert={alert} radarName={name} />
              </div>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">
                Found {listingsFound} matching listing{listingsFound === 1 ? "" : "s"} right now.
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Radar is now monitoring the market for new listings and changes. You'll only get an
                alert when something genuinely meets your criteria.
              </p>
            </>
          )}

          <div className="panel mt-6 p-5">
            <p className="text-sm font-medium">Radar is now watching for you.</p>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              {[
                "Radar keeps checking automatically",
                "It evaluates new information and changes",
                "You'll only receive an alert when something meets your criteria",
              ].map((line) => (
                <li key={line} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  {line}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm">You don't need to keep searching yourself.</p>
          </div>

          <Button className="mt-8 h-12 w-full text-base" onClick={() => setStep("notify")}>
            Continue
          </Button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <div className="w-full max-w-md">
        <h1 className="text-xl font-semibold">How do you want to hear from Radar?</h1>
        <div className="mt-5 space-y-2">
          {(
            [
              { value: "in_app", label: "In-app notifications", hint: "Alerts appear in your Radar inbox" },
              { value: "email", label: "Email", hint: "Important findings sent to your inbox" },
              { value: "both", label: "Both", hint: "In-app and email" },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              onClick={() => setNotify(option.value)}
              className={[
                "flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors",
                notify === option.value ? "border-primary bg-primary/5" : "border-border hover:border-primary/60",
              ].join(" ")}
            >
              <span>
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              </span>
              {notify === option.value && <Check className="size-4 text-primary" />}
            </button>
          ))}
        </div>

        <div className="mt-8 space-y-3">
          <Button className="h-12 w-full text-base" disabled={busy} onClick={() => complete("radar")}>
            Go to my Radar
          </Button>
          <Button
            variant="ghost"
            className="h-12 w-full"
            disabled={busy}
            onClick={() => complete("another")}
          >
            Create another Radar
          </Button>
        </div>
      </div>
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-10">{children}</div>
  );
}

function BackButton({ onClick, label = "Back" }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="mono-label inline-flex items-center gap-1.5 hover:text-foreground"
    >
      <ArrowLeft className="size-3" />
      {label}
    </button>
  );
}

/** Plain-language summary of what the existing interpreter returned. */
function summarize(config: RadarConfig): string[] {
  const lines: string[] = [];
  if (config.target) lines.push(`🎯 ${config.target}`);
  if (config.price_min !== null || config.price_max !== null) {
    const currency = config.currency ?? "";
    const range =
      config.price_min !== null && config.price_max !== null
        ? `${config.price_min.toLocaleString()} – ${config.price_max.toLocaleString()}`
        : config.price_max !== null
          ? `≤ ${config.price_max.toLocaleString()}`
          : `≥ ${config.price_min!.toLocaleString()}`;
    lines.push(`💰 ${range} ${currency}`.trim());
  }
  if (config.time_period) lines.push(`📅 ${config.time_period}`);
  if (config.locations.length) lines.push(`📍 ${config.locations.join(", ")}`);
  for (const criterion of config.important_criteria.slice(0, 3)) lines.push(`✓ ${criterion}`);
  if (lines.length === 0 && config.interpretation) lines.push(config.interpretation);
  return lines;
}
