/**
 * Listing card — the primary user-facing surface for one found item.
 *
 * Design intent: minimal by default (image, name, price, a few facts, one
 * market status), everything technical hidden behind "Visa mer". It never
 * invents a value: a missing fact is shown as missing, and a market value is
 * only claimed when the deterministic baseline says it may be.
 */
import { useState } from "react";
import { ChevronDown, ExternalLink, ImageOff } from "lucide-react";
import { asBaseline, BaselinePanel } from "@/components/baseline-panel";
import { isFactual, type AttributeValue } from "@/lib/monitoring/normalize";
import { cn } from "@/lib/utils";

export interface FindingLike {
  id: string;
  title: string;
  url: string | null;
  primary_url: string | null;
  discovery_url: string | null;
  numeric_value: number | null;
  currency: string | null;
  attributes: unknown;
  snapshot: unknown;
  baseline: unknown;
  detail_status: string;
  availability: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export type MatchStatus = "match" | "reject" | "unverified";

export interface FindingSnapshot {
  summary?: string;
  match_status?: MatchStatus;
  match_reason?: string;
  image?: string | null;
  image_source?: string | null;
  criteria?: { label?: string; ok?: boolean | null; reason?: string }[];
}

export function snapshotOf(value: unknown): FindingSnapshot {
  return value && typeof value === "object" ? (value as FindingSnapshot) : {};
}

export function attributesOf(value: unknown): AttributeValue[] {
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, AttributeValue>).filter(
    (a) => a && typeof a === "object" && a.raw,
  );
}

function money(value: number | null, currency: string | null): string | null {
  if (value === null) return null;
  const rounded = Math.round(value).toLocaleString("sv-SE");
  return currency === "SEK" ? `${rounded} kr` : `${rounded}${currency ? ` ${currency}` : ""}`;
}

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** One short market verdict — only when a real baseline was computed. */
function marketVerdict(baseline: unknown) {
  const b = asBaseline(baseline);
  if (!b || b.status !== "computed" || !b.stats) return null;
  const pct = b.differencePct ?? 0;
  const tone = Math.abs(pct) < 5 ? "around" : pct < 0 ? "under" : "over";
  return {
    tone,
    label:
      tone === "around"
        ? "Marknadspris"
        : `${Math.abs(pct).toFixed(0)} % ${tone === "under" ? "under" : "över"} marknad`,
    median: money(b.stats.median, b.currency),
    count: b.stats.count,
  };
}

export function ListingCard({ finding }: { finding: FindingLike }) {
  const [open, setOpen] = useState(false);
  const snapshot = snapshotOf(finding.snapshot);
  const attributes = attributesOf(finding.attributes);
  const link = finding.primary_url ?? finding.url;
  const verdict = marketVerdict(finding.baseline);
  const price = money(finding.numeric_value, finding.currency);

  const meta = attributes
    .filter((a) => a.key !== "price" && !a.key.includes("url"))
    .slice(0, 3)
    .map((a) => a.raw);

  return (
    <article className="panel overflow-hidden">
      <div className="relative aspect-[16/10] w-full bg-muted/40">
        {snapshot.image ? (
          <img
            src={snapshot.image}
            alt={finding.title}
            loading="lazy"
            className="size-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <ImageOff className="size-5" aria-hidden />
            <span className="text-xs">Ingen bild från annonsen</span>
          </div>
        )}
      </div>

      <div className="space-y-3 p-4">
        <div>
          <h3 className="text-base font-medium leading-snug">{finding.title}</h3>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{price ?? "Pris saknas"}</p>
          {meta.length > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">{meta.join(" · ")}</p>
          )}
        </div>

        {verdict ? (
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span
              className={cn(
                "font-medium",
                verdict.tone === "under"
                  ? "text-interesting"
                  : verdict.tone === "over"
                    ? "text-critical"
                    : "text-muted-foreground",
              )}
            >
              {verdict.label}
            </span>
            <span className="text-muted-foreground">
              Marknad ~{verdict.median} · {verdict.count} jämförbara
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Otillräckligt jämförelseunderlag</p>
        )}

        <div className="flex items-center gap-2 pt-1">
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/60"
            >
              Öppna annons
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
          <span className="mono-label">{host(link) ?? "okänd källa"}</span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            aria-expanded={open}
          >
            {open ? "Visa mindre" : "Visa mer"}
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        </div>

        {open && (
          <div className="space-y-3 border-t border-border pt-3">
            {snapshot.match_reason && (
              <p className="text-sm text-muted-foreground">{snapshot.match_reason}</p>
            )}
            {attributes.length > 0 && (
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {attributes.map((a) => (
                  <div key={a.key} className="flex gap-2">
                    <dt className="mono-label">{a.key.replace(/_/g, " ")}</dt>
                    <dd className={isFactual(a) ? "" : "italic text-muted-foreground"}>
                      {a.raw}
                      {!isFactual(a) && " (tolkad)"}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <BaselinePanel baseline={finding.baseline} />
            <p className="mono-label">
              Först sedd {new Date(finding.first_seen_at).toLocaleDateString("sv-SE")} · senast sedd{" "}
              {new Date(finding.last_seen_at).toLocaleDateString("sv-SE")} ·{" "}
              {finding.detail_status === "fetched" ? "annonssida läst" : "endast listningsdata"}
              {snapshot.image_source ? " · bild från annonsen" : ""}
            </p>
          </div>
        )}
      </div>
    </article>
  );
}

/** Horizontal, swipeable rail on mobile; plain grid from `sm` upwards. */
export function ListingRail({ findings }: { findings: FindingLike[] }) {
  return (
    <>
      <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:hidden">
        {findings.map((f) => (
          <div key={f.id} className="w-[85%] shrink-0 snap-center">
            <ListingCard finding={f} />
          </div>
        ))}
      </div>
      <div className="hidden gap-4 sm:grid sm:grid-cols-2 xl:grid-cols-3">
        {findings.map((f) => (
          <ListingCard key={f.id} finding={f} />
        ))}
      </div>
    </>
  );
}
