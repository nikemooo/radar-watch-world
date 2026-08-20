import { useState, useCallback } from "react";
import { StripeEmbeddedCheckout } from "@/components/StripeEmbeddedCheckout";

interface CheckoutOptions {
  planKey: string;
  interval: "month" | "year";
  marketCode: string | null;
  localeHint: string | null;
  returnUrl: string;
  onError?: (message: string) => void;
}

export function useStripeCheckout() {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<CheckoutOptions | null>(null);

  const openCheckout = useCallback((opts: CheckoutOptions) => {
    setOptions(opts);
    setIsOpen(true);
  }, []);

  const closeCheckout = useCallback(() => {
    setIsOpen(false);
    setOptions(null);
  }, []);

  const checkoutElement = isOpen && options
    ? <StripeEmbeddedCheckout {...options} />
    : null;

  return { openCheckout, closeCheckout, isOpen, checkoutElement };
}
