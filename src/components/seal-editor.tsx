"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { SEAL_COLOR_LABELS, SEAL_TYPE_LABELS } from "@/lib/constants";
import type { SealColor, SealType } from "@/lib/database.types";

export interface SealDraft {
  seal_number: string;
  seal_type: SealType;
  /** Empty string until the officer actively picks one — never pre-filled. */
  seal_color: SealColor | "";
}

interface SealEditorProps {
  seals: SealDraft[];
  onChange: (seals: SealDraft[]) => void;
}

/**
 * Add-multiple-seals editor for Part A. Seal colour is a fully manual
 * choice — no default, nothing inferred from direction. The officer must
 * actively pick Blue, Green, or Other for every seal, every time.
 */
export function SealEditor({ seals, onChange }: SealEditorProps) {
  const update = (i: number, patch: Partial<SealDraft>) => {
    onChange(seals.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  const add = () =>
    onChange([...seals, { seal_number: "", seal_type: "TROLLEY", seal_color: "" }]);

  const remove = (i: number) => onChange(seals.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Seals</Label>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="h-4 w-4" /> Add seal
        </Button>
      </div>
      {seals.map((seal, i) => (
        <div
          key={i}
          className="space-y-2 rounded-md border border-input p-2 sm:grid sm:grid-cols-[1fr_auto_auto_auto] sm:items-center sm:gap-2 sm:space-y-0 sm:border-0 sm:p-0"
        >
          <Input
            aria-label={`Seal ${i + 1} number`}
            placeholder="Seal number"
            value={seal.seal_number}
            onChange={(e) => update(i, { seal_number: e.target.value })}
            className="font-mono text-lg font-semibold tracking-wide text-foreground"
            required
          />
          <div className="flex items-center gap-2">
            <Select
              aria-label={`Seal ${i + 1} type`}
              className="w-auto flex-1 sm:flex-none"
              value={seal.seal_type}
              onChange={(e) => update(i, { seal_type: e.target.value as SealType })}
            >
              {Object.entries(SEAL_TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <Select
              aria-label={`Seal ${i + 1} color`}
              className="w-auto flex-1 sm:flex-none"
              value={seal.seal_color}
              required
              onChange={(e) => update(i, { seal_color: e.target.value as SealColor })}
            >
              <option value="" disabled>
                Select color…
              </option>
              {Object.entries(SEAL_COLOR_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove seal ${i + 1}`}
              onClick={() => remove(i)}
              disabled={seals.length === 1}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Pick the seal colour manually — nothing is pre-selected. Every seal is re-verified by
        number and colour at each checkpoint.
      </p>
    </div>
  );
}
