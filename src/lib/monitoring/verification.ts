/**
 * Verification model — pure, testable, model-free.
 *
 * The deterministic criteria gate (criteria.ts) is untouched: it still decides
 * what the MACHINE could prove from stated facts. This module layers two extra
 * kinds of evidence on top, WITHOUT ever weakening a criterion:
 *
 *   - image evidence  — an observation from the listing's own photos. It is
 *                       displayed with its own confidence and can NEVER turn
 *                       an unverified requirement into a machine match.
 *   - user evidence   — the owner's own judgement in the verification queue.
 *                       It resolves an unverified requirement, is always
 *                       labelled as user-verified, and never overwrites or
 *                       deletes the original source data.
 *
 * A requirement the machine PROVED false stays false: no user answer and no
 * image observation can promote a rejected listing to a match.
 */
import type { CriterionOutcome, MatchStatus } from "./criteria";

export type UserVerdict = "pass" | "fail" | "unknown";

export interface UserVerification {
  attribute: string;
  verdict: UserVerdict;
  note?: string | null;
}

/** One observation read from the listing's own photos. Never a proof. */
export interface ImageObservation {
  attribute: string;
  /** What was actually seen, in the model's words. */
  observation: string;
  /** Normalized reading, e.g. "black". Null when nothing could be determined. */
  value: string | null;
  confidence: "high" | "low" | "none";
  image_url: string;
}

export interface RequirementView {
  attribute: string;
  label: string;
  /** What the deterministic gate concluded. */
  autoStatus: MatchStatus;
  autoReason: string;
  observedRaw: string | null;
  /** The user's own answer, when they gave one. */
  userVerdict: UserVerdict | null;
  /** What the photos suggested, when photos were analysed. */
  image: ImageObservation | null;
  /** Combined status after user evidence (image evidence never changes it). */
  status: MatchStatus;
  source: "automated" | "user";
}

export interface EffectiveVerdict {
  status: MatchStatus;
  requirements: RequirementView[];
  /** Requirements that still block a match. */
  pending: RequirementView[];
  /** True when the current status depends on the user's own answers. */
  userInfluenced: boolean;
  reason: string;
}

export function outcomesOf(value: unknown): CriterionOutcome[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (o): o is CriterionOutcome =>
      !!o && typeof o === "object" && typeof (o as CriterionOutcome).status === "string",
  );
}

export function imageObservationsOf(value: unknown): ImageObservation[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (o): o is ImageObservation =>
      !!o && typeof o === "object" && typeof (o as ImageObservation).attribute === "string",
  );
}

function labelOf(outcome: CriterionOutcome): string {
  return outcome.constraint?.label ?? outcome.constraint?.attribute ?? "kriterium";
}

/**
 * Merge machine outcomes, image observations and user answers into one status.
 * Rules, in order:
 *   1. any machine-proved rejection  -> reject  (never overridable)
 *   2. any user "fail"               -> reject  (user-verified)
 *   3. every requirement passed      -> match
 *   4. anything else                 -> unverified
 */
export function effectiveVerdict(
  outcomes: CriterionOutcome[],
  verifications: UserVerification[] = [],
  images: ImageObservation[] = [],
): EffectiveVerdict {
  const byAttribute = new Map(verifications.map((v) => [v.attribute, v]));
  const imageByAttribute = new Map(images.map((i) => [i.attribute, i]));

  const requirements: RequirementView[] = outcomes.map((o) => {
    const attribute = o.constraint?.attribute ?? "";
    const user = byAttribute.get(attribute) ?? null;
    const image = imageByAttribute.get(attribute) ?? null;
    let status = o.status;
    let source: "automated" | "user" = "automated";
    if (o.status === "unverified" && user) {
      if (user.verdict === "pass") {
        status = "match";
        source = "user";
      } else if (user.verdict === "fail") {
        status = "reject";
        source = "user";
      }
    }
    return {
      attribute,
      label: labelOf(o),
      autoStatus: o.status,
      autoReason: o.reason,
      observedRaw: o.observedRaw ?? null,
      userVerdict: user?.verdict ?? null,
      image,
      status,
      source,
    };
  });

  if (requirements.length === 0) {
    return {
      status: "unverified",
      requirements,
      pending: [],
      userInfluenced: false,
      reason: "inga maskinkontrollerbara kriterier finns för den här radarn",
    };
  }

  const machineReject = requirements.find((r) => r.autoStatus === "reject");
  if (machineReject) {
    return {
      status: "reject",
      requirements,
      pending: [],
      userInfluenced: false,
      reason: machineReject.autoReason,
    };
  }
  const userReject = requirements.find((r) => r.status === "reject");
  if (userReject) {
    return {
      status: "reject",
      requirements,
      pending: [],
      userInfluenced: true,
      reason: `du markerade att kravet "${userReject.label}" inte uppfylls`,
    };
  }
  const pending = requirements.filter((r) => r.status !== "match");
  const userInfluenced = requirements.some((r) => r.source === "user");
  if (pending.length > 0) {
    return {
      status: "unverified",
      requirements,
      pending,
      userInfluenced,
      reason: pending.map((r) => r.autoReason).join("; "),
    };
  }
  return {
    status: "match",
    requirements,
    pending: [],
    userInfluenced,
    reason: requirements.map((r) => (r.source === "user" ? `${r.label} (verifierad av dig)` : r.autoReason)).join("; "),
  };
}

export const statusLabel: Record<MatchStatus, string> = {
  match: "Matchar",
  unverified: "Behöver verifieras",
  reject: "Matchar inte",
};
