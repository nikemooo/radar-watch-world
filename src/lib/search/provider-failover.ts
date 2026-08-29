/**
 * Discovery provider failover — pure, provider-agnostic, testable.
 *
 * Radar's discovery must survive a single external search provider running out
 * of credits, rate-limiting us or going down. This module owns three things and
 * nothing else:
 *
 *   1. Error CLASSIFICATION — turn an arbitrary provider failure into a stable
 *      class (quota / rate limit / temporary / network / unknown) and decide
 *      whether it justifies moving to the next provider.
 *   2. COOLDOWN — a provider that answered "no more credits" must not be paid
 *      for (or waited on) again on every following tick.
 *   3. ORDERED EXECUTION — try providers in priority order, stop at the first
 *      one that answers. A working primary means the fallback is never called,
 *      so the normal sweep costs exactly what it costs today.
 *
 * It knows nothing about Exa, about listings, or about the monitoring engine.
 * Result normalization, the candidate gate, dedupe and persistence are all
 * unchanged and happen downstream.
 */

export type ProviderErrorClass =
  | "quota_exceeded"
  | "rate_limited"
  | "temporary_error"
  | "network_error"
  | "unknown_error";

export interface ProviderFailure {
  class: ProviderErrorClass;
  /** Should we move on to the next discovery provider? */
  failover: boolean;
  /** How long this provider should be considered unavailable, in ms. */
  cooldownMs: number;
}

const QUOTA_PHRASES = [
  "no_more_credits",
  "no more credits",
  "exceeded your credits",
  "credits limit",
  "credits exhausted",
  "quota exceeded",
  "insufficient_quota",
  "out of credits",
  "payment required",
  "billing",
];

const RATE_PHRASES = ["rate limit", "rate_limit", "too many requests", "429"];

const NETWORK_PHRASES = [
  "fetch failed",
  "network",
  "econnreset",
  "enotfound",
  "socket",
  "timeout",
  "timed out",
  "aborted",
];

const HOUR = 60 * 60 * 1000;

/** Classify any provider failure. `status` 0 means "never reached the API". */
export function classifyProviderFailure(input: {
  status?: number | undefined;
  message?: string | undefined;
}): ProviderFailure {
  const status = input.status ?? -1;
  const message = (input.message ?? "").toLowerCase();
  const has = (phrases: string[]) => phrases.some((p) => message.includes(p));

  if (status === 402 || status === 403 || has(QUOTA_PHRASES)) {
    return { class: "quota_exceeded", failover: true, cooldownMs: 6 * HOUR };
  }
  if (status === 429 || has(RATE_PHRASES)) {
    return { class: "rate_limited", failover: true, cooldownMs: 10 * 60 * 1000 };
  }
  if (status === 0 || status === 408 || has(NETWORK_PHRASES)) {
    return { class: "network_error", failover: true, cooldownMs: 5 * 60 * 1000 };
  }
  if (status >= 500) {
    return { class: "temporary_error", failover: true, cooldownMs: 5 * 60 * 1000 };
  }
  // 4xx that is not quota/rate is a request problem: another provider may well
  // answer the same query, so we still fail over, but we do not punish the
  // provider with a cooldown.
  return { class: "unknown_error", failover: true, cooldownMs: 0 };
}

/** Per-process registry of temporarily unavailable providers. */
export class ProviderCooldowns {
  private until = new Map<string, number>();

  markUnavailable(id: string, ms: number, now = Date.now()): void {
    if (ms <= 0) return;
    const next = now + ms;
    if ((this.until.get(id) ?? 0) < next) this.until.set(id, next);
  }

  isAvailable(id: string, now = Date.now()): boolean {
    const until = this.until.get(id);
    if (until === undefined) return true;
    if (until <= now) {
      this.until.delete(id);
      return true;
    }
    return false;
  }

  clear(id?: string): void {
    if (id) this.until.delete(id);
    else this.until.clear();
  }

