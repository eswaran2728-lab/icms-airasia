"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireProfile, requireRole } from "@/lib/auth";
import { uploadDataUrl } from "@/lib/storage";
import { checkpointOrderError, getStep } from "@/lib/workflow";
import { generateQrToken } from "@/lib/qr-token";
import { generateCompletedFormPdf } from "@/lib/completed-form-pdf";
import { CARGO_TYPES } from "@/lib/constants";
import type {
  CargoType,
  DeliveryLocation,
  Direction,
  HubDestination,
  Seal,
  SealCheckpoint,
  SealColor,
  SealType,
  Transaction,
  TransactionRoute,
  UserProfile,
} from "@/lib/database.types";

interface SealDraftInput {
  seal_number: string;
  seal_type: SealType;
  seal_color: SealColor;
}

const SEAL_TYPES: SealType[] = ["TRUCK_SEAL", "TROLLEY", "OTHER"];
const SEAL_COLORS: SealColor[] = ["BLUE", "GREEN", "OTHER"];

function parseSealDrafts(raw: string): SealDraftInput[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const seals: SealDraftInput[] = [];
    for (const item of parsed) {
      const number = String(item?.seal_number ?? "").trim().toUpperCase();
      const type = String(item?.seal_type ?? "") as SealType;
      const color = String(item?.seal_color ?? "") as SealColor;
      if (!number || !SEAL_TYPES.includes(type) || !SEAL_COLORS.includes(color)) return null;
      seals.push({ seal_number: number, seal_type: type, seal_color: color });
    }
    return seals;
  } catch {
    return null;
  }
}

const norm = (s: string) => s.trim().toUpperCase();

/**
 * Verify entered seal numbers AND colours against the seals of record,
 * write the verification trail, and auto-escalate when anything doesn't
 * match: a wrong number raises SEAL_MISMATCH, a right number but wrong
 * colour raises WRONG_SEAL_COLOR. Both are mandatory — a blank entry for
 * either is rejected before any comparison happens. Returns null when
 * every seal's number and colour matched.
 */
async function verifySealsAtCheckpoint(
  supabase: Awaited<ReturnType<typeof createClient>>,
  profile: UserProfile,
  transactionId: string,
  checkpoint: SealCheckpoint,
  rawEntries: string,
  rawColors: string
): Promise<string | null> {
  let entries: Record<string, string>;
  let colors: Record<string, string>;
  try {
    entries = JSON.parse(rawEntries);
  } catch {
    return "Seal entries missing. Enter every seal number. / Masukkan setiap nombor sil.";
  }
  try {
    colors = JSON.parse(rawColors);
  } catch {
    colors = {};
  }

  // superseded_at is null — after a REDQ re-seal, the old (closed-out)
  // seal row still exists for history but must never be checked against
  // again; only the active seal set is compared here. A no-op filter for
  // every non-REDQ transaction, since their seals are never superseded.
  const { data: sealRows, error } = await supabase
    .from("seals")
    .select("*")
    .eq("transaction_id", transactionId)
    .is("superseded_at", null);
  if (error || !sealRows || sealRows.length === 0) {
    return "No seals on record for this transaction. / Tiada sil direkodkan untuk transaksi ini.";
  }
  const seals = sealRows as Seal[];

  // Seal number AND colour are both mandatory — reject before comparing,
  // rather than letting a blank silently read as a mismatch.
  for (const seal of seals) {
    if (!String(entries[seal.id] ?? "").trim()) {
      return "Seal number is mandatory for every seal. / Nombor sil wajib diisi untuk setiap sil.";
    }
    if (!String(colors[seal.id] ?? "").trim()) {
      return "Seal colour is mandatory for every seal. / Warna sil wajib dipilih untuk setiap sil.";
    }
  }

  const numberMismatches: string[] = [];
  const colorMismatches: string[] = [];
  const verifications = seals.map((seal) => {
    const enteredNumber = norm(String(entries[seal.id] ?? ""));
    const enteredColor = norm(String(colors[seal.id] ?? ""));
    const numberMatches = enteredNumber === norm(seal.seal_number);
    const colorMatches = enteredColor === norm(seal.seal_color);
    if (!numberMatches) numberMismatches.push(enteredNumber || "(blank)");
    else if (!colorMatches) colorMismatches.push(`${seal.seal_number} entered as ${enteredColor}`);
    return {
      seal_id: seal.id,
      checkpoint,
      entered_seal_number: enteredNumber,
      observed_seal_color: (enteredColor === "BLUE" || enteredColor === "GREEN"
        ? enteredColor
        : null) as "BLUE" | "GREEN" | null,
      matched: numberMatches && colorMatches,
      verified_by: profile.id,
      photo_url: null,
    };
  });

  const { error: verError } = await supabase.from("seal_verifications").insert(verifications);
  if (verError) {
    return `Seal verification could not be saved: ${verError.message}`;
  }

  if (numberMismatches.length > 0) {
    await supabase.from("incidents").insert({
      transaction_id: transactionId,
      incident_type: "SEAL_MISMATCH",
      description:
        `Automatic escalation at ${checkpoint}: entered seal number(s) ${numberMismatches.join(", ")} ` +
        `did not match the seals applied at Part A. Verified by ${profile.name} (${profile.staff_id}).`,
      reported_by: `${profile.name} (${profile.staff_id})`,
      reported_by_id: profile.id,
      photo_url: null,
    });
    return (
      "SEAL MISMATCH — the transaction has been escalated and the admin notified. " +
      "Do not release the vehicle. / KETIDAKPADANAN SIL — transaksi telah dieskalasi dan admin dimaklumkan. Jangan lepaskan kenderaan."
    );
  }

  if (colorMismatches.length > 0) {
    await supabase.from("incidents").insert({
      transaction_id: transactionId,
      incident_type: "WRONG_SEAL_COLOR",
      description:
        `Automatic escalation at ${checkpoint}: seal colour mismatch — ${colorMismatches.join(", ")}. ` +
        `Verified by ${profile.name} (${profile.staff_id}).`,
      reported_by: `${profile.name} (${profile.staff_id})`,
      reported_by_id: profile.id,
      photo_url: null,
    });
    return (
      "WRONG SEAL COLOUR — the transaction has been escalated and the admin notified. " +
      "Do not release the vehicle. / WARNA SIL TIDAK BETUL — transaksi telah dieskalasi dan admin dimaklumkan. Jangan lepaskan kenderaan."
    );
  }

  return null;
}

