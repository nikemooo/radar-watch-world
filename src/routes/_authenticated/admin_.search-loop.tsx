/**
 * Internal proof-of-concept view for the server-driven OpenAI Web Search loop.
 * Completely separate from the Radar monitoring UI and engine.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Loader2, ExternalLink, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const DEFAULT_PROMPT = `Find Rolex Submariner Date 126610LN listings in Sweden.

Requirements:
- Rolex Submariner Date
- reference 126610LN
- Swedish market
- preferably 2018 or newer
- maximum 120,000 SEK
- currently available listings preferred

Find actual listings, not merely category pages.`;

interface Criterion {
  key: string;
  status: string;
  detail: string | null;
}

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
  color: string | null;
  availability: string;
  image_url: string | null;
  evidence: Record<string, string | null>;
  missing_fields: string[];
  sources: string[];
  criteria: Criterion[];
  overall: string;
}

interface LoopResponse {
  ok: boolean;
  configured: boolean;
  error: string | null;
  marketplaces: { name: string; domain: string; country: string | null; relevance: number }[];
  candidates: Candidate[];
  counts: Record<string, number>;
  sources: string[];
  log: { step: string; label: string; ok: boolean; results: number; ms: number; detail: string | null }[];
  telemetry: Record<string, number | string | null>;
}

export const Route = createFileRoute("/_authenticated/admin_/search-loop")({
  component: SearchLoopPage,
  head: () => ({
    meta: [
      { title: "OpenAI multi-search loop — Radar internal" },
      {
        name: "description",
        content: "Internal proof-of-concept running a server-driven multi-step OpenAI web search loop.",
      },
      { property: "og:title", content: "OpenAI multi-search loop — Radar internal" },
      {
        property: "og:description",
        content: "Internal proof-of-concept running a server-driven multi-step OpenAI web search loop.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function SearchLoopPage() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<LoopResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch("/api/test/openai-search-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const json = (await res.json()) as LoopResponse;
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
        <h1 className="text-2xl font-semibold">OpenAI multi-search loop — proof of concept</h1>
        <p className="text-sm text-muted-foreground">
          Server-driven loop: market discovery → per-marketplace search → detail verification → dedup → criteria.
          Isolated from the Radar engine, Exa, sweeps and scheduler.
        </p>
      </header>

      <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={12} className="font-mono text-xs" />

      <Button onClick={run} disabled={loading}>
        {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
        Run multi-search loop
      </Button>

      {loading && (
        <p className="text-sm text-muted-foreground">Running up to 28 OpenAI requests — this can take minutes.</p>
      )}

      {error && <div className="rounded-md border border-critical/40 bg-critical/10 p-3 text-sm">{error}</div>}

      {t && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Telemetry</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 font-mono text-xs sm:grid-cols-3">
            {Object.entries(t).map(([k, v]) => (
              <Stat key={k} label={k} value={String(v ?? "—")} />
            ))}
            {data?.counts &&
              Object.entries(data.counts).map(([k, v]) => <Stat key={k} label={k} value={String(v)} />)}
          </CardContent>
        </Card>
      )}

      {data?.log && data.log.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Run log</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 font-mono text-xs">
            {data.log.map((l, i) => (
              <div key={i} className="flex items-start gap-2">
                {l.ok ? <Check className="mt-0.5 size-3 text-success" /> : <X className="mt-0.5 size-3 text-critical" />}
                <span className="text-muted-foreground">[{l.step}]</span>
                <span className="flex-1 break-all">{l.label}</span>
                <span>{l.results} results</span>
                <span className="text-muted-foreground">{(l.ms / 1000).toFixed(1)}s</span>
                {l.detail && <span className="text-critical">{l.detail}</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {data?.marketplaces && data.marketplaces.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Marketplaces ({data.marketplaces.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 font-mono text-xs">
            {data.marketplaces.map((m) => (
              <p key={m.domain}>
                {m.name} · {m.domain} · {m.country ?? "?"} · relevance {m.relevance}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {data?.candidates.map((c, i) => (
        <Card key={i}>
          <CardContent className="space-y-3 pt-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-medium">{c.title ?? "(no title)"}</p>
                <p className="text-xs text-muted-foreground">
                  {c.source ?? "unknown source"} · {c.country ?? "unknown country"}
                  {c.location ? ` · ${c.location}` : ""} · {c.availability}
                </p>
              </div>
              <div className="flex gap-2">
                <Badge variant={c.overall === "match" ? "default" : "outline"}>{c.overall}</Badge>
                <Badge variant={c.url_type === "listing" ? "default" : "secondary"}>{c.url_type}</Badge>
              </div>
            </div>

            <div className="flex gap-4">
              {c.image_url ? (
                <img
                  src={c.image_url}
                  alt={c.title ?? "listing"}
                  className="h-24 w-32 rounded object-cover"
                  loading="lazy"
                />
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
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 break-all text-xs text-primary underline"
              >
                {c.url} <ExternalLink className="size-3 shrink-0" />
              </a>
            )}

            <div className="space-y-1 rounded-md bg-muted/40 p-2 font-mono text-xs">
              {c.criteria.map((k) => (
                <p key={k.key}>
                  <span className="text-muted-foreground">{k.key}:</span> {k.status}
                  {k.detail ? ` (${k.detail})` : ""}
                </p>
              ))}
            </div>

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

      {data?.sources && data.sources.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sources ({data.sources.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.sources.map((s) => (
              <a key={s} href={s} target="_blank" rel="noreferrer" className="block break-all text-xs text-primary underline">
                {s}
              </a>
            ))}
          </CardContent>
        </Card>
      )}
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
