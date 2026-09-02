/**
 * Event detail — one real-world event, everything the radar knows about it:
 * the source-backed facts, the AI reading, how the story developed over time,
 * the assets it touches and every outlet that reported it.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MarketEventBody, type MarketEventRow } from "@/components/market-event-timeline";
import { useT } from "@/lib/i18n";

export const Route = createFileRoute("/_authenticated/events/$eventId")({
  head: () => ({
    meta: [
      { title: "Market event — Radar" },
      {
        name: "description",
        content: "The facts, the sources and the AI reading behind a single market-moving event.",
      },
      { property: "og:title", content: "Market event — Radar" },
      { property: "og:description", content: "Facts, sources and AI interpretation of one market event." },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: EventDetail,
});

function EventDetail() {
  const t = useT();
  const { eventId } = Route.useParams();

  const { data, isLoading } = useQuery({
    queryKey: ["market-event", eventId],
    queryFn: async () => {
      const { data: event } = await supabase
        .from("market_events")
        .select("*")
        .eq("id", eventId)
        .maybeSingle();
      if (!event) return null;
      const { data: radar } = await supabase
        .from("radars")
        .select("id, name")
        .eq("id", event.radar_id)
        .maybeSingle();
      return { event: event as MarketEventRow, radar };
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="panel p-8 text-center">
        <p className="text-sm text-muted-foreground">{t("events.notFound")}</p>
        <Button asChild variant="ghost" className="mt-4">
          <Link to="/dashboard">{t("nav.dashboard")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <article className="space-y-5">
      <Button asChild variant="ghost" size="sm" className="gap-2">
        <Link to="/radars/$radarId" params={{ radarId: data.event.radar_id }}>
          <ArrowLeft className="size-4" />
          {data.radar?.name ?? t("events.back")}
        </Link>
      </Button>
      <div className="panel p-5">
        <MarketEventBody event={data.event} alwaysOpen />
      </div>
    </article>
  );
}
