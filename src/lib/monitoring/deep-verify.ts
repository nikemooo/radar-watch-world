/**
 * Deep verification — pure, category-agnostic.
 *
 * The deterministic gate (criteria.ts) answers "does a STATED ATTRIBUTE satisfy
 * this constraint?". That is the right question for numbers (price, area, year)
 * but the wrong one for everything a listing expresses in prose: a flat does
 * not carry a `view_type` field, it carries a sentence saying "från balkongen
 * har man utsikt över Stockholms inlopp".
 *
 * This module joins the two: for a requirement the attribute gate could not
 * settle, it consults what the semantic reader actually found in the listing's
 * own text and structured data, and turns that into the same match/reject/
 * unverified vocabulary — carrying the verbatim evidence with it.
 *
 * Invariants:
 *  - a proven attribute verdict is NEVER weakened or overwritten here;
 *  - a criterion is only confirmed from evidence read on the item's own page
 *    or its structured data — a search snippet alone is never a confirmation
 *    once the page itself was successfully read;
 *  - if the page could not be opened, the requirement is reported as
 *    "could not be verified — page unreachable", never as "not mentioned".
 */
import { isPreferred, type CriterionOutcome, type HardConstraint, type MatchStatus, type MatchVerdict } from "./criteria";
import { fold, type SemanticStatus, type StoredSemantic } from "./semantic";

export type FetchOutcome =
  | { status: "ok" }
  | { status: "failed"; reason: string }
  | { status: "not_attempted" };

export interface VerificationEvidence {
  /** verbatim quote from the source */
  snippet: string | null;
  source_url: string | null;
  /** which part of the page the quote came from */
  source_label: string | null;
  method: string;
  confidence: number | null;
  /** Short normalized meaning of the quoted evidence. */
  interpretation: string | null;
}

/** One requirement, as it should be shown to the user. */
export interface VerifiedRequirement {
  attribute: string;
  label: string;
  status: MatchStatus;
  /** The richer verdict behind the status. */
  verdict: SemanticStatus | "verified" | "rejected";
  reason: string;
  evidence: VerificationEvidence | null;
  source: "attribute" | "semantic" | "fetch_failure";
  /** Requirement or preference. Preferences rank, they never block. */
  priority: "required" | "preferred";
}

export interface DeepVerdict extends MatchVerdict {
  requirements: VerifiedRequirement[];
  /** True when at least one requirement is open only because of a fetch error. */
  blockedByFetch: boolean;
  /** 0-100 quality score. Never overrides a hard requirement. */
  score: number;
}


function textOfConstraint(c: HardConstraint): string[] {
  return [String(c.value ?? ""), ...(c.aliases ?? []), c.label ?? "", c.attribute]
    .map((s) => s.trim())
    .filter(Boolean);
}

function isTextConstraint(c: HardConstraint): boolean {
  return c.op === "includes" || c.op === "excludes";
}

/** Find the semantic verdict that speaks about this requirement. */
export function linkSemantic(c: HardConstraint, semantics: StoredSemantic[]): StoredSemantic | null {
  const wordings = textOfConstraint(c).map(fold);
  let best: StoredSemantic | null = null;
  const rank: Record<SemanticStatus, number> = {
    confirmed: 5,
    contradicted: 4,
    probable: 3,
    unfetchable: 2,
    unknown: 1,
  };
  for (const s of semantics) {
    const phrase = fold(s.phrase);
    if (!phrase) continue;
    const hit = wordings.some((w) => w === phrase || (w.length > 3 && phrase.includes(w)) || (phrase.length > 3 && w.includes(phrase)));
    if (!hit) continue;
    if (!best || rank[s.status] > rank[best.status]) best = s;
  }
  return best;
}

function evidenceOf(s: StoredSemantic): VerificationEvidence {
  return {
    snippet: s.snippet,
    source_url: s.source_url,
    source_label: s.source_label ?? null,
    method: s.method ?? "vocabulary",
    confidence: s.confidence,
    interpretation: s.interpretation ?? s.reason,
  };
}

function labelOf(c: HardConstraint): string {
  return c.label ?? `${c.attribute} ${c.op} ${c.value}`;
}

/**
 * Merge attribute outcomes with semantic evidence and the page's fetch state.
 * Returns the final verdict plus a per-requirement, UI-ready explanation.
 */
