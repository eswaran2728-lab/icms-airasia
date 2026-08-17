import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedUrl, uploadPdfBuffer } from "@/lib/storage";
import { formatDateTime } from "@/lib/utils";
import { loadOfficialTemplate, drawValue, drawWrapped, drawSignature } from "@/lib/pdf-overlay";
import type { VendorPartA, VendorPartB, VendorPartC, VendorTransaction } from "@/lib/database.types";

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

// ---------------------------------------------------------------------
// Field coordinates on templates/forms/vendor/vendor-supplies-security-
// form.pdf (PDF space, origin bottom-left) — extracted from the official
// file's own printed blank-line positions.
// ---------------------------------------------------------------------
// Exported so completed-form-pdf.ts can overlay HUB-route catering
// transactions onto this same physical template (see overlayHub there).
export const VENDOR_FORM_COORDS = {
  partA: {
    driverName: { x: 264, y: 581.2 },
    nric: { x: 264, y: 566.3 },
    sealNo: { x: 264, y: 551.1 },
    signature: { x: 102, y: 526.3, w: 70, h: 20 },
    dateTime: { x: 102, y: 491.9 },
  },
  partB: {
    vehicleNo: { x: 264, y: 413.6 },
    driverNameNric: { x: 264, y: 397.0 },
    sealNo: { x: 264, y: 380.9 },
    remarks: { x: 263, yTop: 365.8, maxWidth: 290, maxLines: 2, lineHeight: 12 },
    signature: { x: 102, y: 324.8, w: 70, h: 20 },
    dateTime: { x: 102, y: 301.9 },
  },
  partC: {
    vendorSignature: { x: 102, y: 169.9, w: 75, h: 22 },
    warehouseSignature: { x: 348, y: 169.9, w: 75, h: 22 },
    vendorName: { x: 102, y: 135.5 },
    warehouseName: { x: 348, y: 135.5 },
    vendorDate: { x: 102, y: 106.8 },
    warehouseDate: { x: 348, y: 106.8 },
  },
} as const;

async function overlayVendorForm(
  partA: VendorPartA | null,
  partB: VendorPartB | null,
  partC: VendorPartC | null,
  signatures: { part_a: Buffer | null; part_b: Buffer | null; warehouse: Buffer | null; vendor: Buffer | null }
): Promise<Uint8Array> {
  const { pdfDoc, page, font } = await loadOfficialTemplate("VENDOR");

  // Part A (Vendor).
  drawValue(page, font, VENDOR_FORM_COORDS.partA.driverName.x, VENDOR_FORM_COORDS.partA.driverName.y, partA?.driver_name, { maxWidth: 280 });
  drawValue(page, font, VENDOR_FORM_COORDS.partA.nric.x, VENDOR_FORM_COORDS.partA.nric.y, partA?.nric_number);
  drawValue(page, font, VENDOR_FORM_COORDS.partA.sealNo.x, VENDOR_FORM_COORDS.partA.sealNo.y, partA?.seal_number);
  drawValue(
    page,
    font,
    VENDOR_FORM_COORDS.partA.dateTime.x,
    VENDOR_FORM_COORDS.partA.dateTime.y,
    formatDateTime(partA?.completed_at ?? null)
  );
  await drawSignature(
    pdfDoc,
    page,
    signatures.part_a,
    VENDOR_FORM_COORDS.partA.signature.x,
    VENDOR_FORM_COORDS.partA.signature.y,
    VENDOR_FORM_COORDS.partA.signature.w,
    VENDOR_FORM_COORDS.partA.signature.h
  );

  // Part B (AirAsia Security).
  drawValue(page, font, VENDOR_FORM_COORDS.partB.vehicleNo.x, VENDOR_FORM_COORDS.partB.vehicleNo.y, partB?.vehicle_registration_no);
  drawValue(
    page,
    font,
    VENDOR_FORM_COORDS.partB.driverNameNric.x,
    VENDOR_FORM_COORDS.partB.driverNameNric.y,
    partB ? `${partB.driver_name} / ${partB.driver_nric}` : null,
    { maxWidth: 280 }
  );
  drawValue(page, font, VENDOR_FORM_COORDS.partB.sealNo.x, VENDOR_FORM_COORDS.partB.sealNo.y, partB?.seal_number);
  drawWrapped(page, font, VENDOR_FORM_COORDS.partB.remarks.x, VENDOR_FORM_COORDS.partB.remarks.yTop, partB?.remarks, {
    maxWidth: VENDOR_FORM_COORDS.partB.remarks.maxWidth,
    maxLines: VENDOR_FORM_COORDS.partB.remarks.maxLines,
    lineHeight: VENDOR_FORM_COORDS.partB.remarks.lineHeight,
  });
  drawValue(
    page,
    font,
    VENDOR_FORM_COORDS.partB.dateTime.x,
    VENDOR_FORM_COORDS.partB.dateTime.y,
    formatDateTime(partB?.completed_at ?? null)
  );
  await drawSignature(
    pdfDoc,
    page,
    signatures.part_b,
    VENDOR_FORM_COORDS.partB.signature.x,
    VENDOR_FORM_COORDS.partB.signature.y,
    VENDOR_FORM_COORDS.partB.signature.w,
    VENDOR_FORM_COORDS.partB.signature.h
  );

  // Part C (Warehouse — In-Flight), dual certification: left column is
  // Vendor Driver, right column is In-Flight Supervisor, per the
  // template's own column headers.
  await drawSignature(
    pdfDoc,
    page,
    signatures.vendor,
    VENDOR_FORM_COORDS.partC.vendorSignature.x,
    VENDOR_FORM_COORDS.partC.vendorSignature.y,
    VENDOR_FORM_COORDS.partC.vendorSignature.w,
    VENDOR_FORM_COORDS.partC.vendorSignature.h
  );
  await drawSignature(
    pdfDoc,
    page,
    signatures.warehouse,
    VENDOR_FORM_COORDS.partC.warehouseSignature.x,
    VENDOR_FORM_COORDS.partC.warehouseSignature.y,
    VENDOR_FORM_COORDS.partC.warehouseSignature.w,
    VENDOR_FORM_COORDS.partC.warehouseSignature.h
  );
  drawValue(page, font, VENDOR_FORM_COORDS.partC.vendorName.x, VENDOR_FORM_COORDS.partC.vendorName.y, partC?.vendor_driver_name, {
    maxWidth: 220,
  });
  drawValue(page, font, VENDOR_FORM_COORDS.partC.warehouseName.x, VENDOR_FORM_COORDS.partC.warehouseName.y, partC?.warehouse_pic_name, {
    maxWidth: 220,
  });
  drawValue(
    page,
    font,
    VENDOR_FORM_COORDS.partC.vendorDate.x,
    VENDOR_FORM_COORDS.partC.vendorDate.y,
    formatDateTime(partC?.vendor_signed_at ?? null)
  );
  drawValue(
    page,
    font,
    VENDOR_FORM_COORDS.partC.warehouseDate.x,
    VENDOR_FORM_COORDS.partC.warehouseDate.y,
    formatDateTime(partC?.warehouse_signed_at ?? null)
  );

  return pdfDoc.save();
}

