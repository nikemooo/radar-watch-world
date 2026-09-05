/**
 * Market Impact timeline — the event face of a market radar.
 *
 * Every entry keeps FACT and AI INTERPRETATION visually separate, shows the
 * clustered sources behind the event, its calibrated confidence, the assets it
 * touches and, when the radar observed a value on both sides of the event, the
 * market move that coincided with it. A coincidence is labelled as such — the
 * UI never claims causation.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ExternalLink } from "lucide-react";
import type { Database } from "@/integrations/supabase/types";
import { useFormatDateTime, useT } from "@/lib/i18n";
import {
  asAffectedAssets,
  asSeverity,
  asTimeline,
  importanceBand,
  type EventSeverity,
} from "@/lib/market/events";
import { cn } from "@/lib/utils";

export type MarketEventRow = Database["public"]["Tables"]["market_events"]["Row"];

interface SourceEntry {
  title?: string;
  url?: string;
  publisher?: string | null;
  published_at?: string | null;
}

interface ReactionShape {
  symbol?: string;
  window?: string | null;
  changePct?: number | null;
  available?: boolean;
  unavailableReason?: string | null;
  coarse?: boolean | null;
  priceBefore?: number | null;
  priceAfter?: number | null;
  provider?: string | null;
}

interface CorrelationShape {
  before?: number | null;
  after?: number | null;
  changePct?: number | null;
  hoursBetween?: number | null;
  observed?: boolean;
}

const severityStyles: Record<EventSeverity, string> = {
  critical: "bg-critical/15 text-critical border-critical/30",
  high: "bg-important/15 text-important border-important/30",
  medium: "bg-interesting/15 text-interesting border-interesting/30",
  low: "bg-muted text-muted-foreground border-border",
};

const bandStyles: Record<ReturnType<typeof importanceBand>, string> = {
  critical: "text-critical",
  important: "text-important",
  interesting: "text-interesting",
  minor: "text-muted-foreground",
};

function SeverityBadge({ severity }: { severity: EventSeverity }) {
  const t = useT();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]",
        severityStyles[severity],
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {t(`events.severity.${severity}`)}
    </span>
  );
}

function ImportanceGauge({ score }: { score: number }) {
  const t = useT();
  const pct = Math.max(0, Math.min(100, score));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-current" style={{ width: `${pct}%` }} />
      </span>
      <span
        className={cn(
          "font-mono text-[10px] uppercase tracking-[0.1em]",
          bandStyles[importanceBand(pct)],
        )}
      >
        {t("events.importance", { score: pct })}
      </span>
    </span>
  );
}

/**
 * The full body of one event. Used inline on the radar timeline and, expanded,
 * on the event detail page.
 */
