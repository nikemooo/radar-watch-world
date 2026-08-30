/**
 * Listing card — the primary user-facing surface for one found item.
 *
 * Design intent: minimal by default (image, name, price, a few facts, one
 * market status), everything technical hidden behind "Visa mer". It never
 * invents a value: a missing fact is shown as missing, and a market value is
 * only claimed when the deterministic baseline says it may be.
 */
import { useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, ImageOff } from "lucide-react";
import { asBaseline, BaselinePanel } from "@/components/baseline-panel";
import { isFactual, type AttributeValue } from "@/lib/monitoring/normalize";
import { storedEvidenceOf, type StoredEvidence } from "@/lib/monitoring/evidence";
import { storedSemanticsOf, type StoredSemantic } from "@/lib/monitoring/semantic";
import { storedRequirementsOf, type VerifiedRequirement } from "@/lib/monitoring/deep-verify";
import { statusLabel, type EffectiveVerdict } from "@/lib/monitoring/verification";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n, useT, type TranslateVars, type TranslationKey } from "@/lib/i18n";

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
  image_status?: "from_listing" | "unavailable" | null;
  missing_attributes?: string[];
  criteria?: { label?: string; ok?: boolean | null; reason?: string }[];
  image_evidence?: unknown;
  evidence?: StoredEvidence[];
  identifiers?: { type: string; value: string; confidence: string }[];
  /** Canonical product identity resolved from all retrieved surfaces. */
  identity?: {
    status: "verified" | "probable" | "conflicted" | "unknown";
    canonical: string;
    explanation: string;
  } | null;

  /** Generic listing facts read from the source (rooms, area, address…). */
  listing_facts?: { key: string; raw: string; value: number | null; unit: string | null; confidence: string }[];
  item_type?: string | null;
  listing_status?: "active" | "sold" | "reserved" | "upcoming" | "unknown";
  listing_status_evidence?: string | null;
  /** The user's own criteria wording, judged against the sources. */
  semantic_criteria?: StoredSemantic[];
  /** Deep verification: one row per requirement, with verbatim evidence. */
  requirements?: VerifiedRequirement[];
  fetch_status?: "ok" | "failed" | "not_attempted" | null;
  fetch_error?: string | null;
  detail_telemetry?: {
    detail_fetch_started?: boolean;
    detail_fetch_completed?: boolean;
    detail_content_length?: number;
    detail_description_found?: boolean;
    detail_structured_data_found?: boolean;
    detail_address_found?: boolean;
    detail_facts_extracted?: number;
    final_listing_verdict?: string;
  } | null;

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

