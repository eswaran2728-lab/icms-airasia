"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { CHECKPOINT_SEAL_COLORS, SEAL_COLOR_LABELS, SEAL_TYPE_LABELS } from "@/lib/constants";
import { t, type Lang } from "@/lib/i18n";
import type { Seal } from "@/lib/database.types";
import { cn } from "@/lib/utils";

interface SealVerifyFieldsProps {
  seals: Pick<Seal, "id" | "seal_number" | "seal_type" | "seal_color">[];
  entries: Record<string, string>;
  onChange: (entries: Record<string, string>) => void;
  colors: Record<string, string>;
  onColorsChange: (colors: Record<string, string>) => void;
  lang?: Lang;
}

/**
 * Checkpoint seal entry: the officer must physically read and enter each
 * seal's number AND manually pick its colour (Blue/Green — nothing
 * pre-selected, nothing inferred from direction). Numbers and colours on
 * record are never shown, so a tick-only or copy-from-screen verification
 * is impossible. The server compares both against Part A and
 * auto-escalates on any mismatch (wrong number, or right number but wrong
 * colour).
 */
export function SealVerifyFields({
  seals,
  entries,
  onChange,
  colors,
  onColorsChange,
  lang = "en",
}: SealVerifyFieldsProps) {
  return (
    <div className="space-y-3">
      <Label>{t(lang, "seal_verification")}</Label>
      {seals.map((seal, i) => {
        const entered = (entries[seal.id] ?? "").trim().toUpperCase();
        const numberMatches = entered === seal.seal_number.trim().toUpperCase();
        const pickedColor = colors[seal.id] ?? "";
        return (
          <div key={seal.id} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Badge className="border bg-muted text-muted-foreground">
                {SEAL_TYPE_LABELS[seal.seal_type]}
              </Badge>
              <Input
                aria-label={`Seal ${i + 1} number as read`}
                placeholder={t(lang, "enter_seal_placeholder")}
                autoCapitalize="characters"
                value={entries[seal.id] ?? ""}
                onChange={(e) => onChange({ ...entries, [seal.id]: e.target.value })}
                required
                className="font-mono text-foreground"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Colour observed:</span>
              {CHECKPOINT_SEAL_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onColorsChange({ ...colors, [seal.id]: c })}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    pickedColor === c
                      ? c === "BLUE"
                        ? "border-blue-600 bg-blue-600 text-white"
                        : "border-green-600 bg-green-600 text-white"
                      : "border-input bg-background hover:bg-accent"
                  )}
                >
                  {SEAL_COLOR_LABELS[c]}
                </button>
              ))}
            </div>
            {entered ? (
              <p
                className={`flex items-center gap-1 text-xs font-medium ${numberMatches ? "text-emerald-600" : "text-red-600"}`}
              >
                {numberMatches ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" />
                )}
                {numberMatches
                  ? "Matches the recorded seal / Sepadan dengan sil direkodkan"
                  : "Does not match the recorded seal / Tidak sepadan dengan sil direkodkan"}
              </p>
            ) : null}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">{t(lang, "seal_mismatch_note")}</p>
    </div>
  );
}
