import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { parseAuthParams, readStoredState } from "@/lib/native-auth";

/**
 * Catches `radar://auth-callback...` deep links in the iOS shell: closes the
 * in-app browser sheet, installs the session in the app's own web view and
 * drops the user on the dashboard — never leaving them stranded in Safari.
 */
export function NativeAuthListener() {
  const navigate = useNavigate();

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        if (!Capacitor.isNativePlatform()) return;
        const { App } = await import("@capacitor/app");
        const { Browser } = await import("@capacitor/browser");

        const handle = await App.addListener("appUrlOpen", async ({ url }) => {
          if (!url.startsWith("radar://auth-callback")) return;
          await Browser.close().catch(() => undefined);

          const params = parseAuthParams(url);
          const expectedState = readStoredState();
          const state = params.get("state");
          if (expectedState && state && state !== expectedState) {
            toast.error("Sign-in could not be verified. Please try again.");
            return;
          }

          const accessToken = params.get("access_token");
          const refreshToken = params.get("refresh_token");
          if (!accessToken || !refreshToken) {
            toast.error(params.get("error_description") ?? "Sign-in failed. Please try again.");
            return;
          }

          const { error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (error) {
            toast.error("Sign-in failed. Please try again.");
            return;
          }
          navigate({ to: "/dashboard", replace: true });
        });

        if (cancelled) {
          handle.remove();
          return;
        }
        cleanup = () => {
          handle.remove();
        };
      } catch {
        // Web build: no native bridge, nothing to listen for.
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [navigate]);

  return null;
}
