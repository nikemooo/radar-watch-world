/**
 * Deep-verification queue.
 *
 * Discovery can produce dozens of candidates; reading each one is a slow,
 * failure-prone network operation. Doing all of them inside ONE checkpointed
 * step is what made a sweep stall: the serverless worker ended somewhere in
 * the middle of the batch, nothing was persisted, and every resume paid for
 * the same unfinished batch again — "30 annonser hittade, 0 lästa i detalj",
 * forever.
 *
 * This module turns that batch into a queue with per-candidate durability:
 *
 *   - candidates are deduplicated by canonical URL before anything is fetched;
 *   - the queue is processed in small chunks, each its OWN checkpoint, so the
 *     work already done survives an interruption and is never repeated;
 *   - a chunk that hangs is cut off by its own timeout and recorded as such,
 *     so one problematic website can never consume the sweep;
 *   - every candidate ends in an explicit state (queued/fetching/fetched/
 *     verified/failed_to_open/timeout/blocked/skipped) and progress is
 *     reported after EVERY chunk, so the UI counts up live;
 *   - a run-level time budget bounds the whole stage; whatever is left over is
 *     reported as remaining instead of silently dropped.
 *
 * It is completely category-agnostic and does no I/O itself — the fetcher and
 * the checkpoint step are injected, which is also what makes it testable.
 */

/** Explicit lifecycle state of one candidate in the deep-verification queue. */
export type CandidateState =
  | "queued"
  | "fetching"
  | "fetched"
  | "verified"
  | "failed_to_open"
  | "timeout"
  | "blocked"
  | "skipped";

export interface CandidateProgress {
  url: string;
  state: CandidateState;
  reason: string | null;
}

export interface DetailQueueTelemetry {
  detail_queue_created: number;
  detail_candidates_started: number;
  detail_candidates_completed: number;
  detail_candidates_failed: number;
  detail_candidates_blocked: number;
  detail_candidates_timeout: number;
  detail_candidates_cached: number;
  detail_candidates_remaining: number;
}

export interface DetailFetchLike<P> {
  pages: P[];
  failures: { url: string; reason: string }[];
  costEstimate: number;
}

export interface DetailQueueResult<P> extends DetailFetchLike<P> {
  /** Failures, classified into the state vocabulary above. */
  classified: { url: string; reason: string; state: CandidateState }[];
  states: Map<string, CandidateProgress>;
  telemetry: DetailQueueTelemetry;
  /** Candidates the budget did not reach — never silently dropped. */
  remaining: string[];
  budgetExhausted: boolean;
  elapsedMs: number;
}

export interface DetailQueueOptions<P extends { url: string }> {
  urls: string[];
  /** Real page fetcher (injected so this module stays pure and testable). */
  fetchPages: (urls: string[]) => Promise<DetailFetchLike<P>>;
  /** Checkpointed step runner — one call per chunk, so progress is durable. */
  step: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  /** URLs whose stored extraction is still valid (content hash unchanged). */
  cachedUrls?: Iterable<string> | undefined;
  chunkSize?: number | undefined;
  /** Hard cut-off for one chunk, so a hanging site cannot block the queue. */
  chunkTimeoutMs?: number | undefined;
  /** Wall-clock budget for the whole deep-verification stage in this run. */
  budgetMs?: number | undefined;
  onProgress?: (update: {
    telemetry: DetailQueueTelemetry;
    changed: CandidateProgress[];
  }) => Promise<void> | void;
  now?: (() => number) | undefined;
}

/** Default chunk size: small enough to checkpoint often, large enough to be fast. */
export const DEFAULT_CHUNK_SIZE = 3;
/** One chunk never gets longer than this, whatever the remote site does. */
export const DEFAULT_CHUNK_TIMEOUT_MS = 25_000;
/** Deep verification never eats more than this much wall clock per run. */
export const DEFAULT_DETAIL_BUDGET_MS = 150_000;

/** Strip tracking noise and trailing slashes so one advert is queued once. */
export function canonicalQueueUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|mc_|ref|referrer|campaign)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = "";
    u.hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url.trim();
  }
}

/** Deduplicate by canonical URL, keeping the first (highest priority) spelling. */
export function dedupeQueue(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!url) continue;
    const key = canonicalQueueUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export function chunkQueue<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += n) chunks.push(items.slice(i, i + n));
  return chunks;
}

/**
 * Turn a fetch failure reason into an explicit state.
 * A page we could not open is NEVER "unknown" — it is a knowledge gap with a
 * cause, and the cause is what the UI shows the user.
 */
export function classifyFetchFailure(reason: string): CandidateState {
  const r = (reason ?? "").toLowerCase();
  if (/timeout|timed out|timeouterror|aborted|abort|deadline|etimedout/.test(r)) return "timeout";
  if (/\b(401|403|429|451)\b|forbidden|unauthorized|too many requests|rate.?limit|captcha|robots|blocked|access denied|cloudflare/.test(r))
    return "blocked";
  return "failed_to_open";
}

function emptyTelemetry(created: number): DetailQueueTelemetry {
  return {
    detail_queue_created: created,
    detail_candidates_started: 0,
    detail_candidates_completed: 0,
    detail_candidates_failed: 0,
    detail_candidates_blocked: 0,
    detail_candidates_timeout: 0,
    detail_candidates_cached: 0,
    detail_candidates_remaining: created,
  };
}

/** Control-flow signals must never be swallowed by per-chunk isolation. */
function isControlFlow(err: unknown): boolean {
  const name = (err as Error | undefined)?.name;
  return name === "SweepPaused" || name === "CheckpointWriteError";
}

