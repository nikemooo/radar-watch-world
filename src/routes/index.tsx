import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Bell, Brain, LineChart, Radar as RadarIcon, Sparkles } from "lucide-react";
import { RadarMark, Wordmark } from "@/components/radar-mark";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { stashPendingRequest } from "@/lib/pending-request";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Radar — AI Market Intelligence That Watches The World" },
      {
        name: "description",
        content:
          "Tell Radar what you care about. It watches world events, connects them to markets, and explains what changed, why it matters and what to watch next.",
      },
      { property: "og:title", content: "Radar — AI Market Intelligence That Watches The World" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      {
        property: "og:description",
        content: "Continuous AI monitoring of markets, events and impact — gold, oil, crypto, equities, currencies.",
      },
    ],
  }),
  component: Landing,
});

const capabilities = [
  {
    icon: Brain,
    title: "It understands what you care about",
    body: "Describe it in plain language. Radar builds the monitoring profile — the instrument, the themes and the events that historically move it.",
  },
  {
    icon: RadarIcon,
    title: "It watches the world, not a feed",
    body: "Live research across real sources, clustered per story. Twenty syndicated copies of one wire report become one event, not twenty alerts.",
  },
  {
    icon: LineChart,
    title: "It measures the market reaction",
    body: "Every event is checked against real price data around its timestamp. If no data covers it, Radar says so instead of inventing a number.",
  },
  {
    icon: Sparkles,
    title: "It separates fact from interpretation",
    body: "What the sources actually state is kept apart from the AI's reading of it — with confidence on each, and what to watch next.",
  },
  {
    icon: Bell,
    title: "It alerts sparingly",
    body: "Ranked by importance, capped per sweep, deduplicated across stories. Silence is a feature when nothing meaningful happened.",
  },
];

const examples = [
  "Watch gold and tell me what moves it",
  "Monitor oil and geopolitical risk in the Middle East",
  "Tell me when anything material happens to NVIDIA",
  "Alert me if Bitcoin drops more than 8% in 24 hours",
  "Track USD/SEK and the Riksbank's rate decisions",
];

function Landing() {
  const navigate = useNavigate();
  const [request, setRequest] = useState("");

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5">
        <Wordmark />
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/pricing">Pricing</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/auth">Sign in</Link>
          </Button>
        </nav>
      </header>

      <section className="relative overflow-hidden px-5 pb-24 pt-14 sm:pt-24">
        <div className="radar-glow pointer-events-none absolute left-1/2 top-0 size-[760px] -translate-x-1/2 -translate-y-1/3" />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[1.15fr_0.85fr]">
          <div>
            <span className="mono-label inline-flex items-center gap-2 rounded-full border border-border px-3 py-1">
              <span className="size-1.5 animate-pulse rounded-full bg-interesting" />
              AI market & world event intelligence
            </span>
            <h1 className="mt-6 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
              You describe what matters.
              <br />
              <span className="text-muted-foreground">Radar watches the world for it.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted-foreground">
              Radar continuously watches the world, detects the events that matter, connects them to the
              markets you follow, and explains what changed, why it matters and what to watch next —
              with facts and AI interpretation kept strictly apart.
            </p>
            <form
              className="panel mt-8 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                const value = request.trim();
                if (value.length < 8) return;
                stashPendingRequest(value);
                navigate({ to: "/radars/new", search: { q: value } });
              }}
            >
              <label htmlFor="monitor-request" className="mono-label px-1">
                What do you want to monitor?
              </label>
              <Textarea
                id="monitor-request"
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                rows={2}
                placeholder="e.g. Watch gold and tell me what moves it"
                className="mt-2 resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0"
              />
              <div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-1">
                <span className="mono-label">One sentence is enough</span>
                <Button type="submit" size="lg" className="gap-2" disabled={request.trim().length < 8}>
                  Start monitoring
                  <ArrowRight className="size-4" />
                </Button>
              </div>
            </form>
            <div className="mt-4 flex flex-wrap gap-2">
              {examples.slice(0, 3).map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setRequest(example)}
                  className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition hover:border-primary hover:text-foreground"
                >
                  {example}
                </button>
              ))}
            </div>
            <p className="mono-label mt-4">Free plan · no card required</p>
          </div>

          <div className="panel relative p-6">
            <div className="flex items-center gap-3">
              <RadarMark className="size-10" />
              <div>
                <p className="text-sm font-medium">Live radar</p>
                <p className="mono-label">Events · impact · what to watch</p>
              </div>
            </div>
            <ul className="mt-6 space-y-3">
              {examples.map((example) => (
                <li
                  key={example}
                  className="rounded-md border border-border bg-card/60 px-3 py-2.5 text-sm text-muted-foreground"
                >
                  “{example}”
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="border-t border-border px-5 py-20">
        <div className="mx-auto w-full max-w-6xl">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Not a search box. An analyst.
          </h2>
          <div className="mt-10 grid gap-5 sm:grid-cols-2">
            {capabilities.map((item) => (
              <div key={item.title} className="panel p-5">
                <item.icon className="size-5 text-primary" />
                <h3 className="mt-4 font-medium">{item.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border px-5 py-20">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
          <RadarIcon className="size-6 text-primary" />
          <h2 className="mt-5 text-2xl font-semibold tracking-tight sm:text-3xl">
            Stop refreshing. Start knowing.
          </h2>
          <p className="mt-3 text-muted-foreground">
            One sentence is enough to put a permanent watch on the thing you care about.
          </p>
          <Button asChild size="lg" className="mt-7 gap-2">
            <Link to="/auth">
              Create your first radar
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </section>

      <footer className="border-t border-border px-5 py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4">
          <Wordmark />
          <p className="mono-label">© {new Date().getFullYear()} Radar Intelligence</p>
        </div>
      </footer>
    </div>
  );
}
