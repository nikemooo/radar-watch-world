/**
 * Generic source priority.
 *
 * Radar has no per-site knowledge and must never get any: a marketplace is
 * recognised by what it *does* — it hosts repeating item URLs, its pages
 * fetch successfully, and the listings it produced previously survived the
 * deterministic criteria gate. Those three learned signals plus one structural
 * signal (does the host belong to the market the radar asked for?) decide which
 * sources are read first and which get the expansion budget.
 *
 * Nothing here filters sources away — it only orders them, so a genuinely new
 * source can always still be discovered.
 */
import { marketOfHost, type Market } from "@/lib/monitoring/geo";

export interface HostStat {
  attempts: number;
  successes: number;
}

export interface HostHistory {
  /** Findings previously persisted from this host. */
  findings: number;
  /** How many of those passed the deterministic criteria gate. */
  matches: number;
  /** Fetch reliability learned across this user's sweeps. */
  fetch?: HostStat | undefined;
}

export interface PriorityContext {
  /** Markets the radar explicitly asked for, if any. */
  markets: Market[];
  history: Map<string, HostHistory>;
}

export interface HostPriority {
  host: string;
  score: number;
  reasons: string[];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Priority of one host, in the range [0, ~4]. 1.0 is "no information".
 * Used as a multiplier on structural evidence, never as a substitute for it.
 */
export function hostPriority(host: string, ctx: PriorityContext): HostPriority {
  const reasons: string[] = [];
  let score = 1;

  if (ctx.markets.length > 0) {
    const market = marketOfHost(host);
    if (market && ctx.markets.some((m) => m.code === market.code)) {
      score *= 1.6;
      reasons.push(`host TLD belongs to ${market.name}`);
    } else if (market) {
      score *= 0.6;
      reasons.push(`host TLD belongs to ${market.name}, outside the radar's market`);
    }
  }

  const h = ctx.history.get(host);
  if (h) {
    if (h.findings > 0) {
      const relevance = h.matches / h.findings;
      const boost = 1 + Math.min(1, h.findings / 10) * (0.4 + relevance);
      score *= boost;
      reasons.push(`${h.findings} previous listing(s), ${h.matches} passed criteria`);
    }
    const fetch = h.fetch;
    if (fetch && fetch.attempts >= 3) {
      const rate = fetch.successes / fetch.attempts;
      score *= 0.5 + rate; // 0.5x when never readable, 1.5x when always readable
      reasons.push(`fetch success ${Math.round(rate * 100)}% over ${fetch.attempts} attempts`);
    }
  }

  return { host, score: Number(score.toFixed(3)), reasons };
}

/** Sort URLs/documents so the most promising sources are processed first. */
export function prioritize<T>(items: T[], urlOf: (item: T) => string, ctx: PriorityContext): T[] {
  return [...items]
    .map((item, index) => ({ item, index, p: hostPriority(hostOf(urlOf(item)), ctx) }))
    .sort((a, b) => b.p.score - a.p.score || a.index - b.index)
    .map((e) => e.item);
}

/** Build the learned history from rows the engine has already loaded. */
export function buildHistory(
  findings: { url: string | null; primary_url: string | null; snapshot: unknown }[],
  fetchStats: { host: string; attempts: number; successes: number }[],
): Map<string, HostHistory> {
  const history = new Map<string, HostHistory>();
  const entry = (host: string) => {
    let e = history.get(host);
    if (!e) history.set(host, (e = { findings: 0, matches: 0 }));
    return e;
  };
  for (const f of findings) {
    const host = hostOf(f.primary_url ?? f.url ?? "");
    if (!host) continue;
    const e = entry(host);
    e.findings += 1;
    const status = (f.snapshot as { match_status?: string } | null)?.match_status;
    if (status === "match") e.matches += 1;
  }
  for (const s of fetchStats) {
    const host = s.host.replace(/^www\./, "").toLowerCase();
    entry(host).fetch = { attempts: s.attempts, successes: s.successes };
  }
  return history;
}
