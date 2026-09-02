/**
 * A monitoring request typed before sign-in. The landing page captures it, the
 * radar creation page picks it up after auth, so the sentence the user wrote is
 * never lost to the login round-trip.
 */
export const PENDING_REQUEST_KEY = "radar.pendingRequest";

export function stashPendingRequest(value: string): void {
  if (typeof window === "undefined") return;
  const clean = value.trim().slice(0, 2000);
  if (clean) window.sessionStorage.setItem(PENDING_REQUEST_KEY, clean);
}

/** Read once and clear — a stashed request is consumed by the first creator. */
export function takePendingRequest(): string {
  if (typeof window === "undefined") return "";
  const value = window.sessionStorage.getItem(PENDING_REQUEST_KEY) ?? "";
  if (value) window.sessionStorage.removeItem(PENDING_REQUEST_KEY);
  return value;
}
