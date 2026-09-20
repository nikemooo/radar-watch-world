/**
 * Likely price impact of an event, expressed in four plain bands.
 *
 * The bands are a presentation of the existing 0–100 importance score
 * (see computeImportance in ./events) — no second scoring system exists.
 * A user chooses which bands are allowed to push a notification; everything
 * else is still stored and still shows up on the radar timeline.
 */
export type ImpactLevel = "small" | "medium" | "large" | "extreme";

export const IMPACT_LEVELS: ImpactLevel[] = ["small", "medium", "large", "extreme"];

/** 0–40 small · 41–60 medium · 61–80 large · 81–100 extreme. */
export function impactLevel(score: number): ImpactLevel {
  const s = Number.isFinite(score) ? score : 0;
  if (s >= 81) return "extreme";
  if (s >= 61) return "large";
  if (s >= 41) return "medium";
  return "small";
}

/** Plan-aware starting point — users can change it per radar afterwards. */
export function defaultNotifyLevels(planKey: string): ImpactLevel[] {
  if (planKey === "free") return ["large", "extreme"];
  if (planKey === "lite") return ["medium", "large", "extreme"];
  return [...IMPACT_LEVELS];
}

/** Read the stored per-radar choice, falling back to the plan default. */
export function asNotifyLevels(value: unknown, planKey = "plus"): ImpactLevel[] {
  if (!Array.isArray(value)) return defaultNotifyLevels(planKey);
  const levels = value.filter((v): v is ImpactLevel =>
    IMPACT_LEVELS.includes(v as ImpactLevel),
  );
  // An empty array is a deliberate "notify me about nothing".
  return value.length === 0 ? [] : levels;
}

/** Does an event of this importance clear the user's push threshold? */
export function shouldNotify(score: number, levels: ImpactLevel[]): boolean {
  return levels.includes(impactLevel(score));
}
