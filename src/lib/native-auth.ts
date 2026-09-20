// Native (Capacitor) sign-in helpers.
//
// In the iOS shell the web app runs inside a WKWebView pointed at the hosted
// site. A plain OAuth redirect leaves that origin, so iOS hands the navigation
// to Safari and the user never comes back. Instead we open the OAuth broker in
// an in-app browser (SFSafariViewController, which Google allows) and bring the
// user back with a custom URL scheme that iOS routes into the app.

export const NATIVE_CALLBACK_SCHEME = "radar://auth-callback";
const STATE_KEY = "radar:native-oauth-state";

export async function isNativeApp(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Opens the Lovable OAuth broker inside an in-app browser sheet. */
export async function startNativeOAuth(provider: "google" | "apple" | "microsoft"): Promise<void> {
  const { Browser } = await import("@capacitor/browser");
  const state = randomState();
  window.sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    provider,
    // The broker only redirects to our own origin. That page then forwards the
    // tokens to the custom scheme so iOS reopens the app.
    redirect_uri: `${window.location.origin}/auth/callback?native=1`,
    state,
  });
  await Browser.open({ url: `/~oauth/initiate?${params.toString()}`.replace(/^\//, `${window.location.origin}/`) });
}

export function readStoredState(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.sessionStorage.getItem(STATE_KEY);
  window.sessionStorage.removeItem(STATE_KEY);
  return value;
}

/** Pulls auth params out of either the query string or the hash fragment. */
export function parseAuthParams(url: string): URLSearchParams {
  const hashIndex = url.indexOf("#");
  const queryIndex = url.indexOf("?");
  const out = new URLSearchParams();
  const add = (raw: string) => {
    for (const [k, v] of new URLSearchParams(raw)) out.set(k, v);
  };
  if (queryIndex >= 0) add(url.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined));
  if (hashIndex >= 0) add(url.slice(hashIndex + 1));
  return out;
}
