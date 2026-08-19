import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { updateRadarCriteria } from "@/lib/radar.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  frequencyLabel,
  recencyPresets,
  type RadarConfig,
  type RadarFrequency,
} from "@/lib/radar-types";
import { useT, type TranslationKey } from "@/lib/i18n";

const lines = (items: string[]) => items.join("\n");
const parseLines = (value: string) =>
  value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Editing criteria never deletes history: previous findings and their
 * observations stay, and the radar records when the criteria last changed so
 * older verdicts can be read in the right context.
 */
export function EditCriteriaDialog({
  open,
  onOpenChange,
  radarId,
  initialName,
  initialFrequency,
  initialRecencyDays,
  config,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  radarId: string;
  initialName: string;
  initialFrequency: RadarFrequency;
  initialRecencyDays: number;
  config: RadarConfig;
  onSaved: () => void;
}) {
  const t = useT();
  const save = useServerFn(updateRadarCriteria);
  const [name, setName] = useState(initialName);
  const [frequency, setFrequency] = useState<RadarFrequency>(initialFrequency);
  const [recencyDays, setRecencyDays] = useState(initialRecencyDays);
  const [priceMin, setPriceMin] = useState(config.price_min?.toString() ?? "");
  const [priceMax, setPriceMax] = useState(config.price_max?.toString() ?? "");
  const [currency, setCurrency] = useState(config.currency ?? "");
  const [locations, setLocations] = useState(lines(config.locations));
  const [criteria, setCriteria] = useState(lines(config.important_criteria));
  const [exclusions, setExclusions] = useState(lines(config.exclusions));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const next: RadarConfig = {
        ...config,
        price_min: priceMin.trim() === "" ? null : Number(priceMin),
        price_max: priceMax.trim() === "" ? null : Number(priceMax),
        currency: currency.trim() || null,
        locations: parseLines(locations),
        important_criteria: parseLines(criteria),
        exclusions: parseLines(exclusions),
      };
      await save({
        data: { radarId, name, frequency, recency_days: recencyDays, config: next },
      });
      toast.success(t("edit.saved"));
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("edit.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("edit.title")}</DialogTitle>
          <DialogDescription>
            {t("edit.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-name">{t("edit.name")}</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("edit.frequency")}</Label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as RadarFrequency)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(frequencyLabel) as RadarFrequency[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {t(`freq.${key}` as TranslationKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("edit.recency")}</Label>
              <Select value={String(recencyDays)} onValueChange={(v) => setRecencyDays(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {recencyPresets.map((p) => (
                    <SelectItem key={p.days} value={String(p.days)}>
                      {t(`recency.${p.days}` as TranslationKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-min">{t("edit.priceMin")}</Label>
              <Input
                id="edit-min"
                inputMode="numeric"
                value={priceMin}
                onChange={(e) => setPriceMin(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-max">{t("edit.priceMax")}</Label>
              <Input
                id="edit-max"
                inputMode="numeric"
                value={priceMax}
                onChange={(e) => setPriceMax(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-currency">{t("edit.currency")}</Label>
              <Input
                id="edit-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </div>
          </div>

          <Field
            id="edit-locations"
            label={t("edit.locations")}
            value={locations}
            onChange={setLocations}
          />
          <Field
            id="edit-criteria"
            label={t("edit.criteria")}
            value={criteria}
            onChange={setCriteria}
          />
          <Field
            id="edit-exclusions"
            label={t("edit.exclusions")}
            value={exclusions}
            onChange={setExclusions}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("edit.cancel")}
          </Button>
          <Button onClick={submit} disabled={busy} className="gap-2">
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t("edit.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} className="resize-none" />
    </div>
  );
}
