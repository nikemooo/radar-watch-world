import { Globe } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Market } from "@/lib/billing/markets";

type Props = {
  markets: Market[];
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  hint?: string;
};

/** Lets anyone pick the market they want to be billed in, regardless of where they are. */
export function MarketSelect({ markets, value, onChange, disabled, hint }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Globe className="size-4 text-muted-foreground" aria-hidden />
      <label className="sr-only" htmlFor="market-select">
        Billing country
      </label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id="market-select" className="h-9 w-[240px]">
          <SelectValue placeholder="Select country" />
        </SelectTrigger>
        <SelectContent>
          {markets.map((market) => (
            <SelectItem key={market.code} value={market.code}>
              {market.name} · {market.currency}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}
