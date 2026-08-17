import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Wordmark } from "@/components/radar-mark";
import { track } from "@/lib/analytics";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in — Radar Intelligence" },
      {
        name: "description",
        content: "Sign in to Radar to manage what the world watches on your behalf.",
      },
      { property: "og:title", content: "Sign in — Radar Intelligence" },
      { property: "og:description", content: "Access your personal monitoring intelligence." },
    ],
  }),
  component: AuthPage,
});

type Mode = "signin" | "signup" | "forgot";

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard", replace: true });
    });
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback`,
            data: { display_name: name || email.split("@")[0] },
          },
        });
        if (error) throw error;
        const { data: session } = await supabase.auth.getSession();
        if (session.session) {
          await track("signup");
          navigate({ to: "/onboarding", replace: true });
        } else {
          setSent("Check your inbox and confirm your email address to activate your account.");
        }
      } else if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/dashboard", replace: true });
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        setSent("Password reset link sent. Check your inbox.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const google = async () => {
    // Land on the PUBLIC callback route: in the full-page redirect flow the
    // browser returns before supabase-js has written the session, and a
    // protected destination would bounce straight back to /auth.
    window.sessionStorage.setItem("radar:auth-next", "/dashboard");
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: `${window.location.origin}/auth/callback`,
    });
    if (result.error) {
      toast.error("Google sign-in failed. Try email instead.");
      return;
    }
    if (result.redirected) return;
    // Popup (preview/iframe) flow: tokens are already set — wait for the
    // session to be readable before navigating into the protected subtree.
    for (let i = 0; i < 20; i += 1) {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        navigate({ to: "/dashboard", replace: true });
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    toast.error("Signed in with Google, but the session didn't stick. Please retry.");
  };


  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12">
      <div className="radar-glow pointer-events-none absolute left-1/2 top-1/2 size-[700px] -translate-x-1/2 -translate-y-1/2" />
      <div className="panel relative w-full max-w-sm p-6">
        <Link to="/" className="mb-6 inline-flex">
          <Wordmark />
        </Link>
        <h1 className="text-xl font-semibold">
          {mode === "signup" ? "Create your account" : mode === "forgot" ? "Reset password" : "Sign in"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "signup"
            ? "Tell us what matters. We watch the world for you."
            : mode === "forgot"
              ? "We'll email you a secure reset link."
              : "Welcome back to your intelligence feed."}
        </p>

        {sent ? (
          <p className="mt-6 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm">{sent}</p>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            {mode === "signup" && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            {mode !== "forgot" && (
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                />
              </div>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading
                ? "Working…"
                : mode === "signup"
                  ? "Create account"
                  : mode === "forgot"
                    ? "Send reset link"
                    : "Sign in"}
            </Button>
          </form>
        )}

        {mode !== "forgot" && (
          <>
            <div className="my-5 flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="mono-label">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button variant="outline" className="w-full" onClick={google}>
              Continue with Google
            </Button>
          </>
        )}

        <div className="mt-6 space-y-1 text-sm text-muted-foreground">
          {mode === "signin" && (
            <>
              <button className="hover:text-foreground" onClick={() => setMode("signup")}>
                No account? Create one
              </button>
              <br />
              <button className="hover:text-foreground" onClick={() => setMode("forgot")}>
                Forgot your password?
              </button>
            </>
          )}
          {mode !== "signin" && (
            <button
              className="hover:text-foreground"
              onClick={() => {
                setMode("signin");
                setSent(null);
              }}
            >
              Back to sign in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