/**
 * Secondary whitelist check at Part B/Part C (defense-in-depth for the rare
 * case a vehicle/driver's whitelist status changed after Part A). A PASS may
 * only be recorded when the officer's observed vehicle and driver are both
 * still active whitelist entries — mirrors verifySealsAtCheckpoint: on a
 * violation, raise WHITELIST_VIOLATION directly (which freezes the
 * transaction via the existing escalate_on_incident() trigger) and return a
 * bilingual message, without ever inserting a PASS-result checkpoint record.
 */
async function checkWhitelistAtCheckpoint(
  supabase: Awaited<ReturnType<typeof createClient>>,
  profile: UserProfile,
  transactionId: string,
  part: "part_b" | "part_c",
  observedVehicleNumber: string,
  observedDriverId: string
): Promise<string | null> {
  const [vehicleRes, driverRes] = await Promise.all([
    supabase
      .from("vehicles")
      .select("id")
      .eq("vehicle_number", observedVehicleNumber)
      .eq("is_active", true)
      .maybeSingle(),
    supabase
      .from("drivers")
      .select("id")
      .eq("staff_id", observedDriverId)
      .eq("is_active", true)
      .maybeSingle(),
  ]);

  if (vehicleRes.data && driverRes.data) return null;

  const unlisted: string[] = [];
  if (!vehicleRes.data) unlisted.push(`vehicle ${observedVehicleNumber}`);
  if (!driverRes.data) unlisted.push(`driver ${observedDriverId}`);

  await supabase.from("incidents").insert({
    transaction_id: transactionId,
    incident_type: "WHITELIST_VIOLATION",
    description:
      `Automatic escalation at ${part === "part_b" ? "Part B" : "Part C"}: observed ${unlisted.join(" and ")} ` +
      `not on the active whitelist. Verified by ${profile.name} (${profile.staff_id}).`,
    reported_by: `${profile.name} (${profile.staff_id})`,
    reported_by_id: profile.id,
    photo_url: null,
  });

  return (
    "WHITELIST VIOLATION — the observed vehicle/driver is not on the active whitelist. The transaction has " +
    "been escalated and the admin notified. Do not release the vehicle. " +
    "/ PELANGGARAN SENARAI PUTIH — kenderaan/pemandu tiada dalam senarai putih aktif. Transaksi telah dieskalasi dan admin dimaklumkan. Jangan lepaskan kenderaan."
  );
}

export interface ActionState {
  error: string | null;
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function bool(formData: FormData, key: string): boolean {
  return formData.get(key) === "on" || formData.get(key) === "true";
}

/** Non-negative integer, or null when the field was left blank. */
function optionalInt(formData: FormData, key: string): number | null {
  const raw = str(formData, key);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

/**
 * Part A: a PIC creates the transaction + Part A record together.
 * The PIC picks the direction in the form (Step 1); it is no longer
 * implied by the role.
 * DB trigger assigns the ICMS-YYYY-NNNNNN number; audit triggers log both writes.
 */
export async function createTransaction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["warehouse_pic"]);

  const direction = str(formData, "direction") as Direction;
  const vehicleNumber = str(formData, "vehicle_number").toUpperCase();
  const driverName = str(formData, "driver_name");
  const driverId = str(formData, "driver_id");
  const remarks = str(formData, "remarks");
  const vehicleSearchCompleted = bool(formData, "vehicle_search_completed");
  const signature = str(formData, "signature");
  const seals = parseSealDrafts(str(formData, "seals"));
  const flightNumber = str(formData, "flight_number").toUpperCase();
  const aircraftRegistration = str(formData, "aircraft_registration").toUpperCase();
  const cateringCompanyId = str(formData, "catering_company_id");
  const trolleyCount = Math.max(0, parseInt(str(formData, "trolley_count") || "0", 10) || 0);
  const escortName = str(formData, "escort_officer_name");
  const escortStaffId = str(formData, "escort_officer_staff_id");
  const escortVehicleNumber = str(formData, "escort_vehicle_number").toUpperCase();
  const escalateExpired = bool(formData, "escalate_expired");

