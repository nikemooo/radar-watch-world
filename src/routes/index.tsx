import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Bell, Brain, Radar as RadarIcon, Search, Sparkles } from "lucide-react";
import { RadarMark, Wordmark } from "@/components/radar-mark";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Radar — Personal Intelligence That Watches For You" },
      {
        name: "description",
        content:
          "Tell Radar what you care about. It monitors public sources continuously, detects meaningful change, and tells you only what matters.",
      },
      { property: "og:title", content: "Radar — Personal Intelligence That Watches For You" },
      {
        property: "og:description",
        content: "Continuous AI monitoring for anything you care about — cars, markets, jobs, prices, people.",
      },
    ],
  }),
  component: Landing,
});

const capabilities = [
  {
    icon: Brain,
    title: "It understands intent",
    body: "Describe what you want in plain language. Radar interprets goal, constraints and the events worth watching — no forms, no categories.",
  },
  {
    icon: Search,
    title: "It researches continuously",
    body: "Radar runs live web research against real sources on a cadence it chooses, then remembers everything it has already seen.",
  },
  {
    icon: Sparkles,
    title: "It detects real change",
    body: "New listings, price drops, filings, announcements. Radar diffs the world against its own memory instead of re-reading it.",
  },
  {
    icon: Bell,
    title: "It filters ruthlessly",
    body: "Every finding is scored for relevance to you. Only what actually matters becomes an alert — with reasoning and sources attached.",
  },
];

const examples = [
  "Find me a black BMW M340i under 450,000 SEK in Sweden",
  "Tell me when anything material happens to Tesla stock",
  "Watch for remote senior React roles paying over $150k",
  "Alert me if flights to Tokyo drop below $600 in March",
  "Monitor competitor pricing changes in project management SaaS",
];

function Landing() {
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
              Universal personal intelligence
            </span>
            <h1 className="mt-6 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
              You describe what matters.
              <br />
              <span className="text-muted-foreground">Radar watches the world for it.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted-foreground">
              Radar is a monitoring intelligence that never sleeps. It researches live sources, remembers
              what it has seen, detects the changes that count, and tells you why they matter — for
              absolutely anything you can describe.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg" className="gap-2">
                <Link to="/auth">
                  Start monitoring
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/pricing">See plans</Link>
              </Button>
            </div>
            <p className="mono-label mt-4">Free plan · no card required</p>
          </div>

          <div className="panel relative p-6">
            <div className="flex items-center gap-3">
              <RadarMark className="size-10" />
              <div>
                <p className="text-sm font-medium">Live radar</p>
                <p className="mono-label">Sweeping 6 sources</p>
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
