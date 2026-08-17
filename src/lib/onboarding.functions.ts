import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Everything the onboarding flow needs to decide what to show, resolved server-side. */
export const getOnboardingState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getEntitlements, minSweepIntervalMinutes } = await import(
      "./billing/entitlements.server"
    );
    const [e, { data: profile }] = await Promise.all([
      getEntitlements(context.supabase, context.userId),
      context.supabase
        .from("profiles")
        .select("onboarding_done, notification_email")
        .eq("id", context.userId)
        .maybeSingle(),
    ]);

    return {
      onboardingDone: Boolean(profile?.onboarding_done),
      notificationEmail: profile?.notification_email ?? true,
      radarCount: e.radarCount,
      planKey: e.planKey,
      planName: e.plan.name,
      maxRadars: e.plan.max_radars,
      minIntervalMinutes: minSweepIntervalMinutes(e),
      atRadarLimit: !e.isInternal && e.radarCount >= e.plan.max_radars,
    };
  });

/** Persist the notification preference and mark onboarding as finished. */
export const completeOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { notificationEmail?: boolean } | undefined) => ({
    notificationEmail: input?.notificationEmail,
  }))
  .handler(async ({ data, context }) => {
    const patch: { onboarding_done: boolean; notification_email?: boolean } = {
      onboarding_done: true,
    };
    if (typeof data.notificationEmail === "boolean") {
      patch.notification_email = data.notificationEmail;
    }

    const { error } = await context.supabase
      .from("profiles")
      .update(patch)
      .eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
