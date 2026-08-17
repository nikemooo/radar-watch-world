import { ExternalLink, Bookmark, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { ImportanceBadge, ConfidenceMeter } from "@/components/importance-badge";
import { Button } from "@/components/ui/button";
import { asSources, type Importance } from "@/lib/radar-types";
import { cn } from "@/lib/utils";

export interface AlertRow {
  id: string;
  title: string;
  summary: string;
  importance: string;
  confidence: number;
  status: string;
  event_type: string | null;
  what_changed: string | null;
  why_it_matters: string | null;
  potential_impact: string | null;
  feedback: string | null;
  sources: unknown;
  created_at: string;
  radar_id: string | null;
}

interface Props {
  alert: AlertRow;
  radarName?: string | undefined;
  onSave?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
  onFeedback?: ((value: "useful" | "not_useful") => void) | undefined;
}

export function AlertCard({ alert, radarName, onSave, onDismiss, onFeedback }: Props) {
  const sources = asSources(alert.sources);

  return (
    <article
      className={cn(
        "panel p-4 transition-colors sm:p-5",
        alert.status === "dismissed" && "opacity-55",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ImportanceBadge value={alert.importance} />
        {radarName && <span className="mono-label">{radarName}</span>}
        <span className="mono-label ml-auto">
          {new Date(alert.created_at).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>

      <h3 className="mt-3 text-base font-medium leading-snug">{alert.title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{alert.summary}</p>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        {alert.what_changed && (
          <div>
            <dt className="mono-label">What changed</dt>
            <dd className="mt-1 text-sm">{alert.what_changed}</dd>
          </div>
        )}
        {alert.why_it_matters && (
          <div>
            <dt className="mono-label">Why it matters</dt>
            <dd className="mt-1 text-sm">{alert.why_it_matters}</dd>
          </div>
        )}
        {alert.potential_impact && (
          <div>
            <dt className="mono-label">Potential impact</dt>
            <dd className="mt-1 text-sm">{alert.potential_impact}</dd>
          </div>
        )}
      </dl>

      {sources.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {sources.slice(0, 4).map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="size-3 shrink-0" />
              <span className="truncate">{source.publisher || new URL(source.url).hostname}</span>
            </a>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <ConfidenceMeter value={alert.confidence} />
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Mark useful"
            className={cn(alert.feedback === "useful" && "text-interesting")}
            onClick={() => onFeedback?.("useful")}
          >
            <ThumbsUp className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Mark not useful"
            className={cn(alert.feedback === "not_useful" && "text-critical")}
            onClick={() => onFeedback?.("not_useful")}
          >
            <ThumbsDown className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Save alert"
            className={cn(alert.status === "saved" && "text-primary")}
            onClick={onSave}
          >
            <Bookmark className="size-4" />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Dismiss alert" onClick={onDismiss}>
            <X className="size-4" />
          </Button>
        </div>
      </div>
    </article>
  );
}
