"use client";

import { useActionState, useMemo, useState } from "react";
import { PlaneTakeoff, PlaneLanding, Building2, Repeat } from "lucide-react";
import { createTransaction, type ActionState } from "@/lib/actions/transactions";
import { stepsFor } from "@/lib/workflow";
import { CARGO_TYPE_LABELS, CARGO_TYPES, HUB_DESTINATION_LABELS } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BigCheckbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SignatureField } from "@/components/signature-pad";
import { SealEditor, type SealDraft } from "@/components/seal-editor";
import type {
  CargoType,
  CateringCompany,
  Direction,
  DriverRecord,
  HubDestination,
  TransactionRoute,
  VehicleRecord,
} from "@/lib/database.types";

const initialState: ActionState = { error: null };

type WhitelistState = "matched" | "expired" | "unlisted" | "empty";

function whitelistHint(state: WhitelistState): { text: string; className: string } | null {
  switch (state) {
    case "matched":
      return { text: "✓ Whitelisted, pass valid", className: "text-emerald-600" };
    case "expired":
      return {
        text: "✕ Whitelisted but airport pass EXPIRED — will be blocked",
        className: "font-semibold text-red-600",
      };
    case "unlisted":
      return {
        text: "✕ Not in whitelist — submission will be blocked",
        className: "font-semibold text-red-600",
      };
    default:
      return null;
  }
}

interface PartAFormProps {
  picName: string;
  picStaffId: string;
  companies: CateringCompany[];
  vehicles: Pick<VehicleRecord, "vehicle_number" | "pass_expiry_date">[];
  drivers: Pick<DriverRecord, "name" | "staff_id" | "pass_expiry_date">[];
}

/**
 * One flat choice of four — not a two-step direction-then-route picker.
 * Hub and REDQ → FOB imply direction OUTBOUND automatically (never asked
 * separately, since neither route is ever valid inbound); underneath, the
 * form still writes the same direction/route/hub_destination fields as
 * before, just derived from one selection instead of two.
 */
type MovementSelection = "INBOUND" | "OUTBOUND" | "HUB" | "REDQ";

const MOVEMENT_OPTIONS: {
  value: MovementSelection;
  direction: Direction;
  route: TransactionRoute;
  title: string;
  subtitle: string;
  icon: typeof PlaneTakeoff;
}[] = [
  {
    value: "INBOUND",
    direction: "INBOUND",
    route: "AIRCRAFT",
    title: "Inbound",
    subtitle: "Aircraft → SRA warehouse",
    icon: PlaneLanding,
  },
  {
    value: "OUTBOUND",
    direction: "OUTBOUND",
    route: "AIRCRAFT",
    title: "Outbound",
    subtitle: "Catering warehouse → aircraft",
    icon: PlaneTakeoff,
  },
  {
    value: "HUB",
    direction: "OUTBOUND",
    route: "HUB",
    title: "Hub",
    subtitle: "Catering warehouse → hub",
    icon: Building2,
  },
  {
    value: "REDQ",
    direction: "OUTBOUND",
    route: "REDQ",
    title: "REDQ → FOB",
    subtitle: "Re-seal at REDQ, then continue to FOB",
    icon: Repeat,
  },
];

const HUB_DESTINATIONS: HubDestination[] = ["PEN", "JHB", "NILAI"];

