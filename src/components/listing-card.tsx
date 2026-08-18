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
import { statusLabel, type EffectiveVerdict } from "@/lib/monitoring/verification";
import { Button } from "@/components/ui/button";
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
  images?: string[];
  missing_attributes?: string[];
  criteria?: { label?: string; ok?: boolean | null; reason?: string }[];
  image_evidence?: unknown;
  /** "direct" when the stored URL provably addresses the advert itself. */
  link_status?: "direct" | "unverified";
  canonical_url?: string | null;
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

const statusTone: Record<MatchStatus, string> = {
  match: "bg-interesting/15 text-interesting",
  unverified: "bg-muted text-muted-foreground",
  reject: "bg-critical/10 text-critical",
};

const statusIcon: Record<MatchStatus, string> = { match: "✓", unverified: "⚠", reject: "✕" };

export function ListingCard({
  finding,
  verdict,
  onVerify,
}: {
  finding: FindingLike;
  verdict?: EffectiveVerdict | undefined;
  onVerify?: ((finding: FindingLike) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const snapshot = snapshotOf(finding.snapshot);
  const attributes = attributesOf(finding.attributes);
  const link = finding.primary_url ?? finding.url;
  // Only claim "Öppna annons" when the pipeline proved the URL is the advert.
  const directLink = snapshot.link_status ? snapshot.link_status === "direct" : !!finding.primary_url;
  const market = marketVerdict(finding.baseline);
  const price = money(finding.numeric_value, finding.currency);
  const image = snapshot.image ?? snapshot.images?.[0] ?? null;
  const status: MatchStatus = verdict?.status ?? snapshot.match_status ?? "unverified";
  const pending = verdict?.pending ?? [];

  const meta = attributes
    .filter((a) => a.key !== "price" && !a.key.includes("url"))
    .slice(0, 3)
    .map((a) => a.raw);

  return (
    <article className="panel flex h-full flex-col overflow-hidden">
      <div className="relative aspect-[16/10] w-full bg-muted/40">
        {image ? (
          <img
            src={image}
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
        <span
          className={cn(
            "absolute left-3 top-3 rounded-full px-2.5 py-1 text-xs font-medium backdrop-blur",
            statusTone[status],
          )}
        >
          {statusIcon[status]} {statusLabel[status]}
        </span>
      </div>

      <div className="flex flex-1 flex-col space-y-3 p-4">
        <div>
          <h3 className="text-base font-medium leading-snug">{finding.title}</h3>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{price ?? "Pris saknas"}</p>
          {meta.length > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">{meta.join(" · ")}</p>
          )}
        </div>

        {status === "unverified" && pending.length > 0 && (
          <div className="rounded-md bg-muted/50 p-3 text-sm">
            <p className="font-medium">Kunde inte verifieras</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {pending.slice(0, 4).map((r) => (
                <li key={r.attribute}>⚠ {r.label}</li>
              ))}
            </ul>
            {snapshot.missing_attributes?.length ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Saknad information: {snapshot.missing_attributes.slice(0, 5).map((k) => k.replace(/_/g, " ")).join(", ")}
              </p>
            ) : null}
          </div>
        )}

        {status === "reject" && (
          <p className="text-sm text-muted-foreground">{verdict?.reason ?? snapshot.match_reason}</p>
        )}

        {market ? (
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span
              className={cn(
                "font-medium",
                market.tone === "under"
                  ? "text-interesting"
                  : market.tone === "over"
                    ? "text-critical"
                    : "text-muted-foreground",
              )}
            >
              {market.label}
            </span>
            <span className="text-muted-foreground">
              Marknadsvärde ~{market.median} · {market.count} jämförbara
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Marknadsvärde kan inte beräknas ännu</p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              title={directLink ? undefined : "Direktlänken till annonsen kunde inte verifieras"}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/60"
            >
              {directLink ? "Öppna annons" : "Öppna källa"}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
          {onVerify && status !== "match" && (
            <Button size="sm" variant="secondary" onClick={() => onVerify(finding)}>
              Verifiera
            </Button>
          )}
          <span className="mono-label truncate">{host(link) ?? "okänd källa"}</span>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground"
            aria-expanded={open}
          >
            {open ? "Visa mindre" : "Visa mer"}
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        </div>

        {open && (
          <div className="space-y-3 border-t border-border pt-3">
            {verdict?.requirements.length ? (
              <ul className="space-y-1 text-sm">
                {verdict.requirements.map((r) => (
                  <li key={r.attribute} className="flex gap-2">
                    <span>{statusIcon[r.status]}</span>
                    <span className={r.status === "match" ? "" : "text-muted-foreground"}>
                      {r.label}
                      {r.source === "user" && " — verifierad av dig"}
                      {r.image && r.image.confidence !== "none" && (
                        <> · bildanalys: {r.image.observation} ({r.image.confidence === "high" ? "hög" : "låg"} confidence)</>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              snapshot.match_reason && <p className="text-sm text-muted-foreground">{snapshot.match_reason}</p>
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
export function ListingRail({
  findings,
  verdictOf,
  onVerify,
}: {
  findings: FindingLike[];
  verdictOf?: ((finding: FindingLike) => EffectiveVerdict | undefined) | undefined;
  onVerify?: ((finding: FindingLike) => void) | undefined;
}) {
  return (
    <>
      <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:hidden">
        {findings.map((f) => (
          <div key={f.id} className="w-[85%] shrink-0 snap-center">
            <ListingCard finding={f} verdict={verdictOf?.(f)} onVerify={onVerify} />
          </div>
        ))}
      </div>
      <div className="hidden gap-4 sm:grid sm:grid-cols-2 xl:grid-cols-3">
        {findings.map((f) => (
          <ListingCard key={f.id} finding={f} verdict={verdictOf?.(f)} onVerify={onVerify} />
        ))}
      </div>
    </>
  );
}