  // Route (AIRCRAFT/HUB/REDQ) and hub destination — chosen via the flat
  // Inbound/Outbound/Hub/REDQ→FOB selector on the form. Hub and REDQ imply
  // direction OUTBOUND (never asked separately); the form already enforces
  // this, re-validated here since this is the real check.
  const route = (str(formData, "route") || "AIRCRAFT") as TransactionRoute;
  const hubDestination = (str(formData, "hub_destination") || null) as HubDestination | null;

  // IFCSF (AA/SEC/F/010 Rev.01) header + Part A supplies breakdown.
  const station = str(formData, "station").toUpperCase();
  const cargoTypes = formData.getAll("cargo_types").map(String) as CargoType[];
  const suppliesTotal = optionalInt(formData, "supplies_total");
  const suppliesCarts = optionalInt(formData, "supplies_carts");
  const suppliesSmu = optionalInt(formData, "supplies_smu");
  const suppliesPallets = optionalInt(formData, "supplies_pallets");
  const suppliesBoxes = optionalInt(formData, "supplies_boxes");
  const suppliesOvenRacks = optionalInt(formData, "supplies_oven_racks");

  // The warehouse PIC chooses the direction at creation (Outbound dispatch
  // or Inbound return). Downstream checkpoint order is direction-aware.
  if (direction !== "OUTBOUND" && direction !== "INBOUND") {
    return {
      error: "Select a direction (Outbound or Inbound). / Pilih arah (Keluar atau Masuk).",
    };
  }
  if (!["AIRCRAFT", "HUB", "REDQ"].includes(route)) {
    return { error: "Invalid route selected." };
  }
  if ((route === "HUB" || route === "REDQ") && direction !== "OUTBOUND") {
    return {
      error:
        "Hub and REDQ → FOB are outbound-only routes. / Hub dan REDQ → FOB adalah laluan keluar sahaja.",
    };
  }
  if (route === "HUB" && !hubDestination) {
    return { error: "Select a hub destination. / Pilih destinasi hab." };
  }
  if (route === "HUB" && !["PEN", "JHB", "NILAI"].includes(hubDestination as string)) {
    return { error: "Invalid hub destination selected." };
  }
  if (route !== "HUB" && hubDestination) {
    return { error: "Hub destination only applies to the Hub route." };
  }
  if (!vehicleNumber || !driverName || !driverId) {
    return { error: "Vehicle, driver and driver ID are all required." };
  }
  if (!station) {
    return { error: "Station is required. / Stesen diperlukan." };
  }
  if (cargoTypes.length === 0 || !cargoTypes.every((c) => CARGO_TYPES.includes(c))) {
    return {
      error: "Select at least one cargo type. / Pilih sekurang-kurangnya satu jenis kargo.",
    };
  }

  // GSE Workshop maintenance is auto-derived, never chosen directly: the
  // workshop has no security checkpoint and maintenance duration is
  // unknown up front, so a plain Outbound movement tagged "Vehicle
  // Maintenance" completes at Part C instead of waiting on a Part D that
  // can never happen. Hub/REDQ already have their own terminal step, so
  // this only overrides the default AIRCRAFT route.
  const effectiveRoute: TransactionRoute =
    route === "AIRCRAFT" && direction === "OUTBOUND" && cargoTypes.includes("VEHICLE_MAINTENANCE")
      ? "MAINTENANCE"
      : route;
  if (!seals) {
    return { error: "Add at least one seal with a number, type and color." };
  }
  if (new Set(seals.map((s) => s.seal_number)).size !== seals.length) {
    return { error: "Duplicate seal numbers — each seal number must be unique." };
  }
  const truckSeals = seals.filter((s) => s.seal_type === "TRUCK_SEAL");
  if (truckSeals.length === 0) {
    return { error: "A truck seal is required. / Sil trak diperlukan." };
  }
  // Seal colour is a manual, per-seal choice (parseSealDrafts already
  // rejects any seal without a color picked) — no direction-based rule.
  if (!vehicleSearchCompleted) {
    return { error: "Vehicle search must be completed before dispatch." };
  }
  if (!signature) {
    return { error: "Signature is required." };
  }
  // Escort officer name / staff ID / escort vehicle number are all-or-nothing.
  const escortFields = [escortName, escortStaffId, escortVehicleNumber].filter(Boolean);
  if (escortFields.length > 0 && escortFields.length < 3) {
    return {
      error:
        "Escort officer name, staff ID and escort vehicle number must all be filled in together, or all left blank. " +
        "/ Nama pegawai pengiring, ID kakitangan dan nombor kenderaan pengiring mesti diisi bersama, atau dibiarkan kosong semua.",
    };
  }

  const supabase = await createClient();

  // Whitelist checks: matched entries link to the registry; expired passes
  // block (or escalate on explicit confirmation); unlisted vehicle/driver
  // is a hard block — see enforce_whitelist_on_create(). The escort
  // officer/vehicle is deliberately NOT checked against any whitelist:
  // escort staffing rotates and isn't a registered catering vehicle/driver,
  // unlike the primary vehicle and driver.
  const today = new Date().toISOString().slice(0, 10);
  const [vehicleRes, driverRes] = await Promise.all([
    supabase
      .from("vehicles")
      .select("id, pass_expiry_date, is_active")
      .eq("vehicle_number", vehicleNumber)
      .eq("is_active", true)
      .maybeSingle(),
    supabase
      .from("drivers")
      .select("id, name, pass_expiry_date, is_active")
      .eq("staff_id", driverId)
      .eq("is_active", true)
      .maybeSingle(),
  ]);
  const vehicleRec = vehicleRes.data;
  const driverRec = driverRes.data;

