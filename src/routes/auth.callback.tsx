import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Wordmark } from "@/components/radar-mark";

// Public OAuth landing route. The provider (or the Lovable OAuth broker) returns
// here, never straight into a protected route: the session may still be settling
// when the browser lands, and a protected route would bounce the user to /auth.
export const Route = createFileRoute("/auth/callback")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Signing you in — Radar Intelligence" },
      { name: "description", content: "Completing your Radar sign-in." },
      { property: "og:title", content: "Signing you in — Radar Intelligence" },
      { property: "og:description", content: "Completing your Radar sign-in." },
    ],
  }),
  component: AuthCallback,
});

const SAFE_PATH = /^\/[A-Za-z0-9\-._~/?#[\]@!$&'()*+,;=%]*$/;

function nextPath(): string {
  if (typeof window === "undefined") return "/dashboard";
  const stored = window.sessionStorage.getItem("radar:auth-next");
  window.sessionStorage.removeItem("radar:auth-next");
  if (stored && SAFE_PATH.test(stored) && !stored.startsWith("//")) return stored;
  return "/dashboard";
}

// The native shell sends the user through an in-app browser sheet. That sheet
// is a separate browsing context, so the tokens must be handed back to the app
// through the custom URL scheme instead of being consumed here.
function forwardToNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const search = new URLSearchParams(window.location.search);
  if (search.get("native") !== "1") return false;
  search.delete("native");
  const query = search.toString();
  window.location.replace(
    `radar://auth-callback${query ? `?${query}` : ""}${window.location.hash}`,
  );
  return true;
}

function AuthCallback() {
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const handedOff = forwardToNativeApp();

  useEffect(() => {
    if (handedOff) return;
    let done = false;
    const finish = (to: string) => {
      if (done) return;
      done = true;
      navigate({ to, replace: true });
    };

    // supabase-js parses the URL fragment/code asynchronously (detectSessionInUrl),
    // so subscribe first and also poll — whichever resolves first wins.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) finish(nextPath());
    });

    let tries = 0;
    const timer = window.setInterval(async () => {
      tries += 1;
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        window.clearInterval(timer);
        finish(nextPath());
      } else if (tries > 25) {
        window.clearInterval(timer);
        if (!done) setFailed(true);
      }
    }, 400);

    return () => {
      window.clearInterval(timer);
      sub.subscription.unsubscribe();
    };
  }, [navigate, handedOff]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="panel w-full max-w-sm p-6 text-center">
        <Wordmark />
        <p className="mt-4 text-sm text-muted-foreground">
          {failed ? "We couldn't complete the sign-in." : "Establishing your session…"}
        </p>
        {failed && (
          <button
            className="mt-4 text-sm underline hover:text-foreground"
            onClick={() => navigate({ to: "/auth", replace: true })}
          >
            Back to sign in
          </button>
        )}
      </div>
    </div>
  );
}