function money(value: number | null, currency: string | null, locale = "en"): string | null {
  if (value === null) return null;
  const rounded = Math.round(value).toLocaleString(locale);
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
function marketVerdict(
  baseline: unknown,
  t: (key: TranslationKey, vars?: TranslateVars) => string,
  locale: string,
) {
  const b = asBaseline(baseline);
  if (!b || b.status !== "computed" || !b.stats) return null;
  const pct = b.differencePct ?? 0;
  const tone = Math.abs(pct) < 5 ? "around" : pct < 0 ? "under" : "over";
  return {
    tone,
    label:
      tone === "around"
        ? t("listing.marketPrice")
        : t(tone === "under" ? "listing.underMarket" : "listing.overMarket", {
            pct: Math.abs(pct).toFixed(0),
          }),
    median: money(b.stats.median, b.currency, locale),
    count: b.stats.count,
  };
}

const statusTone: Record<MatchStatus, string> = {
  match: "bg-interesting/15 text-interesting",
  unverified: "bg-muted text-muted-foreground",
  reject: "bg-critical/10 text-critical",
};

const statusIcon: Record<MatchStatus, string> = { match: "✓", unverified: "⚠", reject: "✕" };

/** Evidence status is about knowledge, not about matching the criteria. */
const evidenceIcon: Record<StoredEvidence["status"], string> = {
  verified: "✓",
  probable: "~",
  conflicted: "⚠",
  unknown: "–",
};

const semanticIcon: Record<StoredSemantic["status"], string> = {
  confirmed: "✓",
  probable: "~",
  contradicted: "✕",
  unknown: "–",
  unfetchable: "⚠",
};

const semanticTone: Record<StoredSemantic["status"], string> = {
  confirmed: "",
  probable: "text-muted-foreground",
  contradicted: "text-critical",
  unknown: "text-muted-foreground",
  unfetchable: "text-warning",
};

/** Image gallery for one listing — only photos read from its own page. */
function Gallery({ images, alt, fallback }: { images: string[]; alt: string; fallback: React.ReactNode }) {
  const [index, setIndex] = useState(0);
  const [broken, setBroken] = useState<Record<number, boolean>>({});
  const usable = images.filter((_, i) => !broken[i]);
  if (images.length === 0 || usable.length === 0) return <>{fallback}</>;
  const current = Math.min(index, images.length - 1);
  return (
    <>
      <img
        src={images[current]}
        alt={alt}
        loading="lazy"
        className="size-full object-cover"
        onError={() => setBroken((b) => ({ ...b, [current]: true }))}
      />
      {images.length > 1 && (
        <>
          <button
            type="button"
            aria-label="previous photo"
            onClick={() => setIndex((i) => (i - 1 + images.length) % images.length)}
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-background/70 p-1 backdrop-blur hover:bg-background"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="next photo"
            onClick={() => setIndex((i) => (i + 1) % images.length)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-background/70 p-1 backdrop-blur hover:bg-background"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
          <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1">
            {images.slice(0, 10).map((src, i) => (
              <span
                key={src}
                className={cn("size-1.5 rounded-full", i === current ? "bg-foreground" : "bg-foreground/30")}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

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
  const t = useT();
  const { locale } = useI18n();
  const snapshot = snapshotOf(finding.snapshot);
  const attributes = attributesOf(finding.attributes);
  const link = finding.primary_url ?? finding.url;
  // Only claim "Öppna annons" when the pipeline proved the URL is the advert.
  const directLink = snapshot.link_status ? snapshot.link_status === "direct" : !!finding.primary_url;
  const market = marketVerdict(finding.baseline, t, locale);
  const price = money(finding.numeric_value, finding.currency, locale);
  const gallery = Array.from(
    new Set([...(snapshot.image ? [snapshot.image] : []), ...(snapshot.images ?? [])].filter(Boolean)),
  ) as string[];
  const semantic = storedSemanticsOf(snapshot.semantic_criteria);
  const deepRequirements = storedRequirementsOf(snapshot.requirements);
  const listingFacts = snapshot.listing_facts ?? [];
  const offerStatus = snapshot.listing_status ?? "unknown";
  const evidence = storedEvidenceOf(snapshot.evidence);
  const identifiers = snapshot.identifiers ?? [];
  const status: MatchStatus = verdict?.status ?? snapshot.match_status ?? "unverified";

  const meta = attributes
    .filter((a) => a.key !== "price" && !a.key.includes("url"))
    .slice(0, 3)
    .map((a) => a.raw);

  return (
    <article className="panel flex h-full flex-col overflow-hidden">
      <div className="relative aspect-[16/10] w-full bg-muted/40">
        <Gallery
          images={gallery}
          alt={finding.title}
          fallback={
            <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <ImageOff className="size-5" aria-hidden />
              <span className="text-xs">
                {snapshot.image_status === "unavailable" ? t("listing.imageUnavailable") : t("listing.noImage")}
              </span>
            </div>
          }
        />
        <span
          className={cn(
            "absolute left-3 top-3 rounded-full px-2.5 py-1 text-xs font-medium backdrop-blur",
            statusTone[status],
          )}
        >
          {statusIcon[status]} {t(`verify.status.${status}` as TranslationKey)}
        </span>
        {offerStatus !== "unknown" && offerStatus !== "active" && (
          <span
            className="absolute right-3 top-3 rounded-full bg-critical/15 px-2.5 py-1 text-xs font-medium text-critical backdrop-blur"
            title={snapshot.listing_status_evidence ?? undefined}
          >
            {t(`listing.offer.${offerStatus}` as TranslationKey)}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col space-y-3 p-4">
        <div>
          <h3 className="text-base font-medium leading-snug">{finding.title}</h3>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{price ?? t("listing.noPrice")}</p>
          {meta.length > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">{meta.join(" · ")}</p>
          )}
          {snapshot.identity && (
            <p
              className={`mt-1 text-xs ${
                snapshot.identity.status === "conflicted"
                  ? "text-critical"
                  : snapshot.identity.status === "verified"
                    ? "text-muted-foreground"
                    : "text-muted-foreground"
              }`}
              title={snapshot.identity.explanation}
            >
              {evidenceIcon[snapshot.identity.status]}{" "}
              {t(`listing.identity.${snapshot.identity.status}` as TranslationKey)} ·{" "}
              {snapshot.identity.canonical}
            </p>
          )}
        </div>


        {status === "unverified" && (verdict?.requirements.length ?? 0) > 0 && (
          <div className="rounded-md bg-muted/50 p-3 text-sm">
            <p className="font-medium">{t("listing.notVerified")}</p>
            {/* Per attribute — a single unverifiable criterion must never make
                the criteria that ARE verified look uncertain. */}
            <ul className="mt-1 space-y-0.5">
              {verdict!.requirements.slice(0, 6).map((r) => (
                <li key={r.attribute} className={r.status === "match" ? "" : "text-muted-foreground"}>
                  {statusIcon[r.status]} {r.label}
                  {r.status !== "match" && r.autoReason ? ` — ${r.autoReason}` : ""}
                </li>
              ))}
            </ul>
            {snapshot.missing_attributes?.length ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("listing.missingInfo", {
                  fields: snapshot.missing_attributes.slice(0, 5).map((k) => k.replace(/_/g, " ")).join(", "),
                })}
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
              {t("listing.marketValue", { median: market.median ?? "", count: market.count })}
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("listing.noMarketValue")}</p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              title={directLink ? undefined : t("listing.linkUnverified")}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/60"
            >
              {directLink ? t("verify.openListing") : t("verify.openSource")}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
          {onVerify && status !== "match" && (
            <Button size="sm" variant="secondary" onClick={() => onVerify(finding)}>
              {t("listing.verify")}
            </Button>
          )}
          <span className="mono-label truncate">{host(link) ?? t("listing.unknownSource")}</span>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground"
            aria-expanded={open}
          >
            {open ? t("listing.showLess") : t("listing.showMore")}
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
                      {r.source === "user" && t("listing.verifiedByYou")}
                      {r.image && r.image.confidence !== "none" && (
                        <>
                          {" "}
                          · {t("listing.imageAnalysis")}: {r.image.observation} (
                          {r.image.confidence === "high" ? t("listing.confidenceHigh") : t("listing.confidenceLow")})
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              snapshot.match_reason && <p className="text-sm text-muted-foreground">{snapshot.match_reason}</p>
            )}
            {deepRequirements.length > 0 && (
              <div className="space-y-1">
                <p className="mono-label">{t("listing.requirements")}</p>
                <ul className="space-y-2 text-sm">
                  {deepRequirements.map((r) => (
                    <li key={`deep-${r.attribute}-${r.label}`} className="flex gap-2">
                      <span aria-hidden>{statusIcon[r.status]}</span>
                      <span className={r.status === "match" ? "" : "text-muted-foreground"}>
                        <span className={r.status === "reject" ? "text-critical" : undefined}>{r.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {r.verdict === "unfetchable" ? t("listing.requirement.unreachable") : r.reason}
                        </span>
                        {r.evidence?.snippet && (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            “{r.evidence.snippet}”
                            {r.evidence.source_label && (
                              <span className="block">
                                {t("listing.requirement.source")}: {r.evidence.source_label}
                              </span>
                            )}
                          </span>
                        )}
                        {r.evidence?.interpretation && (
                          <span className="block text-xs text-muted-foreground">
                            {r.evidence.interpretation}
                            {r.evidence.confidence !== null
                              ? ` · ${Math.round(r.evidence.confidence * 100)}%`
                              : ""}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {semantic.length > 0 && (
              <div className="space-y-1">
                <p className="mono-label">{t("listing.criteriaEvidence")}</p>
                <ul className="space-y-1 text-sm">
                  {semantic.map((c) => (
                    <li key={c.phrase} className="flex gap-2">
                      <span aria-hidden>{semanticIcon[c.status]}</span>
                      <span className={semanticTone[c.status]}>
                        {c.phrase} · {t(`listing.semantic.${c.status}` as TranslationKey)}
                        {c.snippet && <span className="block text-xs text-muted-foreground">“{c.snippet}”</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {listingFacts.length > 0 && (
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {listingFacts.map((f) => (
                  <div key={f.key} className="flex gap-2">
                    <dt className="mono-label">{f.key.replace(/_/g, " ")}</dt>
                    <dd>{f.raw}</dd>
                  </div>
                ))}
              </dl>
            )}
            {evidence.length > 0 && (
              <div className="space-y-1">
                <p className="mono-label">{t("listing.whatWeKnow")}</p>
                <ul className="space-y-1 text-sm">
                  {evidence.map((e) => (
                    <li key={e.attribute} className="flex gap-2">
                      <span aria-hidden>{evidenceIcon[e.status]}</span>
                      <span className={e.status === "unknown" ? "text-muted-foreground" : ""}>
                        <span className="mono-label">{e.attribute.replace(/_/g, " ")}</span>{" "}
                        {e.raw ?? "—"}{" "}
                        <span className="text-muted-foreground">
                          · {t(`listing.evidence.${e.status}` as TranslationKey)}
                          {e.status !== "unknown" &&
                            ` · ${t("listing.evidence.sources", { count: e.sources.length })}`}
                        </span>
                        {e.conflict && (
                          <span className="block text-xs text-critical">{e.explanation}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                {identifiers.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("listing.identifiers")}:{" "}
                    {identifiers.map((i) => `${i.type.toUpperCase()} ${i.value}`).join(" · ")}
                  </p>
                )}
              </div>
            )}
            {attributes.length > 0 && (

              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {attributes.map((a) => (
                  <div key={a.key} className="flex gap-2">
                    <dt className="mono-label">{a.key.replace(/_/g, " ")}</dt>
                    <dd className={isFactual(a) ? "" : "italic text-muted-foreground"}>
                      {a.raw}
                      {!isFactual(a) && t("listing.interpreted")}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <BaselinePanel baseline={finding.baseline} />
            {snapshot.detail_telemetry && (
              <dl className="grid gap-x-6 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground sm:grid-cols-2">
                <div><dt className="mono-label">Page read</dt><dd>{snapshot.detail_telemetry.detail_fetch_completed ? "completed" : "not completed"}</dd></div>
                <div><dt className="mono-label">Content</dt><dd>{snapshot.detail_telemetry.detail_content_length ?? 0} characters</dd></div>
                <div><dt className="mono-label">Description</dt><dd>{snapshot.detail_telemetry.detail_description_found ? "found" : "not found"}</dd></div>
                <div><dt className="mono-label">Structured data</dt><dd>{snapshot.detail_telemetry.detail_structured_data_found ? "found" : "not found"}</dd></div>
                <div><dt className="mono-label">Address</dt><dd>{snapshot.detail_telemetry.detail_address_found ? "found" : "not found"}</dd></div>
                <div><dt className="mono-label">Facts</dt><dd>{snapshot.detail_telemetry.detail_facts_extracted ?? 0}</dd></div>
              </dl>
            )}
            <p className="mono-label">
              {t("listing.seen", {
                first: new Date(finding.first_seen_at).toLocaleDateString(locale),
                last: new Date(finding.last_seen_at).toLocaleDateString(locale),
                detail:
                  finding.detail_status === "fetched" || finding.detail_status === "verified"
                    ? t("listing.detailRead")
                    : t("listing.detailListingOnly"),
              })}
              {snapshot.image_source ? t("listing.imageFromListing") : ""}
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
