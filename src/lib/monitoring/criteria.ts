/**
 * Deterministic criteria matching.
 *
 * Relevance wording is a language problem, but "is this item inside the user's
 * stated constraints?" is not — it is arithmetic and string containment over
 * facts that were actually read from a source. This module answers that
 * question WITHOUT a model, so every match and every rejection carries an
 * exact, reproducible reason.
 *
 * Rules:
 *  - a constraint can only be judged against a stated/structured fact;
 *  - a missing or non-comparable fact is UNVERIFIED, never a pass;
 *  - a value in another currency is never silently compared;
 *  - nothing here ever says "probably".
 */
import type { AttributeValue } from "./normalize";

export type ConstraintOp = "lte" | "lt" | "gte" | "gt" | "eq" | "neq" | "includes" | "excludes";

/** One machine-checkable requirement derived from the user's own request. */
export interface HardConstraint {
  /** Attribute key from the radar's attribute schema, e.g. "price". */
  attribute: string;
  op: ConstraintOp;
  /** Number for numeric ops, token for text ops. */
  value: number | string;
  /** ISO currency for monetary ceilings/floors. Compared, never converted. */
  currency?: string | null;
  /** Equivalent spellings/translations of a text token ("black", "svart"). */
  aliases?: string[];
  /** Human-readable form used in reasons ("price < 600 000 SEK"). */
  label?: string;
}

export type MatchStatus = "match" | "reject" | "unverified";

export interface CriterionOutcome {
  constraint: HardConstraint;
  status: MatchStatus;
  /** Exact reason, e.g. "price = 714 800 SEK >= 600 000 SEK". */
  reason: string;
  observedRaw: string | null;
}

export interface MatchVerdict {
  status: MatchStatus;
  /** First failing reason, or a summary of what was verified. */
  reason: string;
  outcomes: CriterionOutcome[];
}

export interface MatchSubject {
  title: string;
  attributes: Record<string, AttributeValue>;
  /** Normalized item value when the value attribute lives outside `attributes`. */
  numericValue: number | null;
  currency: string | null;
}

const OP_TEXT: Record<ConstraintOp, string> = {
  lte: "<=",
  lt: "<",
  gte: ">=",
  gt: ">",
  eq: "=",
  neq: "!=",
  includes: "includes",
  excludes: "excludes",
};

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Whole-word containment, accent- and case-insensitive. */
export function containsToken(haystack: string, token: string): boolean {
  const h = fold(haystack);
  const t = fold(token).trim();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "u").test(h);
}

function labelOf(c: HardConstraint): string {
  return c.label ?? `${c.attribute} ${OP_TEXT[c.op]} ${c.value}${c.currency ? ` ${c.currency}` : ""}`;
}

function isFactual(a: AttributeValue | undefined): a is AttributeValue {
  return !!a && (a.confidence === "stated" || a.confidence === "structured") && a.raw !== null;
}

function numericOf(
  subject: MatchSubject,
  constraint: HardConstraint,
): { value: number; currency: string | null; raw: string | null } | null {
  const attribute = subject.attributes[constraint.attribute];
  if (isFactual(attribute) && attribute.value !== null) {
    return { value: attribute.value, currency: attribute.currency, raw: attribute.raw };
  }
  // Monetary constraints may also be checked against the item's own normalized
  // value, which the engine derives from the same stated attribute.
  if (constraint.currency && subject.numericValue !== null) {
    return { value: subject.numericValue, currency: subject.currency, raw: null };
  }
  return null;
}

function textOf(subject: MatchSubject, constraint: HardConstraint): { text: string; raw: string | null } | null {
  const attribute = subject.attributes[constraint.attribute];
  if (isFactual(attribute)) return { text: attribute.raw!, raw: attribute.raw };
  return null;
}

