import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getResearchStatus } from "@/lib/radar.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Radar" },
      { name: "description", content: "Manage your profile, notifications and research sources." },
      { property: "og:title", content: "Settings — Radar" },
      { property: "og:description", content: "Manage your profile, notifications and research sources." },
    ],
  }),
  component: Settings,
});

function Settings() {
  const queryClient = useQueryClient();
  const researchStatus = useServerFn(getResearchStatus);
  const [displayName, setDisplayName] = useState("");
  const [digestHour, setDigestHour] = useState(8);
  const [emailNotifications, setEmailNotifications] = useState(true);

  const { data: profile, isLoading } = useQuery({
    queryKey: ["profile"],
    queryFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userData.user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: research } = useQuery({
    queryKey: ["research-status"],
    queryFn: () => researchStatus({}),
  });

  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.display_name ?? "");
    setDigestHour(profile.digest_hour);
    setEmailNotifications(profile.notification_email);
  }, [profile]);

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) return;
      const { error } = await supabase
        .from("profiles")
        .update({
          display_name: displayName,
          digest_hour: digestHour,
          notification_email: emailNotifications,
        })
        .eq("id", profile.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Settings saved.");
      queryClient.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading) return <Skeleton className="h-72" />;

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <p className="mono-label">Preferences</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Settings</h1>
      </header>

      <section className="panel space-y-5 p-5">
        <h2 className="text-lg font-medium">Profile</h2>
        <div className="space-y-1.5">
          <Label htmlFor="display-name">Display name</Label>
          <Input id="display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" value={profile?.email ?? ""} disabled />
        </div>
      </section>

      <section className="panel space-y-5 p-5">
        <h2 className="text-lg font-medium">Notifications</h2>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Email alerts</p>
            <p className="text-sm text-muted-foreground">Receive important findings by email.</p>
          </div>
          <Switch checked={emailNotifications} onCheckedChange={setEmailNotifications} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="digest-hour">Daily digest hour (local, 0–23)</Label>
          <Input
            id="digest-hour"
            type="number"
            min={0}
            max={23}
            value={digestHour}
            onChange={(e) => setDigestHour(Number(e.target.value))}
          />
        </div>
      </section>

      <section className="panel space-y-3 p-5">
        <h2 className="text-lg font-medium">Research sources</h2>
        <p className="text-sm text-muted-foreground">
          Radar never invents sources. It only reports what a configured live research provider returns.
        </p>
        <div className="space-y-2">
          {(research?.providers ?? []).map((provider) => (
            <div
              key={provider.id}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
            >
              <span>{provider.label}</span>
              <span className={provider.configured ? "text-interesting" : "text-muted-foreground"}>
                {provider.configured ? "Connected" : "Not configured"}
              </span>
            </div>
          ))}
        </div>
      </section>

      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}
