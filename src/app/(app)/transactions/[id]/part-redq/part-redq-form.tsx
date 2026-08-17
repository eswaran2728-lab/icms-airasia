"use client";

import { useActionState, useState } from "react";
import { completePartRedq, type ActionState } from "@/lib/actions/transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SignatureField } from "@/components/signature-pad";
import { CHECKPOINT_SEAL_COLORS, SEAL_COLOR_LABELS } from "@/lib/constants";
import type { SealColor } from "@/lib/database.types";

const initialState: ActionState = { error: null };

interface PartRedqFormProps {
  transactionId: string;
  officerName: string;
  officerStaffId: string;
}

/**
 * Two stages in one form: verify the old seal blind (number/colour not
 * shown, same as every other checkpoint's seal verification), then apply
 * the new one. A mismatch on the old seal escalates server-side rather
 * than letting the new seal be applied.
 */
export function PartRedqForm({ transactionId, officerName, officerStaffId }: PartRedqFormProps) {
  const [state, formAction, pending] = useActionState(completePartRedq, initialState);
  const [oldSealNumber, setOldSealNumber] = useState("");
  const [oldSealColor, setOldSealColor] = useState<SealColor | "">("");
  const [newSealNumber, setNewSealNumber] = useState("");
  const [newSealColor, setNewSealColor] = useState<SealColor | "">("");
  const [signature, setSignature] = useState<string | null>(null);

  const ready =
    !!signature &&
    oldSealNumber.trim() !== "" &&
    oldSealColor !== "" &&
    newSealNumber.trim() !== "" &&
    newSealColor !== "";

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-5">
          <input type="hidden" name="transaction_id" value={transactionId} />

          <div className="rounded-md bg-muted p-3 text-sm">
            <p>
              <span className="text-muted-foreground">REDQ AVSEC:</span>{" "}
              <span className="font-medium">{officerName}</span>{" "}
              <span className="text-muted-foreground">({officerStaffId})</span>
            </p>
          </div>

          <Card className="border-rose-300 dark:border-rose-800">
            <CardHeader>
              <CardTitle className="text-base">1. Verify Old Seal</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="old_seal_number">Old Seal Number</Label>
                <Input
                  id="old_seal_number"
                  name="old_seal_number"
                  placeholder="As physically observed"
                  value={oldSealNumber}
                  onChange={(e) => setOldSealNumber(e.target.value)}
                  className="font-mono text-foreground"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="old_seal_color">Old Seal Colour</Label>
                <Select
                  id="old_seal_color"
                  name="old_seal_color"
                  value={oldSealColor}
                  onChange={(e) => setOldSealColor(e.target.value as SealColor)}
                  required
                >
                  <option value="" disabled>
                    Select colour…
                  </option>
                  {CHECKPOINT_SEAL_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {SEAL_COLOR_LABELS[c]}
                    </option>
                  ))}
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card className="border-sky-300 dark:border-sky-800">
            <CardHeader>
              <CardTitle className="text-base">2. Apply New Seal</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="new_seal_number">New Seal Number</Label>
                <Input
                  id="new_seal_number"
                  name="new_seal_number"
                  placeholder="e.g. RDQ-1234"
                  value={newSealNumber}
                  onChange={(e) => setNewSealNumber(e.target.value)}
                  className="font-mono text-foreground"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new_seal_color">New Seal Colour</Label>
                <Select
                  id="new_seal_color"
                  name="new_seal_color"
                  value={newSealColor}
                  onChange={(e) => setNewSealColor(e.target.value as SealColor)}
                  required
                >
                  <option value="" disabled>
                    Select colour…
                  </option>
                  {CHECKPOINT_SEAL_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {SEAL_COLOR_LABELS[c]}
                    </option>
                  ))}
                </Select>
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Must be Blue — this transaction is still outbound.
              </p>
            </CardContent>
          </Card>

          <div className="space-y-2">
            <Label htmlFor="remarks">Remarks (optional)</Label>
            <Textarea id="remarks" name="remarks" rows={2} />
          </div>

          <SignatureField label="REDQ AVSEC Signature" onChange={setSignature} />
          <input type="hidden" name="signature" value={signature ?? ""} />

          {state.error ? (
            <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}

          <Button type="submit" size="xl" className="w-full" disabled={pending || !ready}>
            {pending ? "Saving…" : "Verify Old Seal & Apply New Seal"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
