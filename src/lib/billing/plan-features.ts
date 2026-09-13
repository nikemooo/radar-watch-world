/**
 * Plan feature bullets are derived from the plan's own numbers instead of the
 * English strings stored in the database, so every language shows the same
 * facts in its own words.
 */
import type { TranslationKey, TranslateVars } from "@/lib/i18n";

export type Translate = (key: TranslationKey, vars?: TranslateVars) => string;

export type PlanShape = {
  key: string;
  max_radars: number;
  min_check_interval_minutes: number;
  max_alerts_per_month: number | null;
  history_days: number;
  detail_fetch_level: string;
  priority_processing?: boolean;
};

/** "every hour" / "once a day" / "every 6 hours" / "every 45 minutes". */
export function formatSweepInterval(minutes: number, t: Translate): string {
  if (minutes === 60) return t("interval.hourly");
  if (minutes === 1440) return t("interval.daily");
  if (minutes % 60 === 0) return t("interval.everyHours", { hours: minutes / 60 });
  return t("interval.everyMinutes", { minutes });
}

export function formatHistory(days: number, t: Translate): string {
  return days >= 365 ? t("plan.feature.historyYear") : t("plan.feature.history", { days });
}

function detailKey(level: string): TranslationKey {
  if (level === "priority") return "plan.feature.detail.priority";
  if (level === "limited") return "plan.feature.detail.limited";
  return "plan.feature.detail.standard";
}

/** The localized bullet list shown on the pricing and billing cards. */
export function planFeatures(plan: PlanShape, t: Translate): string[] {
  const bullets: string[] = [
    t("plan.feature.radars", { count: plan.max_radars }),
    t("plan.feature.sweeps", { interval: formatSweepInterval(plan.min_check_interval_minutes, t) }),
    plan.max_alerts_per_month === null
      ? t("plan.feature.alertsUnlimited")
      : t("plan.feature.alertsLimited", { count: plan.max_alerts_per_month }),
    t(detailKey(plan.detail_fetch_level)),
  ];

  if (plan.detail_fetch_level === "limited") bullets.push(t("plan.feature.changeDetection"));
  else bullets.push(t("plan.feature.baseline"));

  bullets.push(formatHistory(plan.history_days, t));
  return bullets;
}
