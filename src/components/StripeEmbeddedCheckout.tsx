import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { getStripe, getStripeEnvironment } from "@/lib/stripe";
import { createCheckoutSession } from "@/utils/payments.functions";

interface StripeEmbeddedCheckoutProps {
  planKey: string;
  interval: "month" | "year";
  marketCode: string | null;
  localeHint: string | null;
  returnUrl: string;
  onError?: (message: string) => void;
}

export function StripeEmbeddedCheckout({
  planKey,
  interval,
  marketCode,
  localeHint,
  returnUrl,
  onError,
}: StripeEmbeddedCheckoutProps) {
  const fetchClientSecret = async (): Promise<string> => {
    const result = await createCheckoutSession({
      data: {
        planKey,
        interval,
        returnUrl,
        marketCode,
        localeHint,
        environment: getStripeEnvironment(),
      },
    });
    if ("error" in result) {
      const message = typeof result.error === "string" ? result.error : "Checkout failed";
      onError?.(message);
      throw new Error(message);
    }
    if (!result.clientSecret) {
      const message = "Stripe did not return a client secret";
      onError?.(message);
      throw new Error(message);
    }
    return result.clientSecret;
  };

  return (
    <div id="checkout">
      <EmbeddedCheckoutProvider stripe={getStripe()} options={{ fetchClientSecret }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
