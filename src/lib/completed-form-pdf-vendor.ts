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
const COORDS = {
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
  drawValue(page, font, COORDS.partA.driverName.x, COORDS.partA.driverName.y, partA?.driver_name, { maxWidth: 280 });
  drawValue(page, font, COORDS.partA.nric.x, COORDS.partA.nric.y, partA?.nric_number);
  drawValue(page, font, COORDS.partA.sealNo.x, COORDS.partA.sealNo.y, partA?.seal_number);
  drawValue(
    page,
    font,
    COORDS.partA.dateTime.x,
    COORDS.partA.dateTime.y,
    formatDateTime(partA?.completed_at ?? null)
  );
  await drawSignature(
    pdfDoc,
    page,
    signatures.part_a,
    COORDS.partA.signature.x,
    COORDS.partA.signature.y,
    COORDS.partA.signature.w,
    COORDS.partA.signature.h
  );

  // Part B (AirAsia Security).
  drawValue(page, font, COORDS.partB.vehicleNo.x, COORDS.partB.vehicleNo.y, partB?.vehicle_registration_no);
  drawValue(
    page,
    font,
    COORDS.partB.driverNameNric.x,
    COORDS.partB.driverNameNric.y,
    partB ? `${partB.driver_name} / ${partB.driver_nric}` : null,
    { maxWidth: 280 }
  );
  drawValue(page, font, COORDS.partB.sealNo.x, COORDS.partB.sealNo.y, partB?.seal_number);
  drawWrapped(page, font, COORDS.partB.remarks.x, COORDS.partB.remarks.yTop, partB?.remarks, {
    maxWidth: COORDS.partB.remarks.maxWidth,
    maxLines: COORDS.partB.remarks.maxLines,
    lineHeight: COORDS.partB.remarks.lineHeight,
  });
  drawValue(
    page,
    font,
    COORDS.partB.dateTime.x,
    COORDS.partB.dateTime.y,
    formatDateTime(partB?.completed_at ?? null)
  );
  await drawSignature(
    pdfDoc,
    page,
    signatures.part_b,
    COORDS.partB.signature.x,
    COORDS.partB.signature.y,
    COORDS.partB.signature.w,
    COORDS.partB.signature.h
  );

  // Part C (Warehouse — In-Flight), dual certification: left column is
  // Vendor Driver, right column is In-Flight Supervisor, per the
  // template's own column headers.
  await drawSignature(
    pdfDoc,
    page,
    signatures.vendor,
    COORDS.partC.vendorSignature.x,
    COORDS.partC.vendorSignature.y,
    COORDS.partC.vendorSignature.w,
    COORDS.partC.vendorSignature.h
  );
  await drawSignature(
    pdfDoc,
    page,
    signatures.warehouse,
    COORDS.partC.warehouseSignature.x,
    COORDS.partC.warehouseSignature.y,
    COORDS.partC.warehouseSignature.w,
    COORDS.partC.warehouseSignature.h
  );
  drawValue(page, font, COORDS.partC.vendorName.x, COORDS.partC.vendorName.y, partC?.vendor_driver_name, {
    maxWidth: 220,
  });
  drawValue(page, font, COORDS.partC.warehouseName.x, COORDS.partC.warehouseName.y, partC?.warehouse_pic_name, {
    maxWidth: 220,
  });
  drawValue(
    page,
    font,
    COORDS.partC.vendorDate.x,
    COORDS.partC.vendorDate.y,
    formatDateTime(partC?.vendor_signed_at ?? null)
  );
  drawValue(
    page,
    font,
    COORDS.partC.warehouseDate.x,
    COORDS.partC.warehouseDate.y,
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
