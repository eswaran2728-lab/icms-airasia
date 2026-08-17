import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedUrl, uploadPdfBuffer } from "@/lib/storage";
import { formatDateTime } from "@/lib/utils";
import { loadOfficialTemplate, drawValue, drawWrapped, drawSignature, markSelected, markCargoTick } from "@/lib/pdf-overlay";
import type { OfficialFormKind } from "@/lib/pdf-templates";
import type {
  CargoType,
  PartA,
  PartBC,
  PartD,
  Seal,
  SealVerification,
  Transaction,
} from "@/lib/database.types";

async function signatureBytes(path: string | null): Promise<Buffer | null> {
  const url = await signedUrl("signatures", path);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Entered seal number(s) an officer recorded at a given checkpoint, per
 * the seal_verifications table — this is what the official form's single
 * "OUTBOUND SEAL SERIAL NO" line at that checkpoint should show (what was
 * physically read there), not necessarily the Part A record.
 */
function sealNumbersAt(checkpoint: "INFLIGHT_POST" | "AIRPORT_POST" | "PART_D", verifications: SealVerification[]): string {
  return verifications
    .filter((v) => v.checkpoint === checkpoint)
    .map((v) => v.entered_seal_number)
    .join(", ");
}

// ---------------------------------------------------------------------
// Field coordinates on templates/forms/ifcsf/ifcsf-inbound-outbound.pdf
// (PDF space, origin bottom-left) — extracted from the official file's
// own text/label positions, one page per direction. Every value here is
// "just after the printed label" or "on the printed blank line", not
// invented layout.
// ---------------------------------------------------------------------

const CARGO_ROW_OUTBOUND: { type: CargoType; x: number; y: number }[] = [
  { type: "FOOD_BEVERAGE", x: 80.5, y: 618.2 },
  { type: "PERISHABLE", x: 197.9, y: 618.2 },
  { type: "DUTY_FREE", x: 288.7, y: 618.2 },
  { type: "MERCHANDISE", x: 369.8, y: 618.2 },
  { type: "VEHICLE_MAINTENANCE", x: 458.6, y: 618.2 },
];
const CARGO_ROW_INBOUND: { type: CargoType; x: number; y: number }[] = [
  { type: "FOOD_BEVERAGE", x: 80.5, y: 621.7 },
  { type: "PERISHABLE", x: 197.9, y: 621.7 },
  { type: "DUTY_FREE", x: 288.7, y: 621.7 },
  { type: "MERCHANDISE", x: 369.8, y: 621.7 },
  { type: "VEHICLE_MAINTENANCE", x: 458.6, y: 621.7 },
];

interface XY {
  x: number;
  y: number;
}
interface Box extends XY {
  w: number;
  h: number;
}
interface CheckpointCoords {
  vehicleNo: XY;
  sealNo: XY;
  driverNameId: XY;
  asoName: XY;
  asoId: XY;
  signature: Box;
  dateTime: XY;
}
interface IfcsfCoords {
  station: XY;
  cargoRow: { type: CargoType; x: number; y: number }[];
  partA: {
    totalSupplies: XY;
    carts: XY;
    smu: XY;
    pallets: XY;
    boxes: XY;
    ovenRacks: XY;
    /** Only present on Inbound's Part A (FOB) — Outbound's Part A has no vehicle/seal field on the official form. */
    vehicleNo: XY | null;
    sealNo: XY | null;
    name: XY;
    idNo: XY;
    signature: Box;
    dateTime: XY;
  };
  partB: CheckpointCoords;
  partC: CheckpointCoords;
  /** Only present on Outbound — the Inbound page has no Part D. */
  partD: {
    sraOption: Box;
    aircraftOption: Box;
    asoName: XY;
    asoId: XY;
    signature: Box;
    dateTime: XY;
  } | null;
  remarks: { x: number; yTop: number; maxWidth: number; maxLines: number; lineHeight: number };
}

const OUTBOUND_COORDS: IfcsfCoords = {
  station: { x: 106, y: 646.5 },
  cargoRow: CARGO_ROW_OUTBOUND,
  partA: {
    totalSupplies: { x: 230, y: 557.2 },
    carts: { x: 108, y: 541.8 },
    smu: { x: 190, y: 541.8 },
    pallets: { x: 283, y: 541.8 },
    boxes: { x: 378, y: 541.8 },
    ovenRacks: { x: 478, y: 541.8 },
    vehicleNo: null,
    sealNo: null,
    name: { x: 92, y: 515.2 },
    idNo: { x: 352, y: 515.2 },
    signature: { x: 118, y: 498.6, w: 55, h: 16 },
    dateTime: { x: 372, y: 499.6 },
  },
  partB: {
    vehicleNo: { x: 200, y: 419.9 },
    sealNo: { x: 200, y: 399.7 },
    driverNameId: { x: 196, y: 379.4 },
    asoName: { x: 113, y: 358.0 },
    asoId: { x: 352, y: 358.0 },
    signature: { x: 118, y: 341.6, w: 55, h: 16 },
    dateTime: { x: 378, y: 342.6 },
  },
  partC: {
    vehicleNo: { x: 200, y: 262.9 },
    sealNo: { x: 200, y: 241.8 },
    driverNameId: { x: 196, y: 220.5 },
    asoName: { x: 113, y: 201.1 },
    asoId: { x: 352, y: 201.1 },
    signature: { x: 118, y: 184.6, w: 55, h: 16 },
    dateTime: { x: 378, y: 185.6 },
  },
  partD: {
    sraOption: { x: 254.6, y: 145.4, w: 100, h: 11 },
    aircraftOption: { x: 394.6, y: 145.4, w: 58, h: 11 },
    asoName: { x: 113, y: 124.6 },
    asoId: { x: 352, y: 124.6 },
    signature: { x: 118, y: 108.0, w: 55, h: 16 },
    dateTime: { x: 378, y: 109.0 },
  },
  remarks: { x: 58, yTop: 71, maxWidth: 495, maxLines: 3, lineHeight: 9 },
};

const INBOUND_COORDS: IfcsfCoords = {
  station: { x: 106, y: 650 },
  cargoRow: CARGO_ROW_INBOUND,
  partA: {
    totalSupplies: { x: 230, y: 555.8 },
    carts: { x: 96, y: 540.3 },
    smu: { x: 172, y: 540.3 },
    pallets: { x: 274, y: 540.3 },
    boxes: { x: 365, y: 540.3 },
    ovenRacks: { x: 478, y: 540.3 },
    vehicleNo: { x: 200, y: 509.7 },
    sealNo: { x: 200, y: 489.2 },
    name: { x: 92, y: 467.7 },
    idNo: { x: 352, y: 467.7 },
    signature: { x: 118, y: 450.6, w: 55, h: 16 },
    dateTime: { x: 372, y: 452.1 },
  },
  partB: {
    vehicleNo: { x: 200, y: 367.5 },
    sealNo: { x: 200, y: 346.3 },
    driverNameId: { x: 196, y: 325.1 },
    asoName: { x: 113, y: 308.7 },
    asoId: { x: 352, y: 308.7 },
    signature: { x: 118, y: 292.2, w: 55, h: 16 },
    dateTime: { x: 378, y: 293.2 },
  },
  partC: {
    vehicleNo: { x: 200, y: 209.8 },
    sealNo: { x: 200, y: 189.5 },
    driverNameId: { x: 196, y: 169.3 },
    asoName: { x: 113, y: 147.9 },
    asoId: { x: 352, y: 147.9 },
    signature: { x: 118, y: 131.4, w: 55, h: 16 },
    dateTime: { x: 378, y: 132.4 },
  },
  partD: null,
  remarks: { x: 58, yTop: 80.7, maxWidth: 495, maxLines: 3, lineHeight: 9 },
};

async function overlayIfcsf(
  transaction: Transaction,
  partA: PartA | null,
  partB: PartBC | null,
  partC: PartBC | null,
  partD: PartD | null,
  seals: Seal[],
  verifications: SealVerification[],
  signatures: { part_a: Buffer | null; part_b: Buffer | null; part_c: Buffer | null; part_d: Buffer | null }
): Promise<Uint8Array> {
  const kind: OfficialFormKind = transaction.direction === "INBOUND" ? "INBOUND" : "OUTBOUND";
  const { pdfDoc, page, font } = await loadOfficialTemplate(kind);
  const C = kind === "INBOUND" ? INBOUND_COORDS : OUTBOUND_COORDS;

  drawValue(page, font, C.station.x, C.station.y, transaction.station);

  for (const cargo of C.cargoRow) {
    if (transaction.cargo_types.includes(cargo.type)) markCargoTick(page, cargo.x, cargo.y);
  }

  // Part A — no vehicle/seal fields on Outbound's Part A (matches the
  // official form); Inbound's Part A (FOB) has them.
  const activeSealNumbers = seals
    .filter((s) => !s.superseded_at)
    .map((s) => s.seal_number)
    .join(", ");
  drawValue(page, font, C.partA.totalSupplies.x, C.partA.totalSupplies.y, transaction.supplies_total);
  drawValue(page, font, C.partA.carts.x, C.partA.carts.y, transaction.supplies_carts);
  drawValue(page, font, C.partA.smu.x, C.partA.smu.y, transaction.supplies_smu);
  drawValue(page, font, C.partA.pallets.x, C.partA.pallets.y, transaction.supplies_pallets);
  drawValue(page, font, C.partA.boxes.x, C.partA.boxes.y, transaction.supplies_boxes);
  drawValue(page, font, C.partA.ovenRacks.x, C.partA.ovenRacks.y, transaction.supplies_oven_racks);
  if (C.partA.vehicleNo && C.partA.sealNo) {
    drawValue(page, font, C.partA.vehicleNo.x, C.partA.vehicleNo.y, transaction.vehicle_number);
    drawValue(page, font, C.partA.sealNo.x, C.partA.sealNo.y, activeSealNumbers);
  }
  drawValue(page, font, C.partA.name.x, C.partA.name.y, partA?.pic_name, { maxWidth: 220 });
  drawValue(page, font, C.partA.idNo.x, C.partA.idNo.y, partA?.pic_staff_id);
  drawValue(page, font, C.partA.dateTime.x, C.partA.dateTime.y, formatDateTime(partA?.completed_at ?? null));
  await drawSignature(
    pdfDoc,
    page,
    signatures.part_a,
    C.partA.signature.x,
    C.partA.signature.y,
    C.partA.signature.w,
    C.partA.signature.h
  );

  const partBCheckpoint = "INFLIGHT_POST" as const;
  drawValue(page, font, C.partB.vehicleNo.x, C.partB.vehicleNo.y, partB?.observed_vehicle_number);
  drawValue(
    page,
    font,
    C.partB.sealNo.x,
    C.partB.sealNo.y,
    sealNumbersAt(partBCheckpoint, verifications) || activeSealNumbers
  );
  drawValue(
    page,
    font,
    C.partB.driverNameId.x,
    C.partB.driverNameId.y,
    partB ? `${partB.observed_driver_name ?? "—"} / ${partB.observed_driver_id ?? "—"}` : null,
    { maxWidth: 280 }
  );
  drawValue(page, font, C.partB.asoName.x, C.partB.asoName.y, partB?.avsec_name, { maxWidth: 200 });
  drawValue(page, font, C.partB.asoId.x, C.partB.asoId.y, partB?.avsec_staff_id);
  drawValue(
    page,
    font,
    C.partB.dateTime.x,
    C.partB.dateTime.y,
    partB ? `${partB.checkpoint_date} ${partB.checkpoint_time}` : null
  );
  await drawSignature(
    pdfDoc,
    page,
    signatures.part_b,
    C.partB.signature.x,
    C.partB.signature.y,
    C.partB.signature.w,
    C.partB.signature.h
  );

  const partCCheckpoint = "AIRPORT_POST" as const;
  drawValue(page, font, C.partC.vehicleNo.x, C.partC.vehicleNo.y, partC?.observed_vehicle_number);
  drawValue(
    page,
    font,
    C.partC.sealNo.x,
    C.partC.sealNo.y,
    sealNumbersAt(partCCheckpoint, verifications) || activeSealNumbers
  );
  drawValue(
    page,
    font,
    C.partC.driverNameId.x,
    C.partC.driverNameId.y,
    partC ? `${partC.observed_driver_name ?? "—"} / ${partC.observed_driver_id ?? "—"}` : null,
    { maxWidth: 280 }
  );
  drawValue(page, font, C.partC.asoName.x, C.partC.asoName.y, partC?.avsec_name, { maxWidth: 200 });
  drawValue(page, font, C.partC.asoId.x, C.partC.asoId.y, partC?.avsec_staff_id);
  drawValue(
    page,
    font,
    C.partC.dateTime.x,
    C.partC.dateTime.y,
    partC ? `${partC.checkpoint_date} ${partC.checkpoint_time}` : null
  );
  await drawSignature(
    pdfDoc,
    page,
    signatures.part_c,
    C.partC.signature.x,
    C.partC.signature.y,
    C.partC.signature.w,
    C.partC.signature.h
  );

  // Part D — Outbound only; the Inbound page has no Part D at all.
  if (C.partD) {
    const D = C.partD;
    if (partD) {
      const opt = partD.delivery_location === "SRA_WAREHOUSE" ? D.sraOption : D.aircraftOption;
      markSelected(page, opt.x, opt.y, opt.w, opt.h);
    }
    drawValue(page, font, D.asoName.x, D.asoName.y, partD?.receiver_name, { maxWidth: 200 });
    drawValue(page, font, D.asoId.x, D.asoId.y, partD?.receiver_staff_id);
    drawValue(
      page,
      font,
      D.dateTime.x,
      D.dateTime.y,
      partD ? `${partD.checkpoint_date} ${partD.checkpoint_time}` : null
    );
    await drawSignature(pdfDoc, page, signatures.part_d, D.signature.x, D.signature.y, D.signature.w, D.signature.h);
  }

  // Single remarks block on the physical form — combine whichever
  // checkpoints recorded one (real stored text only, nothing invented).
  const remarkParts = [
    partB?.remarks ? `Part B: ${partB.remarks}` : null,
    partC?.remarks ? `Part C: ${partC.remarks}` : null,
    partD?.remarks ? `Part D: ${partD.remarks}` : null,
  ].filter((r): r is string => !!r);
  if (remarkParts.length > 0) {
    drawWrapped(page, font, C.remarks.x, C.remarks.yTop, remarkParts.join("  "), {
      maxWidth: C.remarks.maxWidth,
      maxLines: C.remarks.maxLines,
      lineHeight: C.remarks.lineHeight,
    });
  }

  return pdfDoc.save();
}

/**
 * Auto-runs right after a transaction reaches COMPLETED (Part D pass, Part
 * D skip, Part Hub, or the inbound final Part B) so the finished official
 * IFCSF form exists for the admin to pull up without anyone opening the
 * transaction page first. Best-effort: a PDF failure never blocks the
 * checkpoint that just completed — it's an audit artifact, not part of
 * the workflow gate.
 *
 * Overlays ICMS transaction data onto the actual official IFCSF PDF
 * (templates/forms/ifcsf/ifcsf-inbound-outbound.pdf — Outbound page 1,
 * Inbound page 2) rather than generating a custom layout. HUB/REDQ-route
 * transactions are OUTBOUND at the direction level and use the same
 * Outbound page; those routes' own steps (Part Hub / Part REDQ) have no
 * counterpart on the official paper form (it predates that workflow
 * extension), so only the fields that exist on the form are filled —
 * Part C/Part D simply stay blank for those routes, same as any other
 * "not completed" field.
 */
export async function generateCompletedFormPdf(transactionId: string): Promise<void> {
  try {
    const supabase = await createClient();
    const { data: txRow } = await supabase.from("transactions").select("*").eq("id", transactionId).single();
    if (!txRow) return;
    const transaction = txRow as Transaction;
    if (transaction.status !== "COMPLETED") return;

    const [partARes, partBRes, partCRes, partDRes, sealsRes] = await Promise.all([
      supabase.from("part_a").select("*").eq("transaction_id", transactionId).maybeSingle(),
      supabase.from("part_b").select("*").eq("transaction_id", transactionId).maybeSingle(),
      supabase.from("part_c").select("*").eq("transaction_id", transactionId).maybeSingle(),
      supabase.from("part_d").select("*").eq("transaction_id", transactionId).maybeSingle(),
      supabase.from("seals").select("*").eq("transaction_id", transactionId),
    ]);
    const partA = partARes.data as PartA | null;
    const partB = partBRes.data as PartBC | null;
    const partC = partCRes.data as PartBC | null;
    const partD = partDRes.data as PartD | null;
    const seals = (sealsRes.data ?? []) as Seal[];

    const sealIds = seals.map((s) => s.id);
    const verifications = sealIds.length
      ? (((await supabase.from("seal_verifications").select("*").in("seal_id", sealIds)).data as
          | SealVerification[]
          | null) ?? [])
      : [];

    const [sigA, sigB, sigC, sigD] = await Promise.all([
      signatureBytes(partA?.signature_url ?? null),
      signatureBytes(partB?.signature_url ?? null),
      signatureBytes(partC?.signature_url ?? null),
      signatureBytes(partD?.signature_url ?? null),
    ]);

    const pdfBytes = await overlayIfcsf(transaction, partA, partB, partC, partD, seals, verifications, {
      part_a: sigA,
      part_b: sigB,
      part_c: sigC,
      part_d: sigD,
    });
    const bytes = Buffer.from(pdfBytes);

    const path = await uploadPdfBuffer("completed-forms", bytes, transaction.transaction_number);

    // No RLS UPDATE policy exists for regular authenticated users on
    // transactions (writes go through triggers/RPCs) — use the service
    // role, same pattern as user management elsewhere in this codebase.
    const admin = createAdminClient();
    const { error: linkError } = await admin
      .from("transactions")
      .update({ completed_form_url: path })
      .eq("id", transactionId);
    if (linkError) {
      console.error(
        "[completed-form-pdf] PDF uploaded to",
        path,
        "but linking it to the transaction failed:",
        linkError.message
      );
    }
  } catch (e) {
    console.error("[completed-form-pdf] generation failed for", transactionId, e);
  }
}
