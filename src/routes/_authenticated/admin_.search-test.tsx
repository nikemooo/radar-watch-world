/**
 * Internal proof-of-concept view for the OpenAI Web Search test.
 * Completely separate from the Radar monitoring UI.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const DEFAULT_PROMPT = `Find Rolex Submariner Date 126610LN listings in Sweden.

Requirements:
- Rolex Submariner Date
- Reference 126610LN
- Sweden / Swedish market
- Prefer listings from Sweden
- Prefer model year 2018 or newer
- Maximum price 120,000 SEK

Search the web extensively enough to find multiple real listings.
For every candidate return: title, exact listing URL, source/domain, seller if available, country, location if available, price, currency, model/reference, year if available, condition if available, image URL if available.
Do not invent missing values. If a value cannot be verified, return null and explain why.
Prefer the original listing page over aggregators. Return the sources used for each result.`;

interface Candidate {
  title: string | null;
  url: string | null;
  url_type: string;
  source: string | null;
  seller: string | null;
  country: string | null;
  location: string | null;
  price: number | null;
  currency: string | null;
  model: string | null;
  reference: string | null;
  year: number | null;
  condition: string | null;
  image_url: string | null;
  evidence: Record<string, string | null>;
  missing_fields: string[];
  confidence: string;
}

interface PocResponse {
  ok: boolean;
  configured: boolean;
  error: string | null;
  result: {
    query: string;
    search_completed: boolean;
    candidates: Candidate[];
    sources: string[];
    notes: string | null;
  } | null;
  telemetry: {
    model: string;
    response_id: string | null;
    web_search_calls: number;
    web_search_queries: string[];
    execution_ms: number;
    usage: Record<string, unknown> | null;
    raw_text_length: number;
    parse_error: string | null;
  };
}

export const Route = createFileRoute("/_authenticated/admin_/search-test")({
  component: SearchTestPage,
  head: () => ({
    meta: [
      { title: "OpenAI Web Search test — Radar internal" },
      { name: "description", content: "Internal proof-of-concept for evaluating OpenAI web search as Radar's discovery engine." },
      { property: "og:title", content: "OpenAI Web Search test — Radar internal" },
      { property: "og:description", content: "Internal proof-of-concept for evaluating OpenAI web search as Radar's discovery engine." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function SearchTestPage() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PocResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch("/api/test/openai-web-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const json = (await res.json()) as PocResponse;
      setData(json);
      if (!json.ok) setError(json.error ?? "Unknown failure");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const t = data?.telemetry;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">OpenAI Web Search — proof of concept</h1>
        <p className="text-sm text-muted-foreground">
          Isolated test endpoint. Does not touch the Radar engine, sweeps, scheduler or findings.
        </p>
      </header>

      <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={12} className="font-mono text-xs" />

      <Button onClick={run} disabled={loading}>
        {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
        Test OpenAI Web Search
      </Button>

      {loading && (
        <p className="text-sm text-muted-foreground">
          Running live web search — reasoning runs can take a few minutes.
        </p>
      )}

      {error && (
        <div className="rounded-md border border-critical/40 bg-critical/10 p-3 text-sm">{error}</div>
      )}

      {t && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Telemetry</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 font-mono text-xs sm:grid-cols-3">
            <Stat label="model" value={t.model} />
            <Stat label="execution" value={`${(t.execution_ms / 1000).toFixed(1)}s`} />
            <Stat label="web_search calls" value={String(t.web_search_calls)} />
            <Stat label="candidates" value={String(data?.result?.candidates.length ?? 0)} />
            <Stat label="sources" value={String(data?.result?.sources.length ?? 0)} />
            <Stat label="response id" value={t.response_id ?? "—"} />
            {t.usage && (
              <div className="col-span-full whitespace-pre-wrap break-all text-muted-foreground">
                usage: {JSON.stringify(t.usage)}
              </div>
            )}
            {t.web_search_queries.length > 0 && (
              <div className="col-span-full text-muted-foreground">
                queries: {t.web_search_queries.join(" | ")}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {data?.result?.candidates.map((c, i) => (
        <Card key={i}>
          <CardContent className="space-y-3 pt-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-medium">{c.title ?? "(no title)"}</p>
                <p className="text-xs text-muted-foreground">
                  {c.source ?? "unknown source"} · {c.country ?? "unknown country"}
                  {c.location ? ` · ${c.location}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <Badge variant="outline">{c.confidence}</Badge>
                <Badge variant={c.url_type === "listing" ? "default" : "secondary"}>{c.url_type}</Badge>
              </div>
            </div>

            <div className="flex gap-4">
              {c.image_url ? (
                <img src={c.image_url} alt={c.title ?? "listing"} className="h-24 w-32 rounded object-cover" loading="lazy" />
              ) : (
                <div className="flex h-24 w-32 items-center justify-center rounded border border-dashed text-[10px] text-muted-foreground">
                  no image
                </div>
              )}
              <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
                <Stat label="price" value={c.price !== null ? `${c.price} ${c.currency ?? ""}` : "null"} />
                <Stat label="year" value={c.year !== null ? String(c.year) : "null"} />
                <Stat label="model" value={c.model ?? "null"} />
                <Stat label="reference" value={c.reference ?? "null"} />
                <Stat label="seller" value={c.seller ?? "null"} />
                <Stat label="condition" value={c.condition ?? "null"} />
              </div>
            </div>

            {c.url && (
              <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline">
                {c.url} <ExternalLink className="size-3" />
              </a>
            )}

            <div className="rounded-md bg-muted/40 p-2 text-xs">
              {Object.entries(c.evidence).map(([k, v]) => (
                <p key={k}>
                  <span className="text-muted-foreground">{k}:</span> {v ?? "—"}
                </p>
              ))}
            </div>

            {c.missing_fields.length > 0 && (
              <p className="text-xs text-muted-foreground">missing: {c.missing_fields.join(", ")}</p>
            )}
          </CardContent>
        </Card>
      ))}

      {data?.result?.sources && data.result.sources.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sources used ({data.result.sources.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.result.sources.map((s) => (
              <a key={s} href={s} target="_blank" rel="noreferrer" className="block break-all text-xs text-primary underline">
                {s}
              </a>
            ))}
          </CardContent>
        </Card>
      )}

      {data?.result?.notes && <p className="text-sm text-muted-foreground">{data.result.notes}</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="break-all">
      <span className="text-muted-foreground">{label}: </span>
      <span>{value}</span>
    </div>
  );
}