  const expiredItems: string[] = [];
  if (vehicleRec?.pass_expiry_date && vehicleRec.pass_expiry_date < today) {
    expiredItems.push(`vehicle ${vehicleNumber}`);
  }
  if (driverRec?.pass_expiry_date && driverRec.pass_expiry_date < today) {
    expiredItems.push(`driver ${driverId}`);
  }
  if (expiredItems.length > 0 && !escalateExpired) {
    return {
      error:
        `EXPIRED_PASS: airport pass expired for ${expiredItems.join(" and ")}. ` +
        `The vehicle must not proceed. You may create this record as an Expired Pass incident (escalated to the admin) using the button below. ` +
        `/ Pas lapangan terbang telah tamat tempoh.`,
    };
  }

  // Strict whitelist: a vehicle/driver not on the active whitelist is a
  // hard block, same severity tier as missing signature/seals — no more
  // "allowed with mandatory remarks" escape hatch. Only the expired-pass
  // path above stays an override (a vehicle already at the gate).
  const unlisted: string[] = [];
  if (!vehicleRec) unlisted.push(`vehicle ${vehicleNumber}`);
  if (!driverRec) unlisted.push(`driver ${driverId}`);
  if (unlisted.length > 0) {
    return {
      error:
        `WHITELIST_VIOLATION: ${unlisted.join(" and ")} not on the active whitelist. Ask an Admin to add ` +
        `this vehicle/driver to the whitelist before creating this transaction. ` +
        `/ Tiada dalam senarai putih aktif — hubungi Admin untuk menambah kenderaan/pemandu ini sebelum mencipta transaksi.`,
    };
  }

  // The driver ID resolved to a whitelist entry above, but the name typed
  // in must match the name on file for that ID — otherwise a real,
  // whitelisted driver's ID could be used to wave through a different
  // (unlisted) person driving the vehicle.
  if (driverRec && driverRec.name.trim().toUpperCase() !== driverName.trim().toUpperCase()) {
    return {
      error:
        `WHITELIST_VIOLATION: driver name "${driverName}" does not match the whitelisted name on file for ` +
        `driver ID ${driverId}. Enter the driver's registered name exactly, or ask an Admin to correct the ` +
        `whitelist entry if the name on file is wrong. ` +
        `/ Nama pemandu tidak sepadan dengan nama dalam senarai putih untuk ID pemandu ini.`,
    };
  }