export function deepVerify(
  base: MatchVerdict,
  semantics: StoredSemantic[],
  fetch: FetchOutcome = { status: "ok" },
): DeepVerdict {
  const requirements: VerifiedRequirement[] = [];
  const outcomes: CriterionOutcome[] = [];
  let blockedByFetch = false;

  for (const outcome of base.outcomes) {
    const c = outcome.constraint;
    // Proven results stand — evidence never weakens or overrides arithmetic.
    if (outcome.status !== "unverified") {
      outcomes.push(outcome);
      requirements.push({
        attribute: c.attribute,
        label: labelOf(c),
        status: outcome.status,
        verdict: outcome.status === "match" ? "verified" : "rejected",
        reason: outcome.reason,
        evidence: outcome.observedRaw ? { snippet: outcome.observedRaw, source_url: null, source_label: "stated attribute", method: "attribute", confidence: 0.95, interpretation: outcome.reason } : null,
        source: "attribute",
        priority: isPreferred(c) ? "preferred" : "required",
      });
      continue;
    }

    const semantic = isTextConstraint(c) ? linkSemantic(c, semantics) : null;

    if (semantic && semantic.status !== "unknown" && semantic.status !== "unfetchable") {
      const positive = semantic.status === "confirmed";
      const negative = semantic.status === "contradicted";
      const wants = c.op !== "excludes";
      let status: MatchStatus = "unverified";
      if (positive) status = wants ? "match" : "reject";
      else if (negative) status = wants ? "reject" : "match";

      const reason =
        status === "unverified"
          ? `${labelOf(c)} is only suggested, not stated — ${semantic.reason}`
          : semantic.reason;
      outcomes.push({ ...outcome, status, reason });
      requirements.push({
        attribute: c.attribute,
        label: labelOf(c),
        status,
        verdict: semantic.status,
        reason,
        evidence: evidenceOf(semantic),
        source: "semantic",
        priority: isPreferred(c) ? "preferred" : "required",
      });
      continue;
    }

    if (fetch.status === "failed") {
      blockedByFetch = true;
      const reason = `could not verify ${labelOf(c)} — the listing page could not be opened (${fetch.reason})`;
      outcomes.push({ ...outcome, reason });
      requirements.push({
        attribute: c.attribute,
        label: labelOf(c),
        status: "unverified",
        verdict: "unfetchable",
        reason,
        evidence: semantic ? evidenceOf(semantic) : null,
        source: "fetch_failure",
        priority: isPreferred(c) ? "preferred" : "required",
      });
      continue;
    }

    outcomes.push(outcome);
    // Never "could not be verified" on its own: say WHY it is still open.
    const openReason = semantic
      ? semantic.status === "probable"
        ? `${labelOf(c)} — only adjacent wording was found on the page ("${semantic.snippet ?? semantic.reason}"), which does not state it`
        : `${labelOf(c)} — the listing page was read, but it never states this`
      : fetch.status === "not_attempted"
        ? `${labelOf(c)} — the listing page was never opened, so nothing about it was read`
        : `${labelOf(c)} — no evidence for it was found anywhere on the listing page`;
    requirements.push({
      attribute: c.attribute,
      label: labelOf(c),
      status: "unverified",
      verdict: semantic?.status ?? "unknown",
      reason: openReason,
      evidence: semantic ? evidenceOf(semantic) : null,
      source: semantic ? "semantic" : "attribute",
      priority: isPreferred(c) ? "preferred" : "required",
    });
  }

  const score = matchScore(requirements);
  if (outcomes.length === 0) {
    return { ...base, outcomes, requirements, blockedByFetch, score };
  }
  // Requirements decide the verdict; preferences only move the score.
  const deciding = outcomes.filter((o) => !isPreferred(o.constraint));
  const rejected = deciding.find((o) => o.status === "reject");
  if (rejected) {
    return { status: "reject", reason: rejected.reason, outcomes, requirements, blockedByFetch, score };
  }
  const open = deciding.filter((o) => o.status === "unverified");
  if (open.length > 0) {
    return {
      status: "unverified",
      reason: open.map((o) => o.reason).join("; "),
      outcomes,
      requirements,
      blockedByFetch,
      score,
    };
  }
  return {
    status: "match",
    reason: (deciding.length > 0 ? deciding : outcomes).map((o) => o.reason).join("; "),
    outcomes,
    requirements,
    blockedByFetch,
    score,
  };
}

/**
 * 0-100 quality score. Hard requirements carry most of the weight and a failed
 * one is fatal to the score, exactly as it is fatal to the verdict; preferences
 * add the rest. The score never decides match/reject — it only ranks.
 */
export function matchScore(requirements: VerifiedRequirement[]): number {
  const required = requirements.filter((r) => r.priority !== "preferred");
  const preferred = requirements.filter((r) => r.priority === "preferred");
  if (required.length === 0 && preferred.length === 0) return 0;
  const value = (r: VerifiedRequirement) => (r.status === "match" ? 1 : r.status === "reject" ? 0 : 0.35);
  const hardPart = required.length === 0 ? 1 : required.reduce((sum, r) => sum + value(r), 0) / required.length;
  const softPart = preferred.length === 0 ? null : preferred.reduce((sum, r) => sum + value(r), 0) / preferred.length;
  const combined = softPart === null ? hardPart : hardPart * 0.75 + softPart * 0.25;
  return Math.round(combined * 100);
}

/** Storable, UI-safe requirement rows. */
export function storableRequirements(reqs: VerifiedRequirement[]): VerifiedRequirement[] {
  return reqs.map((r) => ({
    ...r,
    reason: r.reason.slice(0, 300),
    evidence: r.evidence
      ? { ...r.evidence, snippet: r.evidence.snippet ? r.evidence.snippet.slice(0, 300) : null }
      : null,
  }));
}

export function storedRequirementsOf(value: unknown): VerifiedRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is VerifiedRequirement =>
      !!r && typeof r === "object" && typeof (r as VerifiedRequirement).attribute === "string" && typeof (r as VerifiedRequirement).status === "string",
  );
}