/**
 * Auto-runs right after a vendor transaction reaches COMPLETED (both Part
 * C signatures captured). Best-effort: a PDF failure never blocks the
 * checkpoint that just completed — it's an audit artifact, not part of
 * the workflow gate. Mirrors generateCompletedFormPdf() in
 * completed-form-pdf.ts: overlays ICMS data onto the actual official
 * AA/SEC/F/019 "Vendors Supplies Security Form" PDF rather than
 * generating a custom layout.
 */
export async function generateVendorCompletedFormPdf(transactionId: string): Promise<void> {
  try {
    const supabase = await createClient();
    const { data: txRow } = await supabase
      .from("vendor_transactions")
      .select("*")
      .eq("id", transactionId)
      .single();
    if (!txRow) return;
    const transaction = txRow as VendorTransaction;
    if (transaction.status !== "COMPLETED") return;

    const [partARes, partBRes, partCRes] = await Promise.all([
      supabase.from("vendor_part_a").select("*").eq("transaction_id", transactionId).maybeSingle(),
      supabase.from("vendor_part_b").select("*").eq("transaction_id", transactionId).maybeSingle(),
      supabase.from("vendor_part_c").select("*").eq("transaction_id", transactionId).maybeSingle(),
    ]);
    const partA = partARes.data as VendorPartA | null;
    const partB = partBRes.data as VendorPartB | null;
    const partC = partCRes.data as VendorPartC | null;

    const [sigA, sigB, sigWarehouse, sigVendor] = await Promise.all([
      signatureBytes(partA?.signature_url ?? null),
      signatureBytes(partB?.signature_url ?? null),
      signatureBytes(partC?.warehouse_signature_url ?? null),
      signatureBytes(partC?.vendor_signature_url ?? null),
    ]);

    const pdfBytes = await overlayVendorForm(partA, partB, partC, {
      part_a: sigA,
      part_b: sigB,
      warehouse: sigWarehouse,
      vendor: sigVendor,
    });
    const bytes = Buffer.from(pdfBytes);

    const path = await uploadPdfBuffer("completed-forms", bytes, transaction.transaction_number);

    // No RLS UPDATE policy exists for regular authenticated users on
    // vendor_transactions (writes go through triggers) — use the service
    // role, same pattern as the catering completed-form generator.
    const admin = createAdminClient();
    const { error: linkError } = await admin
      .from("vendor_transactions")
      .update({ completed_form_url: path })
      .eq("id", transactionId);
    if (linkError) {
      console.error(
        "[completed-form-pdf-vendor] PDF uploaded to",
        path,
        "but linking it to the transaction failed:",
        linkError.message
      );
    }
  } catch (e) {
    console.error("[completed-form-pdf-vendor] generation failed for", transactionId, e);
  }
}