  let sig: { path: string; sha256: string };
  try {
    sig = await uploadDataUrl("signatures", signature, "part-a");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const txId = crypto.randomUUID();
  const { data: tx, error: txError } = await supabase
    .from("transactions")
    .insert({
      id: txId,
      direction,
      route: effectiveRoute,
      hub_destination: hubDestination,
      vehicle_number: vehicleNumber,
      driver_name: driverName,
      driver_id: driverId,
      seal_number: null,
      created_by: profile.id,
      qr_token: generateQrToken(txId),
      flight_number: flightNumber || null,
      aircraft_registration: aircraftRegistration || null,
      catering_company_id: cateringCompanyId || null,
      vehicle_id: vehicleRec?.id ?? null,
      driver_id_ref: driverRec?.id ?? null,
      trolley_count: trolleyCount,
      escort_officer_name: escortName || null,
      escort_officer_staff_id: escortStaffId || null,
      escort_vehicle_number: escortVehicleNumber || null,
      station,
      cargo_types: cargoTypes,
      supplies_total: suppliesTotal,
      supplies_carts: suppliesCarts,
      supplies_smu: suppliesSmu,
      supplies_pallets: suppliesPallets,
      supplies_boxes: suppliesBoxes,
      supplies_oven_racks: suppliesOvenRacks,
    })
    .select()
    .single();

  if (txError || !tx) {
    return { error: `Could not create transaction: ${txError?.message ?? "unknown error"}` };
  }

  const { error: partError } = await supabase.from("part_a").insert({
    transaction_id: tx.id,
    pic_name: profile.name,
    pic_staff_id: profile.staff_id,
    vehicle_search_completed: vehicleSearchCompleted,
    signature_url: sig.path,
    signature_hash: sig.sha256,
    remarks: remarks || null,
    completed_by: profile.id,
  });

  if (partError) {
    return { error: `Part A could not be saved: ${partError.message}` };
  }

  const { error: sealsError } = await supabase.from("seals").insert(
    seals.map((s) => ({ ...s, transaction_id: tx.id }))
  );
  if (sealsError) {
    return { error: `Seals could not be saved: ${sealsError.message}` };
  }

  if (expiredItems.length > 0 && escalateExpired) {
    await supabase.from("incidents").insert({
      transaction_id: tx.id,
      incident_type: "EXPIRED_PASS",
      description: `Airport pass expired for ${expiredItems.join(" and ")}. Recorded and escalated at Part A by ${profile.name} (${profile.staff_id}).`,
      reported_by: `${profile.name} (${profile.staff_id})`,
      reported_by_id: profile.id,
      photo_url: null,
    });
    revalidatePath("/transactions");
    revalidatePath("/dashboard");
    redirect(`/transactions/${tx.id}?escalated=1`);
  }

  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  redirect(`/transactions/${tx.id}?created=1`);
}

/** Part B (In-flight Post) and Part C (Airport Post) share the same shape.
 * Sequence is direction-aware: see src/lib/workflow.ts. On INBOUND, Part B
 * is the final step and the DB trigger completes the transaction. */
async function completeChecklistPart(
  part: "part_b" | "part_c",
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole([part === "part_b" ? "post2_avsec" : "post6_avsec"]);

  const transactionId = str(formData, "transaction_id");
  const vehicleVerified = bool(formData, "vehicle_verified");
  const driverVerified = bool(formData, "driver_verified");
  const sealEntries = str(formData, "seal_entries");
  const sealColors = str(formData, "seal_colors");
  const remarks = str(formData, "remarks");
  const signature = str(formData, "signature");
  const officerName = str(formData, "officer_name");
  const officerStaffId = str(formData, "officer_staff_id");
  const checkpointDate = str(formData, "checkpoint_date");
  const checkpointTime = str(formData, "checkpoint_time");
  const observedVehicleNumber = str(formData, "observed_vehicle_number").toUpperCase();
  const observedDriverName = str(formData, "observed_driver_name");
  const observedDriverId = str(formData, "observed_driver_id");
  const result = str(formData, "result") as "PASS" | "ESCALATE";
  const escalationReason = str(formData, "escalation_reason");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (!officerName || !officerStaffId || !observedVehicleNumber || !observedDriverName || !observedDriverId) {
    return { error: "Officer, vehicle, and driver details are required." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkpointDate) || !/^\d{2}:\d{2}$/.test(checkpointTime)) {
    return { error: "Enter a valid checkpoint date and time." };
  }
  if (!['PASS', 'ESCALATE'].includes(result)) {
    return { error: "Select Pass or Escalate." };
  }
  if (result === "ESCALATE" && !escalationReason) {
    return { error: "An escalation reason is required." };
  }
  if (result === "PASS" && (!vehicleVerified || !driverVerified)) {
    return {
      error:
        "Vehicle and driver checks must pass. If a check fails, use Report Incident instead of approving.",
    };
  }
  if (!signature) return { error: "Signature is required." };

  const supabaseForCheck = await createClient();
  const { data: txRow } = await supabaseForCheck
    .from("transactions")
    .select("direction, status, route")
    .eq("id", transactionId)
    .single();

  if (!txRow) return { error: "Transaction not found. / Transaksi tidak dijumpai." };
  const tx = txRow as Pick<Transaction, "direction" | "status" | "route">;

  const orderError = checkpointOrderError(tx.direction, part, tx.status, tx.route);
  if (orderError) return { error: orderError };

  const finalizes = getStep(tx.direction, part, tx.route)?.finalizes ?? false;

  // Secondary whitelist check (Upgrade 2/3 defense-in-depth): a PASS is only
  // recorded when the observed vehicle/driver are still on the active
  // whitelist. Skipped on Escalate — that path freezes the transaction anyway.
  if (result === "PASS") {
    const whitelistError = await checkWhitelistAtCheckpoint(
      supabaseForCheck,
      profile,
      transactionId,
      part,
      observedVehicleNumber,
      observedDriverId
    );
    if (whitelistError) {
      revalidatePath(`/transactions/${transactionId}`);
      revalidatePath("/dashboard");
      return { error: whitelistError };
    }
  }

  // Seals must be entered/scanned by number — mismatch auto-escalates.
  // Skipped when the officer chose Escalate (e.g. a seal too damaged to
  // read); the escalation itself freezes the transaction instead.
  if (result === "PASS") {
    const sealError = await verifySealsAtCheckpoint(
      supabaseForCheck,
      profile,
      transactionId,
      part === "part_b" ? "INFLIGHT_POST" : "AIRPORT_POST",
      sealEntries,
      sealColors
    );
    if (sealError) {
      revalidatePath(`/transactions/${transactionId}`);
      revalidatePath("/dashboard");
      return { error: sealError };
    }
  }

  let sig: { path: string; sha256: string };
  try {
    sig = await uploadDataUrl("signatures", signature, part.replace("_", "-"));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from(part).insert({
    transaction_id: transactionId,
    avsec_name: officerName,
    avsec_staff_id: officerStaffId,
    vehicle_verified: vehicleVerified,
    driver_verified: driverVerified,
    seal_verified: true,
    signature_url: sig.path,
    signature_hash: sig.sha256,
    remarks: remarks || null,
    checkpoint_date: checkpointDate,
    checkpoint_time: checkpointTime,
    observed_vehicle_number: observedVehicleNumber,
    observed_driver_name: observedDriverName,
    observed_driver_id: observedDriverId,
    result,
    escalation_reason: escalationReason || null,
    completed_by: profile.id,
  });

  if (error) {
    return { error: `Checkpoint could not be saved: ${error.message}` };
  }

  if (result === "ESCALATE") {
    const { error: incidentError } = await supabase.from("incidents").insert({
      transaction_id: transactionId,
      incident_type: "OTHER",
      description: `${part === "part_b" ? "Part B" : "Part C"} escalated by ${officerName} (${officerStaffId}): ${escalationReason}`,
      reported_by: `${officerName} (${officerStaffId})`,
      reported_by_id: profile.id,
      photo_url: null,
    });
    if (incidentError) {
      return { error: `Checkpoint was recorded but escalation failed: ${incidentError.message}` };
    }
    revalidatePath(`/transactions/${transactionId}`);
    revalidatePath("/transactions");
    revalidatePath("/dashboard");
    redirect(`/transactions/${transactionId}?escalated=1`);
  }

  if (finalizes) {
    await generateCompletedFormPdf(transactionId);
  }

  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  redirect(`/transactions/${transactionId}?${finalizes ? "completed" : "approved"}=1`);
}

export async function completePartB(_prev: ActionState, formData: FormData) {
  return completeChecklistPart("part_b", formData);
}

export async function completePartC(_prev: ActionState, formData: FormData) {
  return completeChecklistPart("part_c", formData);
}

/** Part D: OUTBOUND-only final delivery confirmation; DB trigger sets COMPLETED. */
export async function completePartD(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["receiver"]);

  const transactionId = str(formData, "transaction_id");
  const deliveryLocation = str(formData, "delivery_location") as DeliveryLocation;
  const sealIntact = bool(formData, "seal_intact");
  const sealEntries = str(formData, "seal_entries");
  const sealColors = str(formData, "seal_colors");
  const remarks = str(formData, "remarks");
  const signature = str(formData, "signature");
  const receiverName = str(formData, "receiver_name");
  const receiverStaffId = str(formData, "receiver_staff_id");
  const checkpointDate = str(formData, "checkpoint_date");
  const checkpointTime = str(formData, "checkpoint_time");
  const result = str(formData, "result") as "PASS" | "ESCALATE";
  const escalationReason = str(formData, "escalation_reason");
  const aircraftIdentifier = str(formData, "aircraft_identifier");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (!receiverName || !receiverStaffId) return { error: "Receiver name and ID are required." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkpointDate) || !/^\d{2}:\d{2}$/.test(checkpointTime)) {
    return { error: "Enter a valid checkpoint date and time." };
  }
  if (!["PASS", "ESCALATE"].includes(result)) return { error: "Select Pass or Escalate." };
  if (result === "ESCALATE" && !escalationReason) {
    return { error: "An escalation reason is required." };
  }