export function PartAForm({
  picName,
  picStaffId,
  companies,
  vehicles,
  drivers,
}: PartAFormProps) {
  const [state, formAction, pending] = useActionState(createTransaction, initialState);
  const [movement, setMovement] = useState<MovementSelection | null>(null);
  const [hubDestination, setHubDestination] = useState<HubDestination | "">("");
  const [searchDone, setSearchDone] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [driverId, setDriverId] = useState("");
  const [driverName, setDriverName] = useState("");
  const [escortOfficerName, setEscortOfficerName] = useState("");
  const [escortOfficerStaffId, setEscortOfficerStaffId] = useState("");
  const [escortVehicleNumber, setEscortVehicleNumber] = useState("");
  const [seals, setSeals] = useState<SealDraft[]>([
    { seal_number: "", seal_type: "TRUCK_SEAL", seal_color: "" },
  ]);
  const [cargoTypes, setCargoTypes] = useState<CargoType[]>([]);

  const defaultCompanyId = companies.find((c) => c.code === "IFC")?.id ?? "";

  const toggleCargoType = (type: CargoType) => {
    setCargoTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  const sealsReady =
    seals.length > 0 && seals.every((s) => s.seal_number.trim() !== "" && s.seal_color !== "");
  const today = new Date().toISOString().slice(0, 10);

  const vehicleState: WhitelistState = useMemo(() => {
    const v = vehicleNumber.trim().toUpperCase();
    if (!v) return "empty";
    const rec = vehicles.find((x) => x.vehicle_number.toUpperCase() === v);
    if (!rec) return "unlisted";
    return rec.pass_expiry_date && rec.pass_expiry_date < today ? "expired" : "matched";
  }, [vehicleNumber, vehicles, today]);

  const matchedDriver = useMemo(() => {
    const d = driverId.trim().toUpperCase();
    if (!d) return null;
    return drivers.find((x) => x.staff_id.toUpperCase() === d) ?? null;
  }, [driverId, drivers]);

  const driverState: WhitelistState = useMemo(() => {
    if (!driverId.trim()) return "empty";
    if (!matchedDriver) return "unlisted";
    return matchedDriver.pass_expiry_date && matchedDriver.pass_expiry_date < today
      ? "expired"
      : "matched";
  }, [driverId, matchedDriver, today]);

  // The driver ID resolved to a whitelist entry, but the typed name must
  // also match the name on file — an ID alone shouldn't wave through
  // whoever is actually driving.
  const driverNameMismatch =
    matchedDriver !== null &&
    driverName.trim() !== "" &&
    driverName.trim().toUpperCase() !== matchedDriver.name.trim().toUpperCase();

  const vehicleHint = whitelistHint(vehicleState);
  const driverHint = whitelistHint(driverState);
  const expiredBlocked = state.error?.startsWith("EXPIRED_PASS:") ?? false;

  // Escort officer name / staff ID / escort vehicle number are all-or-nothing.
  // Deliberately NOT checked against the vehicle/driver whitelist — escort
  // staffing and vehicles rotate and aren't registered catering entries.
  const escortAny = escortOfficerName.trim() || escortOfficerStaffId.trim() || escortVehicleNumber.trim();
  const escortComplete =
    !escortAny ||
    (escortOfficerName.trim() !== "" && escortOfficerStaffId.trim() !== "" && escortVehicleNumber.trim() !== "");
  const anyUnlisted = vehicleState === "unlisted" || driverState === "unlisted";

  const selectedOption = MOVEMENT_OPTIONS.find((o) => o.value === movement) ?? null;
  const direction = selectedOption?.direction ?? null;
  const route = selectedOption?.route ?? null;

  // GSE Workshop maintenance is auto-derived from the cargo-type checklist
  // (no separate movement-type choice) — preview only, the server makes
  // the authoritative call at insert time using this same rule.
  const isMaintenance =
    route === "AIRCRAFT" && direction === "OUTBOUND" && cargoTypes.includes("VEHICLE_MAINTENANCE");
  const effectiveRoute = isMaintenance ? "MAINTENANCE" : route;

  const flow =
    direction && effectiveRoute
      ? ["A · Warehouse", ...stepsFor(direction, effectiveRoute).map((s) => s.shortLabel)].join("  →  ")
      : null;

  const hubDestinationReady = movement !== "HUB" || hubDestination !== "";

  return (
    <div className="space-y-4">
      {/* Step 1 — one flat choice of four, not a two-step direction-then-route
          picker. Hub and REDQ → FOB imply direction OUTBOUND automatically. */}
      <Card>
        <CardContent className="pt-6">
          <p className="mb-3 text-sm font-semibold">
            Step 1 — Movement Type
            <span className="ml-2 font-normal text-muted-foreground">
              What kind of movement is this?
            </span>
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {MOVEMENT_OPTIONS.map((opt) => {
              const active = movement === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setMovement(opt.value);
                    if (opt.value !== "HUB") setHubDestination("");
                  }}
                  aria-pressed={active}
                  className={
                    active
                      ? "flex items-center gap-3 rounded-xl border-2 border-primary bg-primary/10 p-4 text-left transition-all"
                      : "flex items-center gap-3 rounded-xl border-2 border-border bg-card p-4 text-left transition-all hover:border-primary/40 hover:bg-accent"
                  }
                >
                  <div
                    className={
                      active
                        ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
                        : "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                    }
                  >
                    <opt.icon className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="font-heading font-bold">{opt.title}</p>
                    <p className="text-xs text-muted-foreground">{opt.subtitle}</p>
                  </div>
                </button>
              );
            })}
          </div>

          {movement === "HUB" ? (
            <div className="mt-3 space-y-2">
              <Label htmlFor="hub_destination">Hub Destination</Label>
              <Select
                id="hub_destination"
                value={hubDestination}
                onChange={(e) => setHubDestination(e.target.value as HubDestination)}
              >
                <option value="" disabled>
                  Select destination…
                </option>
                {HUB_DESTINATIONS.map((d) => (
                  <option key={d} value={d}>
                    {HUB_DESTINATION_LABELS[d]}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          {flow ? (
            <p className="mt-3 rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground">
              {flow}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {direction === null || route === null ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          Select a movement type above to continue.
        </p>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <form action={formAction} className="space-y-5">
              <input type="hidden" name="direction" value={direction} />
              <input type="hidden" name="route" value={route} />
              {movement === "HUB" ? (
                <input type="hidden" name="hub_destination" value={hubDestination} />
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="flight_number">Flight Number (optional)</Label>
              <Input id="flight_number" name="flight_number" placeholder="e.g. AK 703" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aircraft_registration">Aircraft Registration (optional)</Label>
              <Input id="aircraft_registration" name="aircraft_registration" placeholder="e.g. 9M-AQD" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="catering_company_id">Catering Company</Label>
              <Select
                id="catering_company_id"
                name="catering_company_id"
                defaultValue={defaultCompanyId}
              >
                <option value="">— Not specified —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="station">Station</Label>
              <Input
                id="station"
                name="station"
                placeholder="e.g. KUL"
                autoCapitalize="characters"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vehicle_number">Vehicle Number</Label>
              <Input
                id="vehicle_number"
                name="vehicle_number"
                placeholder="e.g. WKD 4521"
                autoCapitalize="characters"
                value={vehicleNumber}
                onChange={(e) => setVehicleNumber(e.target.value)}
                required
                className="font-mono"
              />
              {vehicleHint ? (
                <p className={`text-xs ${vehicleHint.className}`}>{vehicleHint.text}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="driver_id">Driver ID</Label>
              <Input
                id="driver_id"
                name="driver_id"
                value={driverId}
                onChange={(e) => setDriverId(e.target.value)}
                required
                className="font-mono"
              />
              {driverHint ? (
                <p className={`text-xs ${driverHint.className}`}>{driverHint.text}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="driver_name">Driver Name</Label>
              <Input
                id="driver_name"
                name="driver_name"
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                required
              />
              {driverNameMismatch ? (
                <p className="text-xs font-semibold text-red-600">
                  ✕ Does not match the whitelisted name for this driver ID — submission will be
                  blocked. / Tidak sepadan dengan nama dalam senarai putih untuk ID pemandu ini.
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="escort_officer_name">Escort Officer (optional)</Label>
              <div className="flex gap-2">
                <Input
                  id="escort_officer_name"
                  name="escort_officer_name"
                  placeholder="Name"
                  value={escortOfficerName}
                  onChange={(e) => setEscortOfficerName(e.target.value)}
                />
                <Input
                  name="escort_officer_staff_id"
                  placeholder="Staff ID"
                  className="w-32 font-mono"
                  value={escortOfficerStaffId}
                  onChange={(e) => setEscortOfficerStaffId(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="escort_vehicle_number">
                Escort Vehicle Number{" "}
                {escortAny ? <span className="font-normal text-muted-foreground">(required with escort officer)</span> : "(optional)"}
              </Label>
              <Input
                id="escort_vehicle_number"
                name="escort_vehicle_number"
                placeholder="e.g. WKD 9912"
                autoCapitalize="characters"
                value={escortVehicleNumber}
                onChange={(e) => setEscortVehicleNumber(e.target.value)}
                className="font-mono"
              />
              {!escortComplete ? (
                <p className="text-xs font-semibold text-red-600">
                  Escort officer name, staff ID and escort vehicle number must all be filled in
                  together, or all left blank. / Ketiga-tiganya mesti diisi bersama, atau dibiarkan
                  kosong semua.
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-4 rounded-lg border p-4">
            <p className="text-sm font-semibold">
              In-flight Supplies
              <span className="ml-2 font-normal text-muted-foreground">
                (IFCSF Part A — AA/SEC/F/010)
              </span>
            </p>

            <div className="space-y-2">
              <Label>Cargo Type</Label>
              <div className="flex flex-wrap gap-2">
                {CARGO_TYPES.map((type) => {
                  const checked = cargoTypes.includes(type);
                  return (
                    <label
                      key={type}
                      className={
                        checked
                          ? "flex cursor-pointer items-center gap-2 rounded-lg border-2 border-primary bg-primary/10 px-3 py-2 text-sm font-medium"
                          : "flex cursor-pointer items-center gap-2 rounded-lg border-2 border-border px-3 py-2 text-sm font-medium hover:border-primary/40"
                      }
                    >
                      <input
                        type="checkbox"
                        name="cargo_types"
                        value={type}
                        checked={checked}
                        onChange={() => toggleCargoType(type)}
                        className="h-4 w-4 accent-primary"
                      />
                      {CARGO_TYPE_LABELS[type]}
                    </label>
                  );
                })}
              </div>
              {cargoTypes.length === 0 ? (
                <p className="text-xs text-muted-foreground">Select at least one.</p>
              ) : null}
              {isMaintenance ? (
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                  GSE Workshop (Maintenance): this transaction completes at Part C — Airport Post
                  (Post 6). The workshop has no security checkpoint, so Part D does not apply.
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="supplies_total">Total Number In-flight Supplies</Label>
              <Input id="supplies_total" name="supplies_total" type="number" min={0} className="max-w-xs" />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div className="space-y-1">
                <Label htmlFor="supplies_carts" className="text-xs">Carts</Label>
                <Input id="supplies_carts" name="supplies_carts" type="number" min={0} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="supplies_smu" className="text-xs">SMU</Label>
                <Input id="supplies_smu" name="supplies_smu" type="number" min={0} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="supplies_pallets" className="text-xs">Pallets</Label>
                <Input id="supplies_pallets" name="supplies_pallets" type="number" min={0} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="supplies_boxes" className="text-xs">Boxes</Label>
                <Input id="supplies_boxes" name="supplies_boxes" type="number" min={0} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="supplies_oven_racks" className="text-xs">Oven Rack</Label>
                <Input id="supplies_oven_racks" name="supplies_oven_racks" type="number" min={0} />
              </div>
            </div>
          </div>

          <SealEditor seals={seals} onChange={setSeals} />
          <input type="hidden" name="seals" value={JSON.stringify(seals)} />

          <BigCheckbox
            id="vehicle_search_completed"
            name="vehicle_search_completed"
            label="Vehicle search completed"
            description="Cab, cargo area and undercarriage inspected before sealing."
            checked={searchDone}
            onCheckedChange={setSearchDone}
            required
          />

          <div className="space-y-2">
            <Label htmlFor="remarks">Remarks (optional)</Label>
            <Textarea id="remarks" name="remarks" rows={2} />
          </div>

          {anyUnlisted ? (
            <p className="rounded-md bg-red-100 p-3 text-sm font-semibold text-red-800 dark:bg-red-900/40 dark:text-red-200">
              WHITELIST VIOLATION — a vehicle or driver above is not on the active whitelist.
              Submission is blocked; ask an Admin to add it under Whitelists. / PELANGGARAN SENARAI
              PUTIH — hantar dihalang; hubungi Admin untuk menambah dalam Senarai Putih.
            </p>
          ) : null}

          {driverNameMismatch ? (
            <p className="rounded-md bg-red-100 p-3 text-sm font-semibold text-red-800 dark:bg-red-900/40 dark:text-red-200">
              WHITELIST VIOLATION — the driver name does not match the whitelisted name on file for
              this driver ID. Submission is blocked. / PELANGGARAN SENARAI PUTIH — nama pemandu
              tidak sepadan dengan senarai putih.
            </p>
          ) : null}

          <div className="rounded-md bg-muted p-3 text-sm">
            <p>
              <span className="text-muted-foreground">PIC:</span>{" "}
              <span className="font-medium">{picName}</span>{" "}
              <span className="text-muted-foreground">({picStaffId})</span>
            </p>
          </div>

          <SignatureField onChange={setSignature} />
          <input type="hidden" name="signature" value={signature ?? ""} />

          {state.error ? (
            <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
              {state.error.replace(/^(EXPIRED_PASS|WHITELIST_VIOLATION):\s*/, "")}
            </p>
          ) : null}

          {expiredBlocked ? (
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-red-400 bg-red-50 p-3 text-sm dark:bg-red-950/40">
              <input type="checkbox" name="escalate_expired" className="h-5 w-5 accent-red-600" />
              <span>
                Record anyway as an <strong>Expired Pass incident</strong> — the transaction is
                created and immediately escalated to the admin; the vehicle must not proceed.
              </span>
            </label>
          ) : null}

              <Button
                type="submit"
                size="xl"
                className="w-full"
                disabled={
                  pending ||
                  !searchDone ||
                  !signature ||
                  !sealsReady ||
                  cargoTypes.length === 0 ||
                  anyUnlisted ||
                  driverNameMismatch ||
                  !escortComplete ||
                  !hubDestinationReady
                }
              >
                {pending ? "Creating…" : "Create Transaction & Generate QR"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
