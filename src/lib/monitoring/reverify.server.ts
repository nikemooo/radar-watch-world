/**
 * Re-verification pass — better evidence, never weaker criteria.
 *
 * This runs over findings that ALREADY exist, without a new discovery sweep.
 * For every requirement the deterministic gate could not verify, it re-reads
 * evidence that was already retrieved for exactly that listing:
 *
 *   1. the attributes already stored on the finding
 *   2. the detail-page / source snippets stored for the same item URL
 *   3. the listing's own title and stored summary
 *   4. the listing's own photo, when one was published (optional, opt-in)
 *
 * Text evidence may produce `stated`/`structured` attributes, so it can turn an
 * unverified listing into a real match. Photo evidence never can: it is stored
 * as a separate observation with its own confidence and is only ever shown to
 * the user — the criteria gate itself is untouched.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { chatJson, MODELS } from "../ai/gateway.server";
import { asConfig } from "../radar-types";
import { asAttributeMap, extractDetailAttributes } from "./attributes.server";
import { evaluateCriteria, radarConstraints, type MatchStatus } from "./criteria";
import type { AttributeSpec, AttributeValue } from "./normalize";
import type { ImageObservation } from "./verification";

type Db = SupabaseClient<Database>;
type FindingRow = Database["public"]["Tables"]["findings"]["Row"];
type RadarRow = Database["public"]["Tables"]["radars"]["Row"];

export interface ReverifyChange {
  findingId: string;
  title: string;
  url: string | null;
  from: MatchStatus;
  to: MatchStatus;
  /** Attributes that gained a factual value during this pass. */
  verifiedAttributes: {
    attribute: string;
    raw: string;
    confidence: string;
    sourceUrl: string | null;
  }[];
  reason: string;
}

export interface ReverifyReport {
  radarId: string;
  considered: number;
  before: Record<MatchStatus, number>;
  after: Record<MatchStatus, number>;
  changes: ReverifyChange[];
  imageObservations: number;
  costEstimate: number;
}

const TEXT_BATCH = 5;
/** Rough per-call cost used only for the admin cost estimate. */
const CALL_COST = 0.004;
const IMAGE_CALL_COST = 0.006;

function snapshotObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function outcomesOf(snapshot: Record<string, unknown>) {
  const raw = snapshot["criteria"];
  return Array.isArray(raw) ? raw : [];
}

function statusOf(snapshot: Record<string, unknown>): MatchStatus {
  const s = snapshot["match_status"];
  return s === "match" || s === "reject" ? s : "unverified";
}

/** Attribute keys the gate still could not verify for this finding. */
function unresolvedAttributes(snapshot: Record<string, unknown>): string[] {
  return outcomesOf(snapshot)
    .filter((o) => (o as { status?: string }).status === "unverified")
    .map((o) => (o as { constraint?: { attribute?: string } }).constraint?.attribute)
    .filter((a): a is string => typeof a === "string" && a.length > 0);
}

const imageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["observations"],
  properties: {
    observations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["attribute", "observation", "value", "confidence"],
        properties: {
          attribute: { type: "string" },
          observation: { type: "string" },
          value: { type: ["string", "null"] },
          confidence: { type: "string", enum: ["high", "low", "none"] },
        },
      },
    },
  },
} as const;

/**
 * Look at the listing's own photo for the attributes the text never stated.
 * The prompt forbids guessing: anything not clearly visible must come back as
 * confidence "none".
 */