  const supabaseForCheck = await createClient();
  const { data: txRow } = await supabaseForCheck
    .from("transactions")
    .select("direction, status, route")
    .eq("id", transactionId)
    .single();

  if (!txRow) return { error: "Transaction not found. / Transaksi tidak dijumpai." };
  const tx = txRow as Pick<Transaction, "direction" | "status" | "route">;

  const orderError = checkpointOrderError(tx.direction, "part_d", tx.status, tx.route);
  if (orderError) return { error: orderError };

  // Self-reported — no staff at the aircraft to verify it. Only required
  // when delivering to the aircraft itself, not the SRA warehouse.
  if (deliveryLocation === "AIRCRAFT" && !aircraftIdentifier) {
    return {
      error: "Aircraft identifier is required for aircraft delivery. / ID pesawat diperlukan.",
    };
  }

  // Seals are verified by number on the Pass path only; an Escalate result
  // freezes the transaction via the incident instead.
  if (result === "PASS") {
    const sealError = await verifySealsAtCheckpoint(
      supabaseForCheck,
      profile,
      transactionId,
      "PART_D",
      sealEntries,
      sealColors
    );
    if (sealError) {
      revalidatePath(`/transactions/${transactionId}`);
      revalidatePath("/dashboard");
      return { error: sealError };
    }
  }
  if (!["SRA_WAREHOUSE", "AIRCRAFT"].includes(deliveryLocation)) {
    return { error: "Select the delivery location." };
  }
  if (result === "PASS" && !sealIntact) {
    return {
      error: "Seal must be intact to complete delivery. If broken, use Report Incident.",
    };
  }
  if (!signature) return { error: "Signature is required." };

  let sig: { path: string; sha256: string };
  try {
    sig = await uploadDataUrl("signatures", signature, "part-d");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("part_d").insert({
    transaction_id: transactionId,
    delivery_location: deliveryLocation,
    receiver_name: receiverName,
    receiver_staff_id: receiverStaffId,
    seal_intact: sealIntact,
    signature_url: sig.path,
    signature_hash: sig.sha256,
    remarks: remarks || null,
    checkpoint_date: checkpointDate,
    checkpoint_time: checkpointTime,
    result,
    escalation_reason: escalationReason || null,
    aircraft_identifier: aircraftIdentifier || null,
    completed_by: profile.id,
  });

  if (error) {
    return { error: `Delivery could not be saved: ${error.message}` };
  }

  if (result === "ESCALATE") {
    const { error: incidentError } = await supabase.from("incidents").insert({
      transaction_id: transactionId,
      incident_type: "OTHER",
      description: `Part D escalated by ${receiverName} (${receiverStaffId}): ${escalationReason}`,
      reported_by: `${receiverName} (${receiverStaffId})`,
      reported_by_id: profile.id,
      photo_url: null,
    });
    if (incidentError) {
      return { error: `Part D was recorded but escalation failed: ${incidentError.message}` };
    }
    revalidatePath(`/transactions/${transactionId}`);
    revalidatePath("/transactions");
    revalidatePath("/dashboard");
    redirect(`/transactions/${transactionId}?escalated=1`);
  }

  await generateCompletedFormPdf(transactionId);

  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  redirect(`/transactions/${transactionId}?completed=1`);
}

/**
 * Part Hub: hub_avsec confirms delivery — the terminal step for HUB-route
 * transactions (no Part C/D). The confirmed destination is derived
 * server-side from the transaction's own hub_destination rather than
 * trusted from the client, so there is no way to submit a mismatched
 * destination in the first place (enforce_part_hub_sequence() also
 * rejects a mismatch, as a second layer).
 */
export async function completePartHub(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["hub_avsec"]);

