import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { buildIntelligenceReport } from "@/lib/radar.functions";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/intelligence")({
  head: () => ({
    meta: [
      { title: "Intelligence briefings — Radar" },
      { name: "description", content: "Synthesized daily and weekly briefings on how your world changed." },
      { property: "og:title", content: "Intelligence briefings — Radar" },
      { property: "og:description", content: "How your world changed, synthesized." },
    ],
  }),
  component: Intelligence,
});

interface ReportContent {
  headline?: string;
  narrative?: string;
  key_developments?: string[];
  emerging_trends?: string[];
  recommended_actions?: string[];
}

function Intelligence() {
  const queryClient = useQueryClient();
  const build = useServerFn(buildIntelligenceReport);

  const { data, isLoading } = useQuery({
    queryKey: ["reports"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reports")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
  });

  const generate = useMutation({
    mutationFn: async (kind: "daily" | "weekly") => build({ data: { kind } }),
    onSuccess: () => {
      toast.success("Briefing ready.");
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mono-label">Synthesis</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Intelligence</h1>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="gap-2"
            disabled={generate.isPending}
            onClick={() => generate.mutate("daily")}
          >
            {generate.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Daily brief
          </Button>
          <Button
            className="gap-2"
            disabled={generate.isPending}
            onClick={() => generate.mutate("weekly")}
          >
            Weekly brief
          </Button>
        </div>
      </header>

      {isLoading ? (
        <Skeleton className="h-56" />
      ) : data?.length ? (
        <div className="space-y-4">
          {data.map((report) => {
            const content = (report.content ?? {}) as ReportContent;
            return (
              <article key={report.id} className="panel p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono-label text-primary">{report.kind}</span>
                  <span className="mono-label">
                    {new Date(report.period_start).toLocaleDateString()} –{" "}
                    {new Date(report.period_end).toLocaleDateString()}
                  </span>
                </div>
                <h2 className="mt-3 text-lg font-medium">{content.headline ?? "Intelligence briefing"}</h2>
                {content.narrative && (
                  <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">
                    {content.narrative}
                  </p>
                )}
                <div className="mt-5 grid gap-5 sm:grid-cols-3">
                  <Block title="Key developments" items={content.key_developments} />
                  <Block title="Emerging trends" items={content.emerging_trends} />
                  <Block title="Recommended actions" items={content.recommended_actions} />
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="panel p-10 text-center text-sm text-muted-foreground">
          No briefings yet. Generate one once your radars have collected findings.
        </p>
      )}
    </div>
  );
}

function Block({ title, items }: { title: string; items?: string[] | undefined }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="mono-label">{title}</p>
      <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
