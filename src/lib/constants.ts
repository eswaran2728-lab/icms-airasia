import type {
  CargoType,
  DeliveryLocation,
  Direction,
  HubDestination,
  IncidentStatus,
  IncidentType,
  Role,
  SealColor,
  SealType,
  TransactionRoute,
  TransactionStatus,
  VendorTransactionStatus,
} from "./database.types";

export const ROLE_LABELS: Record<Role, string> = {
  // Covers both the in-flight catering warehouse and the SRA warehouse —
  // the direction is chosen per transaction, not implied by the role.
  warehouse_pic: "Warehouse PIC",
  post2_avsec: "AVSEC In-flight Post (Post 2)",
  post6_avsec: "AVSEC Airport Post (Post 6)",
  receiver: "SRA / Aircraft Receiver",
  // Internal DB role value stays 'supervisor' (RLS, policies, seed data all
  // key off it) — only the user-facing label changes to "Admin".
  supervisor: "Admin",
  // Full read visibility + incident lifecycle power, same as supervisor,
  // but no whitelist/user/archive admin access and no checkpoint actions.
  enforcement: "Enforcement",
  // Vendor Movement Module (AA/SEC/F/019) — external vendor driver, own
  // separate workflow from the catering IFCSF one above.
  vendor: "Vendor",
  // Multi-Route Restructure (Hub & REDQ) — confirms delivery for HUB-route
  // transactions, the terminal step (no Part C/D).
  hub_avsec: "Hub AVSEC",
  // Performs the re-seal event for REDQ-route transactions.
  redq_avsec: "REDQ AVSEC",
};

/** Distinct color per role for the persistent header badge (AVSEC role identification). */
export const ROLE_COLORS: Record<Role, string> = {
  warehouse_pic: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200",
  post2_avsec: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
  post6_avsec: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-200",
  receiver: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200",
  supervisor: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  enforcement: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200",
  vendor: "bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-200",
  hub_avsec: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  redq_avsec: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
};

export const STATUS_LABELS: Record<TransactionStatus, string> = {
  CREATED: "Created — awaiting checkpoint",
  INFLIGHT_POST_APPROVED: "In-flight Post approved",
  AIRPORT_POST_APPROVED: "Airport Post approved",
  REDQ_RESEALED: "Re-sealed at REDQ — awaiting Airport Post",
  COMPLETED: "Completed",
  ESCALATED: "Escalated",
};

export const STATUS_COLORS: Record<TransactionStatus, string> = {
  CREATED: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  INFLIGHT_POST_APPROVED: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  AIRPORT_POST_APPROVED: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
  REDQ_RESEALED: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  COMPLETED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  // Amber/orange, not red, so escalated status stays visually distinct
  // from the app's red primary brand color.
  ESCALATED: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
};

/** Outbound-only routing chosen at Part A. INBOUND is always AIRCRAFT. */
export const ROUTE_LABELS: Record<TransactionRoute, string> = {
  AIRCRAFT: "Aircraft (standard)",
  HUB: "Hub",
  REDQ: "REDQ → FOB",
  MAINTENANCE: "GSE Workshop (Maintenance)",
};

/** Hub destinations only — REDQ is a route, not a Hub destination. */
export const HUB_DESTINATION_LABELS: Record<HubDestination, string> = {
  PEN: "Penang (PEN)",
  JHB: "Johor Bahru (JHB)",
  NILAI: "Nilai",
};

export const DIRECTION_LABELS: Record<Direction, string> = {
  OUTBOUND: "Outbound — Departure",
  INBOUND: "Inbound — Arrival",
};

/** Matches the physical truck seal colors: blue outbound, green inbound. */
export const DIRECTION_COLORS: Record<Direction, string> = {
  OUTBOUND: "bg-blue-600 text-white dark:bg-blue-500",
  INBOUND: "bg-green-600 text-white dark:bg-green-500",
};

export const DELIVERY_LOCATION_LABELS: Record<DeliveryLocation, string> = {
  SRA_WAREHOUSE: "SRA Warehouse",
  AIRCRAFT: "Aircraft",
};