  const transactionId = str(formData, "transaction_id");
  const remarks = str(formData, "remarks");
  const signature = str(formData, "signature");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (!signature) return { error: "Signature is required." };

  const supabaseForCheck = await createClient();
  const { data: txRow } = await supabaseForCheck
    .from("transactions")
    .select("direction, status, route, hub_destination")
    .eq("id", transactionId)
    .single();

  if (!txRow) return { error: "Transaction not found. / Transaksi tidak dijumpai." };
  const tx = txRow as Pick<Transaction, "direction" | "status" | "route" | "hub_destination">;

  if (tx.route !== "HUB") {
    return { error: "This checkpoint only applies to HUB-route transactions." };
  }
  const orderError = checkpointOrderError(tx.direction, "part_hub", tx.status, tx.route);
  if (orderError) return { error: orderError };
  if (!tx.hub_destination) {
    return { error: "No hub destination on file for this transaction." };
  }

  let sig: { path: string; sha256: string };
  try {
    sig = await uploadDataUrl("signatures", signature, "part-hub");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("part_hub").insert({
    transaction_id: transactionId,
    confirmed_destination: tx.hub_destination,
    hub_avsec_name: profile.name,
    hub_avsec_staff_id: profile.staff_id,
    remarks: remarks || null,
    signature_url: sig.path,
    signature_hash: sig.sha256,
    completed_by: profile.id,
  });

  if (error) {
    return { error: `Part Hub could not be saved: ${error.message}` };
  }

  await generateCompletedFormPdf(transactionId);

  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  redirect(`/transactions/${transactionId}?completed=1`);
}

/**
 * Part REDQ: the re-seal event for REDQ-route transactions. Verifies the
 * old (active) truck seal by number and colour — same mismatch/escalation
 * shape as verifySealsAtCheckpoint, but scoped to exactly one seal rather
 * than the JSON-map-of-all-seals shape that helper expects, so this is
 * written directly rather than force-reusing it. Applies the new seal
 * (must exist before part_redq references it — FK requires this insert
 * order), then inserts part_redq; enforce_part_redq_sequence() supersedes
 * the old seal and advances status to REDQ_RESEALED.
 */
export async function completePartRedq(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["redq_avsec"]);

  const transactionId = str(formData, "transaction_id");
  const oldSealNumber = str(formData, "old_seal_number");
  const oldSealColor = str(formData, "old_seal_color");
  const newSealNumber = str(formData, "new_seal_number").toUpperCase();
  const newSealColor = str(formData, "new_seal_color") as SealColor;
  const remarks = str(formData, "remarks");
  const signature = str(formData, "signature");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (!oldSealNumber || !oldSealColor) {
    return { error: "Enter the old seal's number and observed colour, as physically read." };
  }
  if (!newSealNumber || !newSealColor) {
    return { error: "Enter the new seal's number and colour." };
  }
  if (!signature) return { error: "Signature is required." };

  const supabaseForCheck = await createClient();
  const { data: txRow } = await supabaseForCheck
    .from("transactions")
    .select("direction, status, route")
    .eq("id", transactionId)
    .single();

  if (!txRow) return { error: "Transaction not found. / Transaksi tidak dijumpai." };
  const tx = txRow as Pick<Transaction, "direction" | "status" | "route">;

  if (tx.route !== "REDQ") {
    return { error: "This checkpoint only applies to REDQ-route transactions." };
  }
  const orderError = checkpointOrderError(tx.direction, "part_redq", tx.status, tx.route);
  if (orderError) return { error: orderError };

  // Scoped to the truck seal specifically — a multi-seal Part A submission
  // may also have non-superseded trolley/other seals, which REDQ doesn't
  // touch. superseded_at is null: the current active seal of record.
  const { data: activeSealRow } = await supabaseForCheck
    .from("seals")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("seal_type", "TRUCK_SEAL")
    .is("superseded_at", null)
    .maybeSingle();

  if (!activeSealRow) {
    return { error: "No active truck seal on record for this transaction." };
  }
  const activeSeal = activeSealRow as Seal;

  const enteredOldNumber = norm(oldSealNumber);
  const enteredOldColor = norm(oldSealColor);
  const numberMatches = enteredOldNumber === norm(activeSeal.seal_number);
  const colorMatches = enteredOldColor === norm(activeSeal.seal_color);

  const supabase = await createClient();

  const { error: verError } = await supabase.from("seal_verifications").insert({
    seal_id: activeSeal.id,
    checkpoint: "REDQ",
    entered_seal_number: enteredOldNumber,
    observed_seal_color: (enteredOldColor === "BLUE" || enteredOldColor === "GREEN"
      ? enteredOldColor
      : null) as "BLUE" | "GREEN" | null,
    matched: numberMatches && colorMatches,
    verified_by: profile.id,
    photo_url: null,
  });
  if (verError) {
    return { error: `Seal verification could not be saved: ${verError.message}` };
  }

