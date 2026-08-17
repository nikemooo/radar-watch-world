import { supabase } from "@/integrations/supabase/client";

/** Product analytics events tracked across the product. */
export type AnalyticsEvent =
  | "signup"
  | "first_radar_created"
  | "radar_created"
  | "radar_edited"
  | "radar_deleted"
  | "first_alert_received"
  | "alert_opened"
  | "alert_saved"
  | "alert_dismissed"
  | "alert_feedback"
  | "report_generated"
  | "subscription_started"
  | "subscription_cancelled"
  | "checkout_started";

export async function track(event: AnalyticsEvent, properties: Record<string, unknown> = {}) {
  try {
    const { data } = await supabase.auth.getUser();
    if (!data.user) return;
    await supabase.from("analytics_events").insert({
      user_id: data.user.id,
      event,
      properties: properties as never,
    });
  } catch {
    // analytics must never break the product
  }
}
