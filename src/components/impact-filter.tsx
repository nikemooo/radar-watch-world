import { useT } from "@/lib/i18n";
import { IMPACT_LEVELS, type ImpactLevel } from "@/lib/market/impact";
import { Checkbox } from "@/components/ui/checkbox";

const RANGES: Record<ImpactLevel, [number, number]> = {
  small: [0, 40],
  medium: [41, 60],
  large: [61, 80],
  extreme: [81, 100],
};

/**
 * Per-radar choice of which likely-impact bands are allowed to send an alert.
 * Unchecked bands are still collected and still appear on the timeline.
 */
export function ImpactFilter({
  value,
  onChange,
  disabled,
}: {
  value: ImpactLevel[];
  onChange: (levels: ImpactLevel[]) => void;
  disabled?: boolean;
}) {
  const t = useT();

  const toggle = (level: ImpactLevel, checked: boolean) => {
    const next = checked ? [...value, level] : value.filter((l) => l !== level);
    onChange(IMPACT_LEVELS.filter((l) => next.includes(l)));
  };

  return (
    <section className="panel space-y-4 p-5">
      <div>
        <h2 className="text-lg font-medium">{t("impact.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("impact.body")}</p>
      </div>
      <div className="space-y-2">
        {[...IMPACT_LEVELS].reverse().map((level) => (
          <label
            key={level}
            className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
          >
            <Checkbox
              checked={value.includes(level)}
              disabled={disabled}
              onCheckedChange={(checked) => toggle(level, checked === true)}
            />
            <span className="flex-1">{t(`impact.level.${level}` as "impact.level.small")}</span>
            <span className="mono-label">
              {t("impact.range", { from: RANGES[level][0], to: RANGES[level][1] })}
            </span>
          </label>
        ))}
      </div>
      {value.length === 0 && <p className="text-sm text-muted-foreground">{t("impact.none")}</p>}
    </section>
  );
}