export async function readImageEvidence(
  imageUrl: string,
  attributes: { key: string; label: string }[],
): Promise<ImageObservation[]> {
  const result = await chatJson<{
    observations: { attribute: string; observation: string; value: string | null; confidence: "high" | "low" | "none" }[];
  }>({
    model: MODELS.fast,
    schemaName: "listing_image_observations",
    schema: imageSchema,
    images: [imageUrl],
    system:
      "You look at ONE photo from a marketplace listing and report only what is plainly visible. " +
      "Never guess, never infer from context, never use prior knowledge about the model. " +
      "confidence 'high' only when the attribute is unmistakable in the photo; 'low' when it is likely but lighting, " +
      "angle, crop or reflections leave real doubt; 'none' when the photo cannot show it — then value must be null. " +
      "An interior colour is never an exterior colour. A badge or logo must actually be legible before you name it. " +
      "observation must describe what you actually see, in one short sentence.",
    user: `Attributes to look for (report one entry per attribute):\n${attributes
      .map((a) => `${a.key} (${a.label})`)
      .join("\n")}`,
  });
  return (result.observations ?? [])
    .filter((o) => attributes.some((a) => a.key === o.attribute))
    .map((o) => ({ ...o, image_url: imageUrl }));
}

/**
 * Re-verify a radar's stored findings against evidence already on hand.
 * Nothing is fabricated: an attribute that no stored evidence states stays
 * unknown, and the listing stays in "needs verification".
 */
