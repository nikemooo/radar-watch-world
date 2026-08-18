import type { BaselineResult } from "@/lib/monitoring/comparables";
import { NO_BASELINE_PHRASE } from "@/lib/monitoring/comparables";

/** Narrow persisted jsonb into a baseline result without trusting its shape. */
export function asBaseline(value: unknown): BaselineResult | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Partial<BaselineResult>;
  if (typeof b.status !== "string") return null;
  return b as BaselineResult;
}

const num = (n: number, currency: string | null) =>
  `${Math.round(n).toLocaleString("en-US")}${currency ? ` ${currency}` : ""}`;

/**
 * Explainability surface: every comparison states what was compared, how many
 * observations were used, the median, the difference, the confidence and the
 * limitations. With no baseline, no market claim is made at all.
 */
export function BaselinePanel({ baseline }: { baseline: unknown }) {
  const b = asBaseline(baseline);
  if (!b || b.status === "not_applicable" || b.status === "no_value") return null;

  if (b.status !== "computed" || !b.stats) {
    return (
      <div className="mt-3 rounded-md border border-dashed border-border p-3">
        <p className="mono-label">Market baseline</p>
        <p className="mt-1 text-sm text-muted-foreground">{NO_BASELINE_PHRASE}</p>
        {b.limitations?.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">{b.limitations.join(" · ")}</p>
        )}
      </div>
    );
  }

  const below = (b.difference ?? 0) < 0;
  const pct = b.differencePct ?? 0;
  const classification =
    Math.abs(pct) < 5 ? "around market value" : pct < 0 ? "under market value" : "over market value";
  return (
    <div className="mt-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="mono-label">Market baseline</p>
        <span
          className={
            classification === "under market value"
              ? "text-interesting text-sm"
              : "text-sm text-muted-foreground"
          }
        >
          {classification}
        </span>
        <span className={below ? "text-interesting text-sm" : "text-sm text-muted-foreground"}>
          {b.differencePct === null
            ? "at median"
            : `${b.differencePct > 0 ? "+" : "−"}${Math.abs(b.differencePct).toFixed(1)}% vs median`}
        </span>
        <span className="mono-label">{Math.round(b.percentile ?? 0)}th percentile</span>
        <span className="mono-label ml-auto">Baseline confidence: {b.confidenceLabel}</span>
      </div>

      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <Row label="Current price" value={b.value === null ? "—" : num(b.value, b.currency)} />
        <Row label="Market value (median)" value={num(b.stats.median, b.currency)} />
        <Row label="Comparable observations" value={String(b.stats.count)} />
        <Row label="Difference" value={b.difference === null ? "—" : `${below ? "−" : "+"}${num(Math.abs(b.difference), b.currency)}`} />
        <Row label="P10–P90" value={`${num(b.stats.p10, b.currency)} – ${num(b.stats.p90, b.currency)}`} />
        <Row label="Range" value={`${num(b.stats.min, b.currency)} – ${num(b.stats.max, b.currency)}`} />
        {b.anomalyScore !== null && <Row label="Anomaly" value={b.anomalyScore.toFixed(2)} />}
        {b.opportunityScore !== null && <Row label="Opportunity" value={b.opportunityScore.toFixed(2)} />}
        {b.stats.stddev !== null && <Row label="Std dev" value={num(b.stats.stddev, b.currency)} />}
      </dl>

      {b.sample?.length > 0 && (
        <details className="mt-2">
          <summary className="mono-label cursor-pointer">
            Comparable listings used ({b.sample.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {b.sample.map((c) => (
              <li key={c.fingerprint} className="flex flex-wrap gap-x-2">
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer noopener" className="underline">
                    {c.title}
                  </a>
                ) : (
                  <span>{c.title}</span>
                )}
                <span>{num(c.value, b.currency)}</span>
                <span className="mono-label">similarity {(c.similarity * 100).toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {b.comparedOn?.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Comparable on: {b.comparedOn.map((k) => k.replace(/_/g, " ")).join(", ")}
        </p>
      )}
      {b.limitations?.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">Limitations: {b.limitations.join(" · ")}</p>
      )}

    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="mono-label">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
