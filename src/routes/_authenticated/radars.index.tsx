import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { asConfig, frequencyLabel, type RadarFrequency } from "@/lib/radar-types";

export const Route = createFileRoute("/_authenticated/radars/")({
  head: () => ({
    meta: [
      { title: "Your radars — Radar" },
      { name: "description", content: "Every watch you have running, and what each is looking for." },
      { property: "og:title", content: "Your radars — Radar" },
      { property: "og:description", content: "Every watch you have running." },
    ],
  }),
  component: RadarsList,
});

function RadarsList() {
  const { data, isLoading } = useQuery({
    queryKey: ["radars"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("radars")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mono-label">Active watches</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Radars</h1>
        </div>
        <Button asChild className="gap-2">
          <Link to="/radars/new">
            <Plus className="size-4" />
            New radar
          </Link>
        </Button>
      </header>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : data?.length ? (
        <div className="space-y-3">
          {data.map((radar) => {
            const config = asConfig(radar.config);
            return (
              <Link
                key={radar.id}
                to="/radars/$radarId"
                params={{ radarId: radar.id }}
                className="panel flex items-center gap-4 p-4 transition-colors hover:border-primary/40"
              >
                <span
                  className={`mt-1 size-2 shrink-0 rounded-full ${
                    radar.status === "active" ? "bg-interesting" : "bg-muted-foreground"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{radar.name}</p>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {config.interpretation || radar.raw_request}
                  </p>
                  <p className="mono-label mt-2">
                    {radar.category} · {frequencyLabel[radar.frequency as RadarFrequency] ?? radar.frequency} ·{" "}
                    {radar.last_run_at
                      ? `last swept ${new Date(radar.last_run_at).toLocaleString()}`
                      : "awaiting first sweep"}
                  </p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="panel p-10 text-center">
          <p className="text-sm text-muted-foreground">No radars yet.</p>
          <Button asChild className="mt-5">
            <Link to="/radars/new">Create your first radar</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
