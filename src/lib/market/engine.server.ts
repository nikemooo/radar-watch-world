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
import { discoverImpactEvents, type KnownEvent } from "./events.server";
import { describeReactions } from "./reaction.server";
import { asNotifyLevels, impactLevel, shouldNotify } from "./impact";
import {
  alertDecision,
  asSeverity,
  asTimeline,
  importanceBand,
  MAX_EVENT_ALERTS_PER_RUN,
  sameStory,
  severityRank,
} from "./events";

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
    // A baseline sweep records the edge state but sends nothing, so it must
    // not leave a "last alerted" timestamp behind for rules already true.
    if (isBaseline) {
      for (const [id, state] of Object.entries(evaluation.nextState)) {
        evaluation.nextState[id] = { ...state, lastTriggeredAt: priorState[id]?.lastTriggeredAt ?? null };
      }
      for (const status of evaluation.statuses) {
        status.lastTriggeredAt = priorState[status.rule.id]?.lastTriggeredAt ?? null;
      }
    }

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

    // 5b. World events — what happened that could move this instrument.
    await phase("analyzing_events");
    let eventsDetected = 0;
    let eventsSignificant = 0;
    let eventCost = 0;
    try {
      const { data: knownRows } = await db
        .from("market_events")
        .select(
          "id, event_key, title, entities, event_type, published_at, severity, importance_score, sources, timeline, last_alerted_at, alert_count",
        )
        .eq("radar_id", radar.id)
        .order("last_updated_at", { ascending: false })
        .limit(200);
      const knownList = knownRows ?? [];
      const known: KnownEvent[] = knownList.map((row) => ({
        id: row.id,
        event_key: row.event_key,
        title: row.title,
        entities: row.entities ?? [],
        event_type: row.event_type ?? "other",
        published_at: row.published_at,
        severity: row.severity,
        importance_score: row.importance_score ?? 0,
        source_urls: (Array.isArray(row.sources) ? row.sources : [])
          .map((s) => (s && typeof s === "object" ? String((s as { url?: unknown }).url ?? "") : ""))
          .filter(Boolean),
      }));
      const knownById = new Map(knownList.map((row) => [row.id, row]));

      // Only look back as far as the previous sweep (7 days on a baseline):
      // the timeline collects history forward, it never backfills the past.
      const lastEventSweep =
        typeof memory["market_events_swept_at"] === "string"
          ? (memory["market_events_swept_at"] as string)
          : null;
      const sinceIso =
        lastEventSweep ?? new Date(Date.now() - 7 * 864e5).toISOString();

      const discovery = await step("market:events", () =>
        discoverImpactEvents({
          spec,
          rawRequest: radar.raw_request,
          sinceIso,
          known,
          points,
          language: config.language ?? "en",
        }),
      );
      eventCost = discovery.costEstimate;
      eventsDetected = discovery.events.length;

      // One situation, one notification: everything below is the alert layer's
      // memory of what the user has already been told during this sweep.
      const alertedStories: { title: string; entities: string[] }[] = [];
      let eventAlerts = 0;

      // Which likely-price-impact bands this radar is allowed to notify on.
      // Everything else is still stored and still shown on the timeline — the
      // user simply does not spend an alert on it.
      const notifyLevels = asNotifyLevels(radar.notify_impact_levels);

      // Rank before alerting: the per-run alert ceiling must spend itself on
      // the most important events, not on whichever was discovered first.
      const rankedEvents = [...discovery.events].sort((a, b) => b.importance - a.importance);

      for (const event of rankedEvents) {
        // The AI names updates it recognises; this deterministic fallback
        // catches the same story reported with different wording across runs,
        // so one happening stays ONE row instead of multiplying.
        const storyMatch =
          event.updateOf
            ? undefined
            : knownList.find((row) => {
                if (row.published_at && event.publishedAt) {
                  const days =
                    Math.abs(Date.parse(row.published_at) - Date.parse(event.publishedAt)) / 864e5;
                  if (days > 3) return false;
                }
                return sameStory(
                  { title: row.title, entities: row.entities ?? [], type: row.event_type as never },
                  { title: event.title, entities: event.entities, type: event.type },
                );
              });
        const previous = event.updateOf ? knownById.get(event.updateOf.id) : storyMatch;
        const decision = alertDecision({
          importance: event.importance,
          isBaseline,
          isNewEvent: !previous,
          isMaterialUpdate: event.materialUpdate,
          lastAlertedAt: previous?.last_alerted_at ?? null,
          nowIso,
          sensitivity: "balanced",
        });
        const budgetOk = alertBudget === null || alertsCreated < alertBudget;
        const impactOk = shouldNotify(event.importance, notifyLevels);
        if (event.importance >= 70) eventsSignificant += 1;
        const duplicateStory = alertedStories.some((story) =>
          sameStory(story, { title: event.title, entities: event.entities, type: event.type }),
        );

        let alerted = false;
        if (decision.alert && impactOk && budgetOk && !duplicateStory && eventAlerts < MAX_EVENT_ALERTS_PER_RUN) {
          const { error: eventAlertError } = await db.from("alerts").insert({
            radar_id: radar.id,
            user_id: radar.user_id,
            title: event.updateOf ? `Update: ${event.title}` : event.title,
            summary: event.factSummary,
            what_changed: event.updateOf
              ? event.updateNote || `New developments in an event already on your timeline.`
              : event.correlation.observed
                ? `${spec.instrument.symbol} ${
                    (event.correlation.changePct ?? 0) >= 0 ? "+" : ""
                  }${(event.correlation.changePct ?? 0).toFixed(2)}% observed around this event (coincidence, not causation)`
                : describeReactions(event.reactions) ??
                  `New ${event.severity} event detected for ${spec.instrument.symbol}`,
            why_it_matters: event.whatToWatch
              ? `${event.aiAnalysis}\n\nWhat to watch: ${event.whatToWatch}`
              : event.aiAnalysis,
            potential_impact: event.affectedAssets
              .map((a) => `${a.symbol} (${a.relation})`)
              .join(", ") || null,
            importance: importanceBand(event.importance),
            confidence: event.factConfidence,
            sources: event.sources.map((s) => ({
              title: s.title,
              url: s.url,
              publisher: s.publisher ?? undefined,
            })) as never,
            event_type: "world_event",
            status: "new",
            baseline: {
              instrument: spec.instrument.symbol,
              metric: spec.instrument.metric,
              value: consensus.value,
              event_key: event.key,
              severity: event.severity,
              importance: event.importance,
              correlation: event.correlation,
            } as never,
          });
          alerted = !eventAlertError;
          if (alerted) {
            alertsCreated += 1;
            eventAlerts += 1;
            alertedStories.push({ title: event.title, entities: event.entities });
          }
        }

        const timelineEntry = {
          at: nowIso,
          note: event.updateOf ? event.updateNote || "New coverage of this event." : event.factSummary,
          sourceCount: event.sources.length,
          importance: event.importance,
        };

        if (previous) {
          // One real-world event stays ONE row: updates extend it.
          const mergedSources = [...(Array.isArray(previous.sources) ? previous.sources : []), ...event.sources]
            .filter((s): s is { url: string } => Boolean(s) && typeof s === "object" && "url" in (s as object))
            .filter((s, i, arr) => arr.findIndex((o) => o.url === s.url) === i);
          const timeline = [...asTimeline(previous.timeline), timelineEntry].slice(-20);
          await db
            .from("market_events")
            .update({
              run_id: runId,
              title: event.title,
              fact_summary: event.factSummary,
              ai_analysis: event.aiAnalysis,
              severity:
                severityRank(event.severity) > severityRank(asSeverity(previous.severity))
                  ? event.severity
                  : previous.severity,
              relevance: event.relevance,
              confidence: event.factConfidence,
              fact_confidence: event.factConfidence,
              interpretation_confidence: event.interpretationConfidence,
              importance_score: Math.max(event.importance, previous.importance_score ?? 0),
              novelty_score: event.novelty,
              event_type: event.type,
              entities: event.entities,
              affected_assets: event.affectedAssets as never,
              timeline: timeline as never,
              categories: event.categories,
              sources: mergedSources as never,
              source_count: mergedSources.length,
              source_quality: event.sourceTier,
              market_value: consensus.value,
              market_change_pct: event.correlation.changePct,
              correlation: event.correlation as never,
              what_to_watch: event.whatToWatch || null,
              market_reactions: event.reactions as never,
              source_identities: event.sourceIdentities as never,
              independent_sources: event.independentSources,
              last_updated_at: nowIso,
              status: "updated",
              ...(alerted
                ? { alerted: true, last_alerted_at: nowIso, alert_count: (previous.alert_count ?? 0) + 1 }
                : {}),
            })
            .eq("id", previous.id);
          continue;
        }

        await db.from("market_events").upsert(
          {
            radar_id: radar.id,
            user_id: radar.user_id,
            run_id: runId,
            event_key: event.key,
            title: event.title,
            fact_summary: event.factSummary,
            ai_analysis: event.aiAnalysis,
            severity: event.severity,
            relevance: event.relevance,
            confidence: event.factConfidence,
            fact_confidence: event.factConfidence,
            interpretation_confidence: event.interpretationConfidence,
            importance_score: event.importance,
            novelty_score: event.novelty,
            event_type: event.type,
            entities: event.entities,
            affected_assets: event.affectedAssets as never,
            timeline: [timelineEntry] as never,
            source_quality: event.sourceTier,
            categories: event.categories,
            sources: event.sources as never,
            source_count: event.sources.length,
            published_at: event.publishedAt,
            instrument: spec.instrument.symbol,
            metric: spec.instrument.metric,
            market_value: consensus.value,
            market_change_pct: event.correlation.changePct,
            correlation: event.correlation as never,
            what_to_watch: event.whatToWatch || null,
            market_reactions: event.reactions as never,
            source_identities: event.sourceIdentities as never,
            independent_sources: event.independentSources,
            status: "active",
            last_updated_at: nowIso,
            alerted,
            ...(alerted ? { last_alerted_at: nowIso, alert_count: 1 } : {}),
          },
          { onConflict: "radar_id,event_key", ignoreDuplicates: false },
        );
      }
      memory["market_events_swept_at"] = nowIso;

    } catch (err) {
      if (err instanceof SweepPaused) throw err;
      // Event discovery is additive: a failure must never fail the numeric sweep.
      console.error(`[radar:market-events] sweep failed: ${(err as Error).message}`);
    }


    // 6. Persist + schedule.
    await phase("persisting_results");
    const finishedAt = new Date().toISOString();
    const nextRunAt = computeNextRunAt(radar.frequency, finishedAt, radar.status);
    const marketMemory = { ...memory, market_rules: evaluation.nextState };
    await patchRun({
      status: "completed",
      current_phase: "completed",
      items_found: 1 + eventsDetected,
      new_items: 0,
      alerts_created: alertsCreated,
      sources_retrieved: consensus.quotes.length,
      search_requests: collection.searchRequests,
      search_successes: collection.searchSuccesses,
      search_failures: collection.searchFailures,
      cost_estimate: collection.costEstimate + eventCost,
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
          }). ${eventsDetected} event${eventsDetected === 1 ? "" : "s"} on the timeline. The radar now watches it and alerts when your rules fire or a significant event hits.`
        : alertsCreated > 0
          ? `${alertsCreated} alert${alertsCreated === 1 ? "" : "s"} for ${spec.instrument.symbol} — ${eventsSignificant} significant event${eventsSignificant === 1 ? "" : "s"} detected.`
          : eventsDetected > 0
            ? `${eventsDetected} new event${eventsDetected === 1 ? "" : "s"} added to the timeline.`
            : undefined,
      itemsFound: 1 + eventsDetected,

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
