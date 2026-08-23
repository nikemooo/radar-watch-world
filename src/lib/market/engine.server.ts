/**
 * Market Monitoring engine — the second pillar of Radar, fully separate from
 * the Product Discovery engine.
 *
 * Instead of hunting listings across marketplaces, one cycle here:
 *
 *   1. resolving_instrument   — maps the request onto structured data sources
 *                               (Stooq / Frankfurter / CoinGecko), once per
 *                               radar, persisted in the radar config.
 *   2. collecting_observations — fetches the current value from every
 *                               applicable source (web search only as
 *                               fallback), verifies them against each other,
 *                               and persists one market_observations row.
 *   3. evaluating_rules       — compares against history (24h / 7d / 30d /
 *                               baseline) and fires edge-triggered rule alerts.
 *   4. persisting_results     — closes the run and schedules the next sweep.
 *
 * The cycle is checkpointed and time-sliced exactly like the product engine,
 * so a serverless worker cutoff mid-run resumes where it stopped.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { asConfig } from "../radar-types";
import { beginRun, type RunClaim, type RunOptions, type RunResult } from "../monitoring/engine.server";
import { startRunHeartbeat, type RunTracker } from "../monitoring/heartbeat.server";
import { createCheckpointStore, type CheckpointStore } from "../monitoring/checkpoints.server";
import { SweepPaused } from "../monitoring/slice";
import { computeNextRunAt } from "../monitoring/schedule";
import type { RunPhase } from "../monitoring/lifecycle";
import { asMarketSpec } from "./types";
import { collectMarketQuotes, consensusFromQuotes, refineInstrumentSources } from "./sources.server";
import { computeMarketChanges, type MarketPoint } from "./history";
import { describeTrigger, evaluateMarketRules, type MarketRuleStateMap } from "./rules";

type Db = SupabaseClient<Database>;
type RadarRow = Database["public"]["Tables"]["radars"]["Row"];
type RunUpdate = Database["public"]["Tables"]["monitor_runs"]["Update"];

function formatValue(value: number): string {
  if (Math.abs(value) >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return Number(value.toPrecision(4)).toString();
}

export async function runMarketCycle(
  db: Db,
  radar: RadarRow,
  options: RunOptions = {},
): Promise<RunResult> {
  const config = asConfig(radar.config);
  const configured = asMarketSpec(config.market);
  if (!configured) throw new Error("This radar has no market instrument configured.");

  const isBaseline = !radar.baseline_completed;
  const runType = isBaseline ? "baseline" : "incremental";
  const alertBudget = options.alertBudget ?? null;

  const claim: RunClaim =
    options.runId != null
      ? {
          runId: options.runId,
          startedAt: options.startedAt ?? new Date().toISOString(),
          runType,
          scanPhase: isBaseline ? "initial_scan" : "monitoring",
        }
      : await beginRun(db, radar);
  const runId = claim.runId;
  const ownsTracker = !options.tracker;
  const tracker: RunTracker = options.tracker ?? startRunHeartbeat(db, runId);
  const checkpoints: CheckpointStore =
    options.checkpoints ?? createCheckpointStore(db, runId, radar.user_id, radar.id);

  let currentPhase: RunPhase = "initializing";
  const phase = (name: RunPhase, patch?: RunUpdate) => {
    currentPhase = name;
    return tracker.phase(name, { phase_started_at: new Date().toISOString(), ...patch });
  };

  const deadlineAt = options.deadlineAt ?? null;
  let paused = false;
  const patchRun = async (patch: RunUpdate) => {
    if (!runId) return;
    await db
      .from("monitor_runs")
      .update({ ...patch, heartbeat_at: new Date().toISOString() })
      .eq("id", runId);
  };
  const step = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const resumedBefore = checkpoints.resumedSteps;
    const value = await checkpoints.step(key, fn, { phase: currentPhase });
    const fresh = checkpoints.resumedSteps === resumedBefore;
    if (fresh) await patchRun({ last_successful_operation: key });
    if (fresh && deadlineAt !== null && Date.now() > deadlineAt) {
      paused = true;
      throw new SweepPaused(currentPhase, key);
    }
    return value;
  };

  try {
    if (runId) {
      await db
        .from("monitor_runs")
        .update({
          worker_started_at: new Date().toISOString(),
          heartbeat_at: new Date().toISOString(),
          ...(options.continuation
            ? {}
            : { continuation_count: 0, attempt: 1, worker_finished_at: null }),
        })
        .eq("id", runId);
    }

    // 1. Instrument → structured sources (one AI call, ever, per radar).
    await phase("resolving_instrument");
    const spec = await step("market:instrument", async () => {
      const refined = await refineInstrumentSources(configured);
      if (refined !== configured) {
        await db
          .from("radars")
          .update({ config: { ...config, kind: "market_monitoring", market: refined } as never })
          .eq("id", radar.id);
      }
      return refined;
    });

    // 2. Collect + verify the current datapoint.
    await phase("collecting_observations");
    const collection = await step("market:quotes", () =>
      collectMarketQuotes(spec, { allowWebSearch: true, rawRequest: radar.raw_request }),
    );
    const consensus = consensusFromQuotes(collection.quotes);
    if (!consensus) {
      throw new Error(
        `No data source could provide a current ${spec.instrument.symbol} value (tried: ${
          collection.attempts.map((a) => a.source).join(", ") || "none"
        }). The next scheduled run retries automatically.`,
      );
    }
    const nowIso = new Date().toISOString();
    const observedAt = consensus.quotes
      .map((q) => q.observedAt)
      .sort()
      .at(-1)!;

    // 3. History BEFORE this point — window references for rules and UI.
    const { data: historyRows } = await db
      .from("market_observations")
      .select("value, observed_at")
      .eq("radar_id", radar.id)
      .eq("instrument", spec.instrument.symbol)
      .eq("metric", spec.instrument.metric)
      .order("observed_at", { ascending: true })
      .limit(1000);
    const historyPoints: MarketPoint[] = (historyRows ?? []).map((row) => ({
      t: row.observed_at,
      v: Number(row.value),
    }));
    const baselineValue = historyPoints[0]?.v ?? null;
    const points: MarketPoint[] = [...historyPoints, { t: observedAt, v: consensus.value }];
    const changes = computeMarketChanges(points);

    // 4. Persist the observation — idempotent per run.
    await step("market:observation", async () => {
      await db.from("market_observations").upsert(
        {
          radar_id: radar.id,
          user_id: radar.user_id,
          run_id: runId,
          instrument: spec.instrument.symbol,
          instrument_kind: spec.instrument.kind,
          metric: spec.instrument.metric,
          value: consensus.value,
          unit: spec.instrument.unit,
          currency: spec.instrument.currency ?? consensus.quote.currency,
          base_currency: spec.instrument.base_currency,
          quote_currency: spec.instrument.quote_currency,
          status: consensus.status,
          confidence: consensus.confidence,
          sources: consensus.quotes as never,
          metadata: {
            spread_pct: consensus.spreadPct,
            attempts: collection.attempts,
            run_type: runType,
          } as never,
          observed_at: observedAt,
          retrieved_at: nowIso,
        },
        { onConflict: "radar_id,run_id,instrument,metric", ignoreDuplicates: true },
      );
      return true;
    });

    // 5. Rules — edge-triggered so a breach alerts once, not every sweep.
    await phase("evaluating_rules");
    const memory = { ...((radar.memory ?? {}) as Record<string, unknown>) };
    const priorState = (memory["market_rules"] ?? {}) as MarketRuleStateMap;
    const evaluation = evaluateMarketRules(spec.rules, {
      current: consensus.value,
      baselineValue,
      changes,
      state: priorState,
      nowIso,
    });

    let alertsCreated = 0;
    // Baseline sweeps never alert — the first sweep only establishes history.
    if (!isBaseline) {
      for (const hit of evaluation.triggered) {
        if (alertBudget !== null && alertsCreated >= alertBudget) break;
        const { error: alertError } = await db.from("alerts").insert({
          radar_id: radar.id,
          user_id: radar.user_id,
          title: `${spec.instrument.symbol}: ${hit.rule.label}`,
          summary: describeTrigger(hit, spec.instrument.symbol, formatValue),
          what_changed:
            hit.rule.type === "pct_change" && hit.movePct !== null
              ? `${hit.movePct >= 0 ? "+" : ""}${hit.movePct.toFixed(2)}% move detected`
              : `Current value ${formatValue(hit.current)}`,
          why_it_matters: "One of your alert rules for this instrument fired.",
          importance: "important",
          confidence: consensus.confidence,
          sources: consensus.quotes.map((q) => ({ title: q.source, url: q.sourceUrl })) as never,
          event_type: "market_movement",
          status: "new",
          baseline: {
            instrument: spec.instrument.symbol,
            metric: spec.instrument.metric,
            value: consensus.value,
            reference: hit.reference,
            move_pct: hit.movePct,
            rule: hit.rule,
          } as never,
        });
        if (!alertError) alertsCreated += 1;
      }
    }

    // 6. Persist + schedule.
    await phase("persisting_results");
    const finishedAt = new Date().toISOString();
    const nextRunAt = computeNextRunAt(radar.frequency, finishedAt, radar.status);
    const marketMemory = { ...memory, market_rules: evaluation.nextState };
    await patchRun({
      status: "completed",
      current_phase: "completed",
      items_found: 1,
      new_items: 0,
      alerts_created: alertsCreated,
      sources_retrieved: consensus.quotes.length,
      search_requests: collection.searchRequests,
      search_successes: collection.searchSuccesses,
      search_failures: collection.searchFailures,
      cost_estimate: collection.costEstimate,
      provider: collection.provider,
      finished_at: finishedAt,
      worker_finished_at: finishedAt,
      termination_reason: "completed",
      ...(radar.baseline_completed ? {} : { first_useful_result_at: finishedAt }),
    });
    await db
      .from("radars")
      .update({
        last_run_at: finishedAt,
        next_run_at: nextRunAt,
        last_successful_sweep_at: finishedAt,
        memory: marketMemory as never,
        ...(isBaseline
          ? {
              baseline_completed: true,
              baseline_completed_at: finishedAt,
              scan_state: "MONITORING",
              initial_scan_completed_at: finishedAt,
              initial_listings_count: 1,
            }
          : {}),
      })
      .eq("id", radar.id);

    await phase("completed");

    return {
      status: "ok",
      runType,
      message: isBaseline
        ? `Baseline established — ${spec.instrument.symbol} is ${formatValue(consensus.value)} (${
            spec.instrument.currency ?? spec.instrument.unit ?? ""
          }). The radar now watches it and alerts when your rules fire.`
        : alertsCreated > 0
          ? `${alertsCreated} rule${alertsCreated === 1 ? "" : "s"} fired for ${spec.instrument.symbol}.`
          : undefined,
      itemsFound: 1,
      newItems: 0,
      alertsCreated,
      provider: collection.provider,
      sourcesRetrieved: consensus.quotes.length,
      costEstimate: collection.costEstimate,
    };
  } finally {
    if (ownsTracker) tracker.stop();
    // Release the radar lock — but a paused run keeps it so the tick resumes it.
    if (runId && !paused) {
      await db.from("radars").update({ active_run_id: null }).eq("id", radar.id).eq("active_run_id", runId);
    }
  }
}
