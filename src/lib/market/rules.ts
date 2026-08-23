/**
 * Market alert rules — pure evaluation, no I/O.
 *
 * Rules are the structured form of what the user asked for ("under 1.15",
 * "faller mer än 10 %", "up 5 % in 24h"). Evaluation is EDGE-TRIGGERED: a
 * rule alerts when its condition flips from false to true, and re-arms only
 * after the condition has gone false again. That is what stops a breached
 * threshold from spamming an alert on every single sweep while still never
 * missing a genuine crossing.
 *
 * The per-rule state lives in radars.memory.market_rules, so a sweep that
 * crashes between the alert insert and the state write re-evaluates from the
 * last durable state on the next run.
 */
import type { MarketChanges } from "./history";
import type { MarketRule, RuleDirection, RuleWindow, ThresholdOperator } from "./types";

export interface MarketRuleState {
  /** Was the condition true at the last evaluation? */
  conditionMet: boolean;
  lastTriggeredAt: string | null;
}

export type MarketRuleStateMap = Record<string, MarketRuleState>;

export interface RuleStatus {
  rule: MarketRule;
  conditionMet: boolean;
  /** The value the rule compares against (threshold value or window reference). */
  reference: number | null;
  /** Signed move vs reference in percent (pct_change rules only). */
  movePct: number | null;
  lastTriggeredAt: string | null;
  /** False when the reference data needed for evaluation does not exist yet. */
  evaluable: boolean;
}

export interface TriggeredRule {
  rule: MarketRule;
  current: number;
  reference: number | null;
  movePct: number | null;
}

export interface RuleEvaluation {
  statuses: RuleStatus[];
  /** Rules whose condition flipped false → true in this evaluation. */
  triggered: TriggeredRule[];
  nextState: MarketRuleStateMap;
}

function compare(value: number, op: ThresholdOperator, threshold: number): boolean {
  switch (op) {
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
  }
}

function directionMet(direction: RuleDirection, movePct: number, pct: number): boolean {
  switch (direction) {
    case "up":
      return movePct >= pct;
    case "down":
      return movePct <= -pct;
    case "any":
      return Math.abs(movePct) >= pct;
  }
}

function windowReference(
  window: RuleWindow,
  changes: MarketChanges | null,
  baselineValue: number | null,
): number | null {
  if (window === "baseline") return baselineValue;
  return changes?.windows[window]?.from ?? null;
}

function evaluateOne(
  rule: MarketRule,
  input: {
    current: number;
    baselineValue: number | null;
    changes: MarketChanges | null;
  },
): { met: boolean; reference: number | null; movePct: number | null; evaluable: boolean } {
  if (rule.type === "threshold") {
    return {
      met: compare(input.current, rule.operator, rule.value),
      reference: rule.value,
      movePct: null,
      evaluable: true,
    };
  }
  const reference = windowReference(rule.window, input.changes, input.baselineValue);
  if (reference === null || reference === 0) {
    return { met: false, reference, movePct: null, evaluable: false };
  }
  const movePct = ((input.current - reference) / reference) * 100;
  return {
    met: directionMet(rule.direction, movePct, rule.pct),
    reference,
    movePct,
    evaluable: true,
  };
}

export function evaluateMarketRules(
  rules: MarketRule[],
  input: {
    current: number;
    baselineValue: number | null;
    changes: MarketChanges | null;
    state: MarketRuleStateMap;
    nowIso?: string;
  },
): RuleEvaluation {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const statuses: RuleStatus[] = [];
  const triggered: TriggeredRule[] = [];
  const nextState: MarketRuleStateMap = {};

  for (const rule of rules) {
    const prior = input.state[rule.id] ?? { conditionMet: false, lastTriggeredAt: null };
    const result = evaluateOne(rule, input);
    const fires = result.evaluable && result.met && !prior.conditionMet;
    if (fires) {
      triggered.push({
        rule,
        current: input.current,
        reference: result.reference,
        movePct: result.movePct,
      });
    }
    nextState[rule.id] = {
      conditionMet: result.evaluable ? result.met : prior.conditionMet,
      lastTriggeredAt: fires ? nowIso : prior.lastTriggeredAt,
    };
    statuses.push({
      rule,
      conditionMet: result.met,
      reference: result.reference,
      movePct: result.movePct,
      lastTriggeredAt: nextState[rule.id]!.lastTriggeredAt,
      evaluable: result.evaluable,
    });
  }

  return { statuses, triggered, nextState };
}

/** Human sentence describing why a rule fired (stored on the alert). */
export function describeTrigger(hit: TriggeredRule, symbol: string, format: (v: number) => string): string {
  if (hit.rule.type === "threshold") {
    return `${symbol} is now ${format(hit.current)} — the rule "${hit.rule.label}" (${hit.rule.operator} ${format(hit.rule.value)}) has been crossed.`;
  }
  const windowLabel =
    hit.rule.window === "baseline" ? "since the baseline" : `over the last ${hit.rule.window}`;
  const move = hit.movePct !== null ? `${hit.movePct >= 0 ? "+" : ""}${hit.movePct.toFixed(2)}%` : "?";
  return `${symbol} moved ${move} ${windowLabel} (${hit.reference !== null ? format(hit.reference) : "?"} → ${format(hit.current)}) — the rule "${hit.rule.label}" fired.`;
}
