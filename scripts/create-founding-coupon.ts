/**
 * One-off: creates the "Founding member" coupon (30% off for 12 months).
 * Run with: bun scripts/create-founding-coupon.ts
 */
import { createStripeClient } from "../src/lib/stripe.server";

const stripe = createStripeClient("sandbox");

const coupon = await stripe.coupons.create({
  name: "Founding member (30% off, 12 months)",
  percent_off: 30,
  duration: "repeating",
  duration_in_months: 12,
});

console.log(`coupon: ${coupon.id}`);