  if (!numberMatches || !colorMatches) {
    await supabase.from("incidents").insert({
      transaction_id: transactionId,
      incident_type: !numberMatches ? "SEAL_MISMATCH" : "WRONG_SEAL_COLOR",
      description:
        `Automatic escalation at REDQ: entered old seal ${enteredOldNumber} (${enteredOldColor}) did not match ` +
        `the seal of record ${activeSeal.seal_number} (${activeSeal.seal_color}). Verified by ${profile.name} (${profile.staff_id}).`,
      reported_by: `${profile.name} (${profile.staff_id})`,
      reported_by_id: profile.id,
      photo_url: null,
    });
    revalidatePath(`/transactions/${transactionId}`);
    revalidatePath("/dashboard");
    return {
      error: !numberMatches
        ? "SEAL MISMATCH — the old seal number does not match the seal of record. The transaction has been " +
          "escalated and the admin notified. Do not proceed. / KETIDAKPADANAN SIL — transaksi telah dieskalasi."
        : "WRONG SEAL COLOUR — the transaction has been escalated and the admin notified. Do not proceed. " +
          "/ WARNA SIL TIDAK BETUL — transaksi telah dieskalasi.",
    };
  }

  // Still outbound — the new seal must be BLUE, same rule as Part A
  // (enforce_seal_color() checks this at the DB layer too).
  if (newSealColor !== "BLUE") {
    return { error: "The new seal at REDQ must be BLUE (outbound). / Sil baharu di REDQ mesti BIRU." };
  }

  let sig: { path: string; sha256: string };
  try {
    sig = await uploadDataUrl("signatures", signature, "part-redq");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const newSealId = crypto.randomUUID();
  const { error: newSealError } = await supabase.from("seals").insert({
    id: newSealId,
    transaction_id: transactionId,
    seal_number: newSealNumber,
    seal_type: "TRUCK_SEAL",
    seal_color: newSealColor,
  });
  if (newSealError) {
    return { error: `New seal could not be saved: ${newSealError.message}` };
  }

  const { error } = await supabase.from("part_redq").insert({
    transaction_id: transactionId,
    old_seal_id: activeSeal.id,
    new_seal_id: newSealId,
    redq_avsec_name: profile.name,
    redq_avsec_staff_id: profile.staff_id,
    remarks: remarks || null,
    signature_url: sig.path,
    signature_hash: sig.sha256,
    completed_by: profile.id,
  });

  if (error) {
    return { error: `Part REDQ could not be saved: ${error.message}` };
  }

  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  redirect(`/transactions/${transactionId}?approved=1`);
}

/**
 * Part D is optional: the receiver or an admin may complete an outbound
 * transaction straight from AIRPORT_POST_APPROVED without ever filling in
 * Part D. Delegates to the skip_part_d() DB function, which re-validates
 * role/status/direction itself and writes the reason + COMPLETED status
 * in one step (audited automatically by the existing transactions trigger).
 */
export async function skipPartD(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const profile = await requireRole(["receiver", "supervisor"]);

  const transactionId = str(formData, "transaction_id");
  const reason = str(formData, "reason");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (!reason) {
    return { error: "A reason is required to complete without Part D." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("skip_part_d", {
    p_transaction_id: transactionId,
    p_reason: `${reason} (recorded by ${profile.name}, ${profile.staff_id})`,
  });

  if (error) {
    return { error: error.message };
  }

  await generateCompletedFormPdf(transactionId);

  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  redirect(`/transactions/${transactionId}?completed=1`);
}

/** Incident report from any signed-in role; DB trigger escalates the transaction. */
export async function reportIncident(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireProfile();

  const transactionId = str(formData, "transaction_id");
  const incidentType = str(formData, "incident_type");
  const description = str(formData, "description");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (
    ![
      "BROKEN_SEAL",
      "SEAL_MISMATCH",
      "UNAUTHORIZED_DRIVER",
      "UNAUTHORIZED_VEHICLE",
      "EXPIRED_PASS",
      "WRONG_SEAL_COLOR",
      "OTHER",
    ].includes(incidentType)
  ) {
    return { error: "Select the incident type." };
  }
  if (!description) return { error: "Describe what happened." };

  let photoDataUrls: string[] = [];
  try {
    const parsed = JSON.parse(str(formData, "photos") || "[]");
    if (Array.isArray(parsed)) photoDataUrls = parsed.filter((p) => typeof p === "string");
  } catch {
    // no photos
  }

  const photoPaths: string[] = [];
  for (const dataUrl of photoDataUrls.slice(0, 5)) {
    try {
      photoPaths.push((await uploadDataUrl("incident-photos", dataUrl, "incident")).path);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Photo upload failed." };
    }
  }

  const supabase = await createClient();
  const { data: incident, error } = await supabase
    .from("incidents")
    .insert({
      transaction_id: transactionId,
      incident_type: incidentType as never,
      description,
      reported_by: `${profile.name} (${profile.staff_id})`,
      reported_by_id: profile.id,
      photo_url: photoPaths[0] ?? null,
    })
    .select()
    .single();

  if (error || !incident) {
    return { error: `Incident could not be saved: ${error?.message ?? "unknown error"}` };
  }

  if (photoPaths.length > 0) {
    await supabase
      .from("incident_photos")
      .insert(photoPaths.map((p) => ({ incident_id: incident.id, photo_url: p })));
  }

  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/incidents");
  revalidatePath("/dashboard");
  redirect(`/transactions/${transactionId}?escalated=1`);
}
