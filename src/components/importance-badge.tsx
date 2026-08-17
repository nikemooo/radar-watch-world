import { cn } from "@/lib/utils";
import { importanceLabel, type Importance } from "@/lib/radar-types";

const styles: Record<Importance, string> = {
  critical: "bg-critical/15 text-critical border-critical/30",
  important: "bg-important/15 text-important border-important/30",
  interesting: "bg-interesting/15 text-interesting border-interesting/30",
  minor: "bg-muted text-muted-foreground border-border",
};

export function ImportanceBadge({ value, className }: { value: string; className?: string }) {
  const key = (["critical", "important", "interesting", "minor"].includes(value)
    ? value
    : "minor") as Importance;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-[0.1em] uppercase",
        styles[key],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {importanceLabel[key]}
    </span>
  );
}

export function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="mono-label">Confidence</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">{pct}%</span>
    </span>
  );
}
