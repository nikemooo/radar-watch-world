import { describe, expect, it } from "vitest";
import {
  canonicalQueueUrl,
  classifyFetchFailure,
  dedupeQueue,
  runDetailQueue,
} from "@/lib/monitoring/detail-queue";

type Page = { url: string; html: string };

/** Checkpoint store that replays previously completed steps, like the engine's. */
function makeStep(memory = new Map<string, unknown>()) {
  const calls: string[] = [];
  const step = async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (memory.has(key)) return memory.get(key) as T;
    calls.push(key);
    const value = await fn();
    memory.set(key, value);
    return value;
  };
  return { step, calls, memory };
}

const ok = (urls: string[]) => ({
  pages: urls.map((url) => ({ url, html: "<html/>" })),
  failures: [] as { url: string; reason: string }[],
  costEstimate: 0.01 * urls.length,
});

describe("deep-verification queue", () => {
  it("reads every discovered candidate instead of returning zero", async () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://site.se/annons/${i}`);
    const { step } = makeStep();
    const result = await runDetailQueue<Page>({
      urls,
      step,
      fetchPages: async (batch) => ok(batch),
    });
    expect(result.pages).toHaveLength(30);
    expect(result.telemetry.detail_queue_created).toBe(30);
    expect(result.telemetry.detail_candidates_completed).toBe(30);
    expect(result.telemetry.detail_candidates_remaining).toBe(0);
  });

  it("one dead site never blocks the remaining candidates", async () => {
    const urls = ["https://a.se/1", "https://dead.se/2", "https://a.se/3", "https://a.se/4"];
    const { step } = makeStep();
    const result = await runDetailQueue<Page>({
      urls,
      step,
      chunkSize: 1,
      chunkTimeoutMs: 50,
      fetchPages: async (batch) => {
        if (batch[0]!.includes("dead.se")) await new Promise((r) => setTimeout(r, 300));
        return ok(batch);
      },
    });
    expect(result.pages.map((p) => p.url)).toEqual(["https://a.se/1", "https://a.se/3", "https://a.se/4"]);
    expect(result.states.get("https://dead.se/2")?.state).toBe("timeout");
    expect(result.telemetry.detail_candidates_timeout).toBe(1);
  });

  it("resumes from checkpoints without re-fetching finished chunks", async () => {
    const urls = ["https://a.se/1", "https://a.se/2", "https://a.se/3", "https://a.se/4"];
    const memory = new Map<string, unknown>();
    let fetches = 0;
    const first = makeStep(memory);
    await runDetailQueue<Page>({
      urls,
      step: first.step,
      chunkSize: 2,
      budgetMs: 0.0001,
      now: (() => {
        let t = 0;
        return () => (t += 1000);
      })(),
      fetchPages: async (batch) => {
        fetches += batch.length;
        return ok(batch);
      },
    });
    const before = fetches;
    const second = makeStep(memory);
    const result = await runDetailQueue<Page>({
      urls,
      step: second.step,
      chunkSize: 2,
      fetchPages: async (batch) => {
        fetches += batch.length;
        return ok(batch);
      },
    });
    expect(result.pages).toHaveLength(4);
    // Chunk 0 came from the checkpoint; only the unfinished work hit the network.
    expect(fetches - before).toBeLessThan(4);
  });

  it("reports progress after every chunk so the UI counts up live", async () => {
    const urls = ["https://a.se/1", "https://a.se/2", "https://a.se/3"];
    const { step } = makeStep();
    const seen: number[] = [];
    await runDetailQueue<Page>({
      urls,
      step,
      chunkSize: 1,
      fetchPages: async (batch) => ok(batch),
      onProgress: ({ telemetry }) => {
        seen.push(telemetry.detail_candidates_completed);
      },
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("deduplicates by canonical URL before fetching", async () => {
    const urls = [
      "https://www.a.se/annons/1?utm_source=x",
      "https://a.se/annons/1/",
      "https://a.se/annons/2",
    ];
    expect(dedupeQueue(urls)).toHaveLength(2);
    expect(canonicalQueueUrl(urls[0]!)).toBe(canonicalQueueUrl(urls[1]!));
  });

  it("classifies failures into explicit states", () => {
    expect(classifyFetchFailure("HTTP 403 Forbidden")).toBe("blocked");
    expect(classifyFetchFailure("request timed out")).toBe("timeout");
    expect(classifyFetchFailure("ECONNRESET")).toBe("failed_to_open");
  });

  it("never silently drops candidates the budget could not reach", async () => {
    const urls = ["https://a.se/1", "https://a.se/2", "https://a.se/3", "https://a.se/4"];
    let t = 0;
    const { step } = makeStep();
    const result = await runDetailQueue<Page>({
      urls,
      step,
      chunkSize: 2,
      budgetMs: 1500,
      now: () => (t += 1000),
      fetchPages: async (batch) => ok(batch),
    });
    expect(result.budgetExhausted).toBe(true);
    expect(result.remaining.length).toBeGreaterThan(0);
    expect(result.telemetry.detail_candidates_remaining).toBe(result.remaining.length);
  });

  it("propagates a paused slice instead of swallowing it", async () => {
    const paused = new Error("paused");
    paused.name = "SweepPaused";
    await expect(
      runDetailQueue<Page>({
        urls: ["https://a.se/1"],
        step: async (_k, fn) => fn(),
        fetchPages: async () => {
          throw paused;
        },
      }),
    ).rejects.toThrow("paused");
  });
});