  snapshot(now = Date.now()): { provider: string; secondsRemaining: number }[] {
    return [...this.until.entries()]
      .filter(([, until]) => until > now)
      .map(([provider, until]) => ({
        provider,
        secondsRemaining: Math.round((until - now) / 1000),
      }));
  }
}

export interface FailoverProvider<Doc> {
  id: string;
  costPerRequest: number;
  isConfigured(): boolean;
  search(query: string, limit: number): Promise<Doc[]>;
}

export interface ProviderAttempt {
  provider: string;
  status: "ok" | "skipped_cooldown" | "not_configured" | "failed";
  errorClass?: ProviderErrorClass;
  message?: string;
  results?: number;
  cost?: number;
}

export interface FailoverOutcome<Doc> {
  documents: Doc[];
  /** The provider that actually answered, or null when all failed. */
  provider: string | null;
  attempts: ProviderAttempt[];
  fallbackUsed: boolean;
  cost: number;
  /** True when every configured provider failed — NOT "the market is empty". */
  discoveryFailed: boolean;
}

/**
 * Run one query through the provider chain, stopping at the first provider
 * that answers. Providers are attempted in the order given.
 */
export async function searchWithFailover<Doc>(input: {
  providers: FailoverProvider<Doc>[];
  query: string;
  limit: number;
  cooldowns: ProviderCooldowns;
  now?: number;
  /** Optional per-provider retry wrapper (used for transient in-provider retries). */
  execute?: (provider: FailoverProvider<Doc>, query: string, limit: number) => Promise<Doc[]>;
  log?: (line: string) => void;
}): Promise<FailoverOutcome<Doc>> {
  const now = input.now ?? Date.now();
  const attempts: ProviderAttempt[] = [];
  const log = input.log ?? ((line: string) => console.info(line));
  const execute = input.execute ?? ((p, q, l) => p.search(q, l));
  let cost = 0;
  let attemptedCount = 0;

  for (const provider of input.providers) {
    if (!provider.isConfigured()) {
      attempts.push({ provider: provider.id, status: "not_configured" });
      continue;
    }
    if (!input.cooldowns.isAvailable(provider.id, now)) {
      attempts.push({ provider: provider.id, status: "skipped_cooldown" });
      continue;
    }
    attemptedCount += 1;
    log(`[radar:discovery] provider_attempted=${provider.id} query="${input.query.slice(0, 120)}"`);
    try {
      const documents = await execute(provider, input.query, input.limit);
      cost += provider.costPerRequest;
      attempts.push({
        provider: provider.id,
        status: "ok",
        results: documents.length,
        cost: provider.costPerRequest,
      });
      const fallbackUsed = attemptedCount > 1 || attempts.some((a) => a.status === "skipped_cooldown");
      log(
        `[radar:discovery] provider_status=ok provider=${provider.id} results=${documents.length} fallback_triggered=${fallbackUsed}`,
      );
      return {
        documents,
        provider: provider.id,
        attempts,
        fallbackUsed,
        cost: Number(cost.toFixed(4)),
        discoveryFailed: false,
      };
    } catch (err) {
      cost += provider.costPerRequest;
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status;
      const failure = classifyProviderFailure({ status, message });
      input.cooldowns.markUnavailable(provider.id, failure.cooldownMs, now);
      attempts.push({
        provider: provider.id,
        status: "failed",
        errorClass: failure.class,
        message: message.slice(0, 300),
        cost: provider.costPerRequest,
      });
      log(
        `[radar:discovery] provider_status=failed provider=${provider.id} provider_error_class=${failure.class} cooldown_ms=${failure.cooldownMs}`,
      );
      if (!failure.failover) break;
    }
  }

  return {
    documents: [],
    provider: null,
    attempts,
    fallbackUsed: attempts.filter((a) => a.status === "failed").length > 1,
    cost: Number(cost.toFixed(4)),
    discoveryFailed: attempts.some((a) => a.status === "failed" || a.status === "skipped_cooldown"),
  };
}