/** Evaluate one constraint against one item. Pure and fully explainable. */
export function evaluateConstraint(subject: MatchSubject, constraint: HardConstraint): CriterionOutcome {
  const label = labelOf(constraint);

  if (constraint.op === "includes" || constraint.op === "excludes") {
    const tokens = [String(constraint.value), ...(constraint.aliases ?? [])].filter(Boolean);
    const field = textOf(subject, constraint);
    const haystacks = field ? [field.text] : [];
    const found = tokens.some((t) => haystacks.some((h) => containsToken(h, t)));
    if (!field) {
      // The title is only strong enough to REJECT on an excluded token; it is
      // never strong enough to confirm an attribute the item never stated.
      if (constraint.op === "excludes" && tokens.some((t) => containsToken(subject.title, t))) {
        return {
          constraint,
          status: "reject",
          reason: `${constraint.attribute} contains excluded term "${constraint.value}" (from title)`,
          observedRaw: subject.title,
        };
      }
      return {
        constraint,
        status: "unverified",
        reason: `${constraint.attribute} unknown — cannot safely verify ${label}`,
        observedRaw: null,
      };
    }
    if (constraint.op === "includes") {
      return found
        ? { constraint, status: "match", reason: `${constraint.attribute} = "${field.raw}" satisfies ${label}`, observedRaw: field.raw }
        : {
            constraint,
            status: "reject",
            reason: `${constraint.attribute} = "${field.raw}" does not match required "${constraint.value}"`,
            observedRaw: field.raw,
          };
    }
    return found
      ? {
          constraint,
          status: "reject",
          reason: `${constraint.attribute} = "${field.raw}" contains excluded term "${constraint.value}"`,
          observedRaw: field.raw,
        }
      : { constraint, status: "match", reason: `${constraint.attribute} = "${field.raw}" satisfies ${label}`, observedRaw: field.raw };
  }

  const observed = numericOf(subject, constraint);
  if (!observed) {
    return {
      constraint,
      status: "unverified",
      reason: `${constraint.attribute} unknown — cannot safely verify ${label}`,
      observedRaw: null,
    };
  }
  if (constraint.currency && observed.currency && observed.currency !== constraint.currency) {
    return {
      constraint,
      status: "unverified",
      reason: `${constraint.attribute} is stated in ${observed.currency} and cannot be compared with ${constraint.currency} without conversion`,
      observedRaw: observed.raw,
    };
  }

  const target = Number(constraint.value);
  if (!Number.isFinite(target)) {
    return { constraint, status: "unverified", reason: `constraint ${label} is not numeric`, observedRaw: observed.raw };
  }
  const pass =
    constraint.op === "lte"
      ? observed.value <= target
      : constraint.op === "lt"
        ? observed.value < target
        : constraint.op === "gte"
          ? observed.value >= target
          : constraint.op === "gt"
            ? observed.value > target
            : constraint.op === "eq"
              ? observed.value === target
              : observed.value !== target;

  const shown = `${constraint.attribute} = ${observed.value}${observed.currency ? ` ${observed.currency}` : ""}`;
  const inverse: Record<string, string> = { lte: ">", lt: ">=", gte: "<", gt: "<=", eq: "!=", neq: "=" };
  return pass
    ? { constraint, status: "match", reason: `${shown} satisfies ${label}`, observedRaw: observed.raw }
    : {
        constraint,
        status: "reject",
        reason: `${shown} ${inverse[constraint.op]} ${target}${constraint.currency ? ` ${constraint.currency}` : ""}`,
        observedRaw: observed.raw,
      };
}

/**
 * Combined verdict: any rejection rejects, any unverifiable constraint keeps
 * the item out of the "confirmed match" set. Only fully verified items match.
 */
export function evaluateCriteria(subject: MatchSubject, constraints: HardConstraint[]): MatchVerdict {
  if (constraints.length === 0) {
    return { status: "unverified", reason: "no machine-checkable constraints defined for this radar", outcomes: [] };
  }
  const outcomes = constraints.map((c) => evaluateConstraint(subject, c));
  const rejected = outcomes.find((o) => o.status === "reject");
  if (rejected) return { status: "reject", reason: rejected.reason, outcomes };
  const unverified = outcomes.filter((o) => o.status === "unverified");
  if (unverified.length > 0) {
    return { status: "unverified", reason: unverified.map((o) => o.reason).join("; "), outcomes };
  }
  return { status: "match", reason: outcomes.map((o) => o.reason).join("; "), outcomes };
}

/** Constraints usable for a radar: explicit ones, else the stated value range. */
export function radarConstraints(config: {
  hard_constraints?: HardConstraint[];
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  attribute_schema: { key: string; kind: string }[];
}): HardConstraint[] {
  const explicit = (config.hard_constraints ?? []).filter(
    (c) => c && typeof c.attribute === "string" && c.attribute.length > 0 && c.op in OP_TEXT,
  );
  if (explicit.length > 0) return explicit;

  const moneyKey = config.attribute_schema.find((s) => s.kind === "money")?.key;
  if (!moneyKey) return [];
  const derived: HardConstraint[] = [];
  if (config.price_max !== null) {
    derived.push({
      attribute: moneyKey,
      op: "lt",
      value: config.price_max,
      currency: config.currency,
      label: `${moneyKey} < ${config.price_max}${config.currency ? ` ${config.currency}` : ""}`,
    });
  }
  if (config.price_min !== null) {
    derived.push({
      attribute: moneyKey,
      op: "gte",
      value: config.price_min,
      currency: config.currency,
      label: `${moneyKey} >= ${config.price_min}${config.currency ? ` ${config.currency}` : ""}`,
    });
  }
  return derived;
}
