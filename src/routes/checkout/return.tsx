import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/checkout/return")({
  head: () => ({
    meta: [
      { title: "Checkout — Radar" },
      { name: "description", content: "Return from Stripe checkout." },
      { property: "og:title", content: "Checkout — Radar" },
      { property: "og:description", content: "Return from Stripe checkout." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { session_id?: string | undefined } => ({
    session_id: typeof search['session_id'] === "string" ? search['session_id'] : undefined,
  }),
  component: CheckoutReturn,
});

function CheckoutReturn() {
  const search = Route.useSearch();
  const t = useT();
  const sessionId = search['session_id'];

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {sessionId ? t("checkout.welcome") : t("checkout.complete")}
        </h1>
        <p className="mt-3 text-muted-foreground">
          {sessionId ? t("checkout.activating") : t("checkout.notFound")}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to="/billing">{t("checkout.goBilling")}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/">{t("checkout.backDashboard")}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