export function MarketEventBody({
  event,
  alwaysOpen = false,
}: {
  event: MarketEventRow;
  alwaysOpen?: boolean;
}) {
  const t = useT();
  const formatDateTime = useFormatDateTime();
  const [open, setOpen] = useState(alwaysOpen);
  const severity = asSeverity(event.severity);
  const sources: SourceEntry[] = Array.isArray(event.sources)
    ? (event.sources as SourceEntry[])
    : [];
  const correlation = (event.correlation ?? {}) as CorrelationShape;
  const assets = asAffectedAssets(event.affected_assets);
  const timeline = asTimeline(event.timeline);
  const reactions: ReactionShape[] = Array.isArray(event.market_reactions)
    ? (event.market_reactions as ReactionShape[])
    : [];
  const measured = reactions.filter((r) => r.available && typeof r.changePct === "number");
  const unmeasured = reactions.filter((r) => !r.available);
  const changePct =
    typeof correlation.changePct === "number" && Number.isFinite(correlation.changePct)
      ? correlation.changePct
      : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={severity} />
        <span className="mono-label">{(event.event_type ?? "other").replace(/_/g, " ")}</span>
        {event.categories.slice(0, 2).map((category) => (
          <span key={category} className="mono-label">
            {category.replace(/_/g, " ")}
          </span>
        ))}
        <span className="mono-label ml-auto">
          {event.published_at
            ? formatDateTime(event.published_at)
            : formatDateTime(event.detected_at)}
        </span>
      </div>

      <h3 className="mt-2 text-base font-medium leading-snug">{event.title}</h3>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <ImportanceGauge score={event.importance_score ?? 0} />
        <span className="mono-label">
          {t("events.sourceQuality", { tier: event.source_quality ?? "secondary" })}
        </span>
        {(event.independent_sources ?? 0) > 0 && (
          <span className="mono-label">
            {t("events.independentSources", { count: event.independent_sources ?? 0 })}
          </span>
        )}
        {(event.alert_count ?? 0) > 0 && (
          <span className="mono-label">
            {t("events.updated", { when: formatDateTime(event.last_updated_at) })}
          </span>
        )}
      </div>

      {event.fact_summary && (
        <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="mono-label">{t("events.fact")}</p>
            <p className="mono-label">
              {t("events.factConfidence", {
                pct: Math.round(Number(event.fact_confidence ?? event.confidence) * 100),
              })}
            </p>
          </div>
          <p className="mt-1 text-sm">{event.fact_summary}</p>
        </div>
      )}

      {event.ai_analysis && (
        <div className="mt-2 rounded-md border border-dashed border-primary/40 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="mono-label text-primary">{t("events.interpretation")}</p>
            <p className="mono-label">
              {t("events.interpretationConfidence", {
                pct: Math.round(Number(event.interpretation_confidence ?? 0) * 100),
              })}
            </p>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{event.ai_analysis}</p>
        </div>
      )}

      {assets.length > 0 && (
        <div className="mt-3">
          <p className="mono-label">{t("events.affected")}</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {assets.map((asset) => (
              <li
                key={`${asset.symbol}-${asset.relation}`}
                className="rounded-md border border-border px-2 py-1 text-xs"
                title={asset.rationale}
              >
                <span className="font-medium">{asset.symbol}</span>{" "}
                <span className="text-muted-foreground">
                  {t(`events.relation.${asset.relation}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {reactions.length > 0 && (
        <div className="mt-3">
          <p className="mono-label">{t("events.reaction")}</p>
          {measured.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-2">
              {measured.map((r) => (
                <li key={r.symbol} className="rounded-md border border-border px-2 py-1 text-xs">
                  <span className="font-medium">{r.symbol}</span>{" "}
                  <span
                    className={
                      r.changePct! > 0 ? "text-primary" : r.changePct! < 0 ? "text-critical" : ""
                    }
                  >
                    {r.changePct! > 0 ? "+" : ""}
                    {r.changePct!.toFixed(2)} %
                  </span>{" "}
                  <span className="text-muted-foreground">{r.window}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {unmeasured.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("events.reactionUnavailable", {
                symbols: unmeasured.map((r) => r.symbol ?? "?").join(", "),
              })}
            </p>
          )}
          {measured.some((r) => r.coarse) && (
            <p className="mt-1 text-xs text-muted-foreground">{t("events.reactionCoarse")}</p>
          )}
          {measured.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">{t("events.coincidence")}</p>
          )}
        </div>
      )}

      {event.what_to_watch && (
        <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
          <p className="mono-label">{t("events.whatToWatch")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{event.what_to_watch}</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        {changePct !== null ? (
          <span className="text-xs">
            <span className="mono-label">{t("events.moveLabel")}</span>{" "}
            <span className={changePct > 0 ? "text-primary" : changePct < 0 ? "text-critical" : ""}>
              {changePct > 0 ? "+" : ""}
              {changePct.toFixed(2)} %
            </span>{" "}
            <span className="text-muted-foreground">{t("events.coincidence")}</span>
          </span>
        ) : (
          <span className="mono-label">{t("events.noMoveData")}</span>
        )}
        {!alwaysOpen && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mono-label ml-auto inline-flex items-center gap-1 hover:text-foreground"
          >
            {t("events.sources", { count: event.source_count })}
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
          </button>
        )}
      </div>

      {timeline.length > 1 && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="mono-label">{t("events.development")}</p>
          <ol className="mt-2 space-y-2">
            {timeline.map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="text-sm">
                <span className="mono-label mr-2">{formatDateTime(entry.at)}</span>
                {entry.note}
              </li>
            ))}
          </ol>
        </div>
      )}

      {open && sources.length > 0 && (
        <ul className="mt-3 divide-y divide-border border-t border-border pt-1">
          {sources.map((source, i) => (
            <li key={`${source.url}-${i}`} className="py-2 text-sm">
              <a
                href={source.url ?? "#"}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-start gap-1.5 underline underline-offset-4"
              >
                {source.title ?? source.url}
                <ExternalLink className="mt-0.5 size-3 shrink-0" />
              </a>
              {source.publisher && <span className="mono-label ml-2">{source.publisher}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function MarketEventTimeline({ events }: { events: MarketEventRow[] }) {
  const t = useT();
  const sorted = [...events].sort((a, b) =>
    (b.published_at ?? b.detected_at).localeCompare(a.published_at ?? a.detected_at),
  );

  return (
    <section className="panel p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-medium">{t("events.title")}</h2>
        <span className="mono-label">{t("events.count", { count: sorted.length })}</span>
      </div>
      {sorted.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t("events.empty")}</p>
      ) : (
        <ul className="mt-4 space-y-4 border-l border-border">
          {sorted.map((event) => (
            <li key={event.id} className="relative pl-6">
              <span className="absolute left-0 top-2 size-2.5 rounded-full border border-primary/50 bg-background" />
              <div className="panel p-4">
                <MarketEventBody event={event} />
                <Link
                  to="/events/$eventId"
                  params={{ eventId: event.id }}
                  className="mono-label mt-3 inline-block hover:text-foreground"
                >
                  {t("events.open")} →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
