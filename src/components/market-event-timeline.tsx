/**
 * Market Impact timeline — the event face of a market radar.
 *
 * Every entry keeps FACT and AI INTERPRETATION visually separate, shows the
 * clustered sources behind the event, and, when the radar observed a value on
 * both sides of the event, the market move that coincided with it. A
 * coincidence is labelled as such — the UI never claims causation.
 */
import { useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import type { Database } from "@/integrations/supabase/types";
import { useFormatDateTime, useT } from "@/lib/i18n";
import { asSeverity, type EventSeverity } from "@/lib/market/events";
import { cn } from "@/lib/utils";

export type MarketEventRow = Database["public"]["Tables"]["market_events"]["Row"];

interface SourceEntry {
  title?: string;
  url?: string;
  publisher?: string | null;
  published_at?: string | null;
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

function EventEntry({ event }: { event: MarketEventRow }) {
  const t = useT();
  const formatDateTime = useFormatDateTime();
  const [open, setOpen] = useState(false);
  const severity = asSeverity(event.severity);
  const sources: SourceEntry[] = Array.isArray(event.sources) ? (event.sources as SourceEntry[]) : [];
  const correlation = (event.correlation ?? {}) as CorrelationShape;
  const changePct =
    typeof correlation.changePct === "number" && Number.isFinite(correlation.changePct)
      ? correlation.changePct
      : null;

  return (
    <li className="relative pl-6">
      <span className="absolute left-0 top-2 size-2.5 rounded-full border border-primary/50 bg-background" />
      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={severity} />
          {event.categories.slice(0, 3).map((category) => (
            <span key={category} className="mono-label">
              {category.replace(/_/g, " ")}
            </span>
          ))}
          <span className="mono-label ml-auto">
            {event.published_at ? formatDateTime(event.published_at) : formatDateTime(event.detected_at)}
          </span>
        </div>

        <h3 className="mt-2 text-base font-medium leading-snug">{event.title}</h3>

        {event.fact_summary && (
          <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
            <p className="mono-label">{t("events.fact")}</p>
            <p className="mt-1 text-sm">{event.fact_summary}</p>
          </div>
        )}

        {event.ai_analysis && (
          <div className="mt-2 rounded-md border border-dashed border-primary/40 p-3">
            <p className="mono-label text-primary">{t("events.interpretation")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{event.ai_analysis}</p>
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
          <span className="mono-label">
            {t("events.confidence", { pct: Math.round(Number(event.confidence) * 100) })}
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mono-label ml-auto inline-flex items-center gap-1 hover:text-foreground"
          >
            {t("events.sources", { count: event.source_count })}
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
          </button>
        </div>

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
                {source.publisher && (
                  <span className="mono-label ml-2">{source.publisher}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
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
            <EventEntry key={event.id} event={event} />
          ))}
        </ul>
      )}
    </section>
  );
}