class ChunkTimeout extends Error {
  constructor(ms: number) {
    super(`chunk exceeded ${ms}ms`);
    this.name = "ChunkTimeout";
  }
}

async function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ChunkTimeout(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Process the deep-verification queue incrementally.
 *
 * Every chunk is checkpointed the moment it settles, so an interrupted run
 * resumes exactly where it stopped. Failures are isolated per chunk: nothing
 * a single site does can stop the remaining candidates from being read.
 */
export async function runDetailQueue<P extends { url: string }>(
  options: DetailQueueOptions<P>,
): Promise<DetailQueueResult<P>> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? DEFAULT_DETAIL_BUDGET_MS;

  const cached = new Set([...(options.cachedUrls ?? [])].map(canonicalQueueUrl));
  const queue = dedupeQueue(options.urls);
  const states = new Map<string, CandidateProgress>();
  for (const url of queue) states.set(url, { url, state: "queued", reason: null });

  const telemetry = emptyTelemetry(queue.length);
  const pages: P[] = [];
  const classified: { url: string; reason: string; state: CandidateState }[] = [];
  let costEstimate = 0;
  let budgetExhausted = false;

  const mark = (url: string, state: CandidateState, reason: string | null): CandidateProgress => {
    const entry = { url, state, reason };
    states.set(url, entry);
    return entry;
  };

  const report = async (changed: CandidateProgress[]) => {
    telemetry.detail_candidates_remaining = [...states.values()].filter(
      (s) => s.state === "queued" || s.state === "fetching",
    ).length;
    if (options.onProgress) await options.onProgress({ telemetry: { ...telemetry }, changed });
  };

  // Cached candidates cost nothing and are settled before any network call.
  const pending: string[] = [];
  const cacheHits: CandidateProgress[] = [];
  for (const url of queue) {
    if (cached.has(canonicalQueueUrl(url))) {
      telemetry.detail_candidates_cached += 1;
      cacheHits.push(mark(url, "skipped", "cached — page content unchanged"));
    } else {
      pending.push(url);
    }
  }
  if (cacheHits.length > 0) await report(cacheHits);

  const chunks = chunkQueue(pending, chunkSize);
  const done = new Set<string>();

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    if (now() - startedAt >= budgetMs) {
      budgetExhausted = true;
      break;
    }

    for (const url of chunk) mark(url, "fetching", null);
    telemetry.detail_candidates_started += chunk.length;

    let outcome: DetailFetchLike<P>;
    try {
      outcome = await options.step(`detail_pages:${i}`, async () => {
        try {
          return await withTimeout(chunkTimeoutMs, () => options.fetchPages(chunk));
        } catch (err) {
          if (isControlFlow(err)) throw err;
          const reason =
            (err as Error).name === "ChunkTimeout"
              ? `timeout — ${(err as Error).message}`
              : ((err as Error).message || "fetch failed").slice(0, 200);
          // A failed chunk is a RESULT, not a crash: it is checkpointed so the
          // next resume moves on instead of retrying the same dead site.
          return {
            pages: [] as P[],
            failures: chunk.map((url) => ({ url, reason })),
            costEstimate: 0,
          };
        }
      });
    } catch (err) {
      // SweepPaused / CheckpointWriteError: the run stops here and resumes at
      // this exact chunk. Everything before it is already durable.
      if (isControlFlow(err)) throw err;
      outcome = {
        pages: [] as P[],
        failures: chunk.map((url) => ({ url, reason: (err as Error).message.slice(0, 200) })),
        costEstimate: 0,
      };
    }

    const changed: CandidateProgress[] = [];
    costEstimate += outcome.costEstimate ?? 0;
    for (const page of outcome.pages) {
      pages.push(page);
      done.add(page.url);
      telemetry.detail_candidates_completed += 1;
      changed.push(mark(page.url, "fetched", null));
    }
    for (const failure of outcome.failures) {
      done.add(failure.url);
      const state = classifyFetchFailure(failure.reason);
      if (state === "timeout") telemetry.detail_candidates_timeout += 1;
      else if (state === "blocked") telemetry.detail_candidates_blocked += 1;
      else telemetry.detail_candidates_failed += 1;
      classified.push({ url: failure.url, reason: failure.reason, state });
      changed.push(mark(failure.url, state, failure.reason));
    }
    // A URL the fetcher answered nothing about must not stay "fetching".
    for (const url of chunk) {
      if (done.has(url) || outcome.pages.some((p) => p.url === url)) continue;
      done.add(url);
      telemetry.detail_candidates_failed += 1;
      const reason = "no response for this candidate";
      classified.push({ url, reason, state: "failed_to_open" });
      changed.push(mark(url, "failed_to_open", reason));
    }

    await report(changed);
  }

  const remaining = [...states.values()]
    .filter((s) => s.state === "queued" || s.state === "fetching")
    .map((s) => s.url);
  for (const url of remaining) mark(url, "queued", budgetExhausted ? "deep-verification budget reached" : null);
  telemetry.detail_candidates_remaining = remaining.length;

  return {
    pages,
    failures: classified.map(({ url, reason }) => ({ url, reason })),
    classified,
    costEstimate: Number(costEstimate.toFixed(4)),
    states,
    telemetry,
    remaining,
    budgetExhausted,
    elapsedMs: now() - startedAt,
  };
}

/** Human-facing state for a candidate that could not be opened. */
export function isUnopenable(state: CandidateState): boolean {
  return state === "failed_to_open" || state === "timeout" || state === "blocked";
}
