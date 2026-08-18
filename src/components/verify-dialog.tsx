/**
 * Manual verification queue.
 *
 * Shows one listing at a time with exactly the requirements the machine could
 * not verify, and lets the owner answer each one. The answer is stored
 * separately (finding_verifications) and is always labelled as the user's own
 * judgement — original source evidence is never overwritten.
 */
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, ImageOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { snapshotOf, attributesOf, type FindingLike } from "@/components/listing-card";
import type { EffectiveVerdict, UserVerdict } from "@/lib/monitoring/verification";
import { statusLabel } from "@/lib/monitoring/verification";
import { cn } from "@/lib/utils";

export interface VerifyDialogProps {
  findings: FindingLike[];
  index: number;
  onIndexChange: (index: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  verdictOf: (finding: FindingLike) => EffectiveVerdict | undefined;
  onAnswer: (input: { finding: FindingLike; attribute: string; verdict: UserVerdict }) => void;
}

function money(value: number | null, currency: string | null): string {
  if (value === null) return "Pris saknas";
  const rounded = Math.round(value).toLocaleString("sv-SE");
  return currency === "SEK" ? `${rounded} kr` : `${rounded}${currency ? ` ${currency}` : ""}`;
}

export function VerifyDialog({
  findings,
  index,
  onIndexChange,
  open,
  onOpenChange,
  verdictOf,
  onAnswer,
}: VerifyDialogProps) {
  const [current, setCurrent] = useState(index);
  useEffect(() => setCurrent(index), [index]);

  const finding = findings[Math.min(current, findings.length - 1)];
  if (!finding) return null;
  const snapshot = snapshotOf(finding.snapshot);
  const verdict = verdictOf(finding);
  const attributes = attributesOf(finding.attributes);
  const link = finding.primary_url ?? finding.url;

  const move = (delta: number) => {
    const next = Math.min(Math.max(current + delta, 0), findings.length - 1);
    setCurrent(next);
    onIndexChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-left">{finding.title}</DialogTitle>
          <DialogDescription className="text-left">
            {current + 1} av {findings.length} annonser att verifiera ·{" "}
            {statusLabel[verdict?.status ?? "unverified"]}
          </DialogDescription>
        </DialogHeader>

        <div className="aspect-[16/10] w-full overflow-hidden rounded-md bg-muted/40">
          {snapshot.image ? (
            <img src={snapshot.image} alt={finding.title} className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <ImageOff className="size-4" aria-hidden /> Ingen bild från annonsen
            </div>
          )}
        </div>

        <p className="text-2xl font-semibold">{money(finding.numeric_value, finding.currency)}</p>

        {attributes.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {attributes.map((a) => (
              <div key={a.key} className="flex gap-2">
                <dt className="mono-label">{a.key.replace(/_/g, " ")}</dt>
                <dd>{a.raw}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="space-y-4">
          <p className="text-sm font-medium">Vad behöver verifieras?</p>
          {(verdict?.requirements ?? [])
            .filter((r) => r.autoStatus !== "match")
            .map((r) => (
              <div key={r.attribute} className="space-y-2 rounded-md border border-border p-3">
                <p className="text-sm">{r.label}</p>
                <p className="text-xs text-muted-foreground">{r.autoReason}</p>
                {r.image && r.image.confidence !== "none" && (
                  <p className="text-xs text-muted-foreground">
                    Bildanalys: {r.image.observation} ({r.image.confidence === "high" ? "hög" : "låg"}{" "}
                    confidence)
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ["pass", "✓ Uppfyller"],
                      ["fail", "✕ Uppfyller inte"],
                      ["unknown", "? Vet inte"],
                    ] as [UserVerdict, string][]
                  ).map(([value, label]) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={r.userVerdict === value ? "default" : "outline"}
                      className={cn("flex-1 min-w-24", r.autoStatus === "reject" && "opacity-50")}
                      disabled={r.autoStatus === "reject"}
                      onClick={() => onAnswer({ finding, attribute: r.attribute, verdict: value })}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                {r.userVerdict && (
                  <p className="text-xs text-muted-foreground">
                    Du markerade detta som{" "}
                    {r.userVerdict === "pass"
                      ? "uppfyllt"
                      : r.userVerdict === "fail"
                        ? "ej uppfyllt"
                        : "okänt"}
                    .
                  </p>
                )}
              </div>
            ))}
        </div>

        <div className="flex items-center gap-2 pt-2">
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm"
            >
              Öppna annons <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="icon" aria-label="Föregående" disabled={current === 0} onClick={() => move(-1)}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Nästa"
              disabled={current >= findings.length - 1}
              onClick={() => move(1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