export async function reverifyRadarFindings(
  db: Db,
  radar: RadarRow,
  opts: { useImages?: boolean; imageBudget?: number; limit?: number } = {},
): Promise<ReverifyReport> {
  const config = asConfig(radar.config);
  const specs: AttributeSpec[] = config.attribute_schema ?? [];
  const constraints = radarConstraints({
    hard_constraints: config.hard_constraints,
    price_min: config.price_min,
    price_max: config.price_max,
    currency: config.currency,
    attribute_schema: specs,
  });

  const { data: rows } = await db
    .from("findings")
    .select("*")
    .eq("radar_id", radar.id)
    .order("last_seen_at", { ascending: false })
    .limit(opts.limit ?? 100);
  const findings = (rows ?? []) as FindingRow[];

  const before: Record<MatchStatus, number> = { match: 0, unverified: 0, reject: 0 };
  const after: Record<MatchStatus, number> = { match: 0, unverified: 0, reject: 0 };
  for (const f of findings) before[statusOf(snapshotObject(f.snapshot))] += 1;

  // Only listings that are still open questions are worth spending evidence on.
  const targets = findings.filter((f) => {
    const snapshot = snapshotObject(f.snapshot);
    return statusOf(snapshot) === "unverified" && unresolvedAttributes(snapshot).length > 0;
  });

  let costEstimate = 0;
  let imageObservations = 0;
  const changes: ReverifyChange[] = [];
  const newAttributes = new Map<string, Record<string, AttributeValue>>();
  const newImages = new Map<string, ImageObservation[]>();

  if (specs.length > 0 && targets.length > 0) {
    // 1-4. Text evidence already retrieved for this exact listing.
    const urls = targets
      .flatMap((f) => [f.primary_url, f.url])
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    const { data: sourceRows } = await db
      .from("research_sources")
      .select("url, title, snippet, retrieved_at")
      .eq("radar_id", radar.id)
      .in("url", Array.from(new Set(urls)).slice(0, 200));

    const evidenceByUrl = new Map<string, string[]>();
    for (const s of sourceRows ?? []) {
      const list = evidenceByUrl.get(s.url) ?? [];
      if (s.snippet) list.push(s.snippet);
      evidenceByUrl.set(s.url, list);
    }

    const pages = targets
      .map((f) => {
        const url = f.primary_url ?? f.url;
        if (!url) return null;
        const snapshot = snapshotObject(f.snapshot);
        const parts = [
          ...(evidenceByUrl.get(url) ?? []),
          typeof snapshot["summary"] === "string" ? (snapshot["summary"] as string) : "",
        ].filter(Boolean);
        const text = `${f.title}\n\n${parts.join("\n\n")}`.trim();
        if (text.length < 40) return null;
        return {
          url,
          final_url: url,
          title: f.title,
          text: text.slice(0, 6000),
          fetched_at: new Date().toISOString(),
          via: "exa" as const,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    for (let i = 0; i < pages.length; i += TEXT_BATCH) {
      const batch = pages.slice(i, i + TEXT_BATCH);
      const extracted = await extractDetailAttributes(batch, specs, config.interpretation || radar.raw_request);
      costEstimate += CALL_COST;
      for (const detail of extracted.details) {
        const target = targets.find((f) => (f.primary_url ?? f.url) === detail.url);
        if (target) newAttributes.set(target.id, detail.attributes);
      }
    }

    // 5. Photo evidence — display-only, never promotes a requirement.
    if (opts.useImages) {
      let budget = opts.imageBudget ?? 10;
      for (const f of targets) {
        if (budget <= 0) break;
        const snapshot = snapshotObject(f.snapshot);
        const image = typeof snapshot["image"] === "string" ? (snapshot["image"] as string) : null;
        if (!image) continue;
        const wanted = unresolvedAttributes(snapshot)
          .map((key) => specs.find((s) => s.key === key))
          .filter((s): s is AttributeSpec => !!s);
        if (wanted.length === 0) continue;
        try {
          const observations = await readImageEvidence(image, wanted);
          costEstimate += IMAGE_CALL_COST;
          budget -= 1;
          const useful = observations.filter((o) => o.confidence !== "none");
          if (useful.length > 0) {
            newImages.set(f.id, observations);
            imageObservations += useful.length;
          }
        } catch (err) {
          console.warn(`[radar:reverify] image evidence failed for ${f.id} — ${(err as Error).message}`);
        }
      }
    }
  }

  // Re-run the SAME deterministic gate over the merged evidence.
  for (const f of findings) {
    const snapshot = snapshotObject(f.snapshot);
    const previousStatus = statusOf(snapshot);
    const stored = asAttributeMap(f.attributes) ?? {};
    const fresh = newAttributes.get(f.id) ?? {};
    const images = newImages.get(f.id);

    // A stored factual value is never replaced by a weaker one.
    const merged: Record<string, AttributeValue> = { ...stored };
    const gained: ReverifyChange["verifiedAttributes"] = [];
    for (const [key, value] of Object.entries(fresh)) {
      const current = merged[key];
      const currentFactual = !!current && (current.confidence === "stated" || current.confidence === "structured");
      const nextFactual = value.confidence === "stated" || value.confidence === "structured";
      if (!currentFactual && nextFactual && value.raw) {
        merged[key] = value;
        gained.push({
          attribute: key,
          raw: value.raw,
          confidence: value.confidence,
          sourceUrl: value.source_url,
        });
      }
    }

    if (gained.length === 0 && !images) {
      after[previousStatus] += 1;
      continue;
    }

    const priceLike = Object.values(merged).find(
      (a) => a.currency !== null && a.value !== null && (a.confidence === "stated" || a.confidence === "structured"),
    );
    const numericValue = priceLike?.value ?? (f.numeric_value !== null ? Number(f.numeric_value) : null);
    const currency = priceLike?.currency ?? f.currency;

    const verdict = evaluateCriteria(
      { title: f.title, attributes: merged, numericValue, currency },
      constraints,
    );
    after[verdict.status] += 1;

    await db
      .from("findings")
      .update({
        attributes: merged as never,
        numeric_value: numericValue,
        currency,
        snapshot: {
          ...snapshot,
          match_status: verdict.status,
          match_reason: verdict.reason,
          criteria: verdict.outcomes as never,
          ...(images ? { image_evidence: images as never } : {}),
        } as never,
      })
      .eq("id", f.id);

    if (verdict.status !== previousStatus || gained.length > 0) {
      changes.push({
        findingId: f.id,
        title: f.title,
        url: f.primary_url ?? f.url,
        from: previousStatus,
        to: verdict.status,
        verifiedAttributes: gained,
        reason: verdict.reason,
      });
    }
  }

  return {
    radarId: radar.id,
    considered: targets.length,
    before,
    after,
    changes,
    imageObservations,
    costEstimate: Number(costEstimate.toFixed(4)),
  };
}