/** IFCSF (AA/SEC/F/010 Rev.01) cargo-type checklist, Part A header. */
export const CARGO_TYPE_LABELS: Record<CargoType, string> = {
  FOOD_BEVERAGE: "Food & Beverage",
  PERISHABLE: "Perishable",
  DUTY_FREE: "Duty Free",
  MERCHANDISE: "Merchandise",
  VEHICLE_MAINTENANCE: "Vehicle Maintenance",
};

export const CARGO_TYPES: CargoType[] = [
  "FOOD_BEVERAGE",
  "PERISHABLE",
  "DUTY_FREE",
  "MERCHANDISE",
  "VEHICLE_MAINTENANCE",
];

export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  BROKEN_SEAL: "Broken Seal",
  SEAL_MISMATCH: "Seal Mismatch",
  UNAUTHORIZED_DRIVER: "Unauthorized Driver",
  UNAUTHORIZED_VEHICLE: "Unauthorized Vehicle",
  EXPIRED_PASS: "Expired Airport Pass",
  WRONG_SEAL_COLOR: "Wrong Seal Color",
  TIMEOUT: "Transaction Timeout",
  OTHER: "Other",
  WHITELIST_VIOLATION: "Whitelist Violation",
  SEGMENT_TIMEOUT: "Segment Timeout",
};

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  OPEN: "Open",
  UNDER_REVIEW: "Under Review",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

/** Full 4-stage lifecycle for every incident type except SEGMENT_TIMEOUT. */
export const INCIDENT_LIFECYCLE: IncidentStatus[] = ["OPEN", "UNDER_REVIEW", "RESOLVED", "CLOSED"];
/** Lighter lifecycle for SEGMENT_TIMEOUT (low-severity traffic-delay noise):
 *  OPEN -> RESOLVED in one step, no forced UNDER_REVIEW/CLOSED. */
export const INCIDENT_LIFECYCLE_LIGHT: IncidentStatus[] = ["OPEN", "RESOLVED"];

/** Which lifecycle stages an incident may move through, keyed off its type. */
export function lifecycleFor(incidentType: IncidentType): IncidentStatus[] {
  return incidentType === "SEGMENT_TIMEOUT" ? INCIDENT_LIFECYCLE_LIGHT : INCIDENT_LIFECYCLE;
}

export const INCIDENT_STATUS_COLORS: Record<IncidentStatus, string> = {
  OPEN: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  UNDER_REVIEW: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  RESOLVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  CLOSED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

export const SEAL_TYPE_LABELS: Record<SealType, string> = {
  TRUCK_SEAL: "Truck Seal",
  TROLLEY: "Trolley Seal",
  OTHER: "Other",
};

export const SEAL_COLOR_LABELS: Record<SealColor, string> = {
  BLUE: "Blue",
  GREEN: "Green",
  OTHER: "Other",
};

export const SEAL_COLOR_BADGES: Record<SealColor, string> = {
  BLUE: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  GREEN: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  OTHER: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
};

/**
 * Checkpoint seal-colour picker options. Seal colour is a manual choice at
 * every checkpoint (Part A and every verification screen) — the officer
 * picks Blue or Green every time; nothing is pre-selected or inferred from
 * direction.
 */
export const CHECKPOINT_SEAL_COLORS: Extract<SealColor, "BLUE" | "GREEN">[] = ["BLUE", "GREEN"];

export const ALL_ROLES: Role[] = [
  "warehouse_pic",
  "post2_avsec",
  "post6_avsec",
  "receiver",
  "supervisor",
  "enforcement",
  "vendor",
  "hub_avsec",
  "redq_avsec",
];

export const VENDOR_STATUS_LABELS: Record<VendorTransactionStatus, string> = {
  CREATED: "Created — awaiting Post 2",
  SECURITY_VERIFIED: "Post 2 approved — awaiting warehouse",
  PART_C_PARTIAL: "Part C in progress — one signature pending",
  COMPLETED: "Completed",
  ESCALATED: "Escalated",
};

export const VENDOR_STATUS_COLORS: Record<VendorTransactionStatus, string> = {
  CREATED: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  SECURITY_VERIFIED: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  PART_C_PARTIAL: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
  COMPLETED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  ESCALATED: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
};
