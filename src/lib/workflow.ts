import type { Direction, Role, TransactionRoute, TransactionStatus } from "./database.types";

/**
 * Single source of truth for the direction- and route-aware checkpoint
 * sequence. Mirrored in the database by enforce_part_sequence() /
 * enforce_part_hub_sequence() / enforce_part_redq_sequence()
 * (supabase/migrations/20260817000002_multiroute_redq_restructure.sql).
 *
 * INBOUND (arrival, GREEN seal): route is always AIRCRAFT — Hub/REDQ are
 * never valid inbound — sequence is unchanged from before this restructure:
 *   A -> C (Airport Post) -> B (In-flight Post, FINAL)
 *
 * OUTBOUND (departure, BLUE seal) branches by route, chosen at Part A:
 *   AIRCRAFT (default, unchanged): A -> B -> C -> D
 *   HUB:  A -> B -> Part Hub (terminal — no C/D)
 *   REDQ: A -> B -> Part REDQ (re-seal) -> C -> D
 *   MAINTENANCE: A -> B -> C (terminal — no D). Auto-derived (never chosen
 *     directly) from AIRCRAFT + the "Vehicle Maintenance" cargo type — the
 *     final destination (GSE Workshop) has no security checkpoint and the
 *     maintenance duration is unknown up front, so Part C finalizes the
 *     transaction instead of waiting on a Part D that can never happen.
 */

export type CheckpointPart = "part_b" | "part_c" | "part_d" | "part_hub" | "part_redq";

export interface CheckpointStep {
  part: CheckpointPart;
  /** URL segment under /transactions/[id]/ */
  slug: string;
  label: string;
  shortLabel: string;
  role: Role;
  requiredStatus: TransactionStatus;
  nextStatus: TransactionStatus;
  /** Completing this step completes the whole transaction. */
  finalizes: boolean;
}

const PART_B_LABEL = "Part B — In-flight Security Post (Post 2)";
const PART_C_LABEL = "Part C — Airport Security Post (Post 6)";
const PART_D_LABEL = "Part D — Delivery (SRA Warehouse / Aircraft)";
const PART_HUB_LABEL = "Part Hub — Hub Delivery Confirmation";
const PART_REDQ_LABEL = "Part REDQ — Re-seal";

const OUTBOUND_PART_B: CheckpointStep = {
  part: "part_b",
  slug: "part-b",
  label: PART_B_LABEL,
  shortLabel: "B · In-flight Post",
  role: "post2_avsec",
  requiredStatus: "CREATED",
  nextStatus: "INFLIGHT_POST_APPROVED",
  finalizes: false,
};

const INBOUND_WORKFLOW: CheckpointStep[] = [
  {
    part: "part_c",
    slug: "part-c",
    label: PART_C_LABEL,
    shortLabel: "C · Airport Post",
    role: "post6_avsec",
    requiredStatus: "CREATED",
    nextStatus: "AIRPORT_POST_APPROVED",
    finalizes: false,
  },
  {
    part: "part_b",
    slug: "part-b",
    label: `${PART_B_LABEL} — final`,
    shortLabel: "B · In-flight Post (final)",
    role: "post2_avsec",
    requiredStatus: "AIRPORT_POST_APPROVED",
    nextStatus: "COMPLETED",
    finalizes: true,
  },
];

const AIRCRAFT_ROUTE_WORKFLOW: CheckpointStep[] = [
  OUTBOUND_PART_B,
  {
    part: "part_c",
    slug: "part-c",
    label: PART_C_LABEL,
    shortLabel: "C · Airport Post",
    role: "post6_avsec",
    requiredStatus: "INFLIGHT_POST_APPROVED",
    nextStatus: "AIRPORT_POST_APPROVED",
    finalizes: false,
  },
  {
    part: "part_d",
    slug: "part-d",
    label: PART_D_LABEL,
    shortLabel: "D · Delivery",
    role: "receiver",
    requiredStatus: "AIRPORT_POST_APPROVED",
    nextStatus: "COMPLETED",
    finalizes: true,
  },
];

const HUB_ROUTE_WORKFLOW: CheckpointStep[] = [
  OUTBOUND_PART_B,
  {
    part: "part_hub",
    slug: "part-hub",
    label: PART_HUB_LABEL,
    shortLabel: "Hub · Delivery",
    role: "hub_avsec",
    requiredStatus: "INFLIGHT_POST_APPROVED",
    nextStatus: "COMPLETED",
    finalizes: true,
  },
];

const MAINTENANCE_ROUTE_WORKFLOW: CheckpointStep[] = [
  OUTBOUND_PART_B,
  {
    part: "part_c",
    slug: "part-c",
    label: `${PART_C_LABEL} — final; GSE Workshop maintenance has no separate checkpoint`,
    shortLabel: "C · Airport Post (final)",
    role: "post6_avsec",
    requiredStatus: "INFLIGHT_POST_APPROVED",
    nextStatus: "COMPLETED",
    finalizes: true,
  },
];

const REDQ_ROUTE_WORKFLOW: CheckpointStep[] = [
  OUTBOUND_PART_B,
  {
    part: "part_redq",
    slug: "part-redq",
    label: PART_REDQ_LABEL,
    shortLabel: "REDQ · Re-seal",
    role: "redq_avsec",
    requiredStatus: "INFLIGHT_POST_APPROVED",
    nextStatus: "REDQ_RESEALED",
    finalizes: false,
  },
  {
    part: "part_c",
    slug: "part-c",
    label: PART_C_LABEL,
    shortLabel: "C · Airport Post",
    role: "post6_avsec",
    requiredStatus: "REDQ_RESEALED",
    nextStatus: "AIRPORT_POST_APPROVED",
    finalizes: false,
  },
  {
    part: "part_d",
    slug: "part-d",
    label: PART_D_LABEL,
    shortLabel: "D · Delivery",
    role: "receiver",
    requiredStatus: "AIRPORT_POST_APPROVED",
    nextStatus: "COMPLETED",
    finalizes: true,
  },
];

/**
 * The ordered checkpoint sequence for a given direction + route. Route is
 * ignored for INBOUND (always effectively AIRCRAFT — Hub/REDQ are
 * outbound-only, enforced at Part A). Defaults route to "AIRCRAFT" so any
 * call site that doesn't pass it yet keeps today's exact behavior.
 */
export function stepsFor(
  direction: Direction,
  route: TransactionRoute = "AIRCRAFT"
): CheckpointStep[] {
  if (direction === "INBOUND") return INBOUND_WORKFLOW;
  if (route === "HUB") return HUB_ROUTE_WORKFLOW;
  if (route === "REDQ") return REDQ_ROUTE_WORKFLOW;
  if (route === "MAINTENANCE") return MAINTENANCE_ROUTE_WORKFLOW;
  return AIRCRAFT_ROUTE_WORKFLOW;
}

export function getStep(
  direction: Direction,
  part: CheckpointPart,
  route: TransactionRoute = "AIRCRAFT"
): CheckpointStep | null {
  return stepsFor(direction, route).find((s) => s.part === part) ?? null;
}

/** The next checkpoint a transaction is waiting on, or null when finished/escalated. */
export function nextStepFor(
  direction: Direction,
  status: TransactionStatus,
  route: TransactionRoute = "AIRCRAFT"
): CheckpointStep | null {
  if (status === "COMPLETED" || status === "ESCALATED") return null;
  return stepsFor(direction, route).find((s) => s.requiredStatus === status) ?? null;
}

/**
 * Derive which checkpoint parts are already done purely from the status
 * (used on checkpoint screens that don't load the part records).
 * ESCALATED yields all-false; the stepper shows the escalation alert instead.
 */
export function partsDoneFromStatus(
  direction: Direction,
  status: TransactionStatus,
  route: TransactionRoute = "AIRCRAFT"
): Record<CheckpointPart, boolean> {
  const done: Record<CheckpointPart, boolean> = {
    part_b: false,
    part_c: false,
    part_d: false,
    part_hub: false,
    part_redq: false,
  };
  const steps = stepsFor(direction, route);
  const progression: TransactionStatus[] = ["CREATED", ...steps.map((s) => s.nextStatus)];
  const idx = progression.indexOf(status);
  steps.forEach((step, i) => {
    if (idx > i) done[step.part] = true;
  });
  return done;
}

/**
 * Human-readable out-of-order error (English + Bahasa Melayu),
 * or null when the checkpoint may proceed.
 */
export function checkpointOrderError(
  direction: Direction,
  part: CheckpointPart,
  status: TransactionStatus,
  route: TransactionRoute = "AIRCRAFT"
): string | null {
  const step = getStep(direction, part, route);
  const dirEn = direction === "OUTBOUND" ? "outbound" : "inbound";
  const dirBm = direction === "OUTBOUND" ? "keluar" : "masuk";

  if (!step) {
    const notApplicable: Record<string, string> = {
      part_d: `${PART_D_LABEL} does not apply to inbound transactions, to HUB-route outbound transactions (Part Hub is the terminal step), or to MAINTENANCE-route outbound transactions (Part C is the terminal step). / Bahagian D tidak terpakai.`,
      part_c: `${PART_C_LABEL} does not apply to HUB-route transactions. / Bahagian C tidak terpakai untuk laluan HUB.`,
      part_hub: `${PART_HUB_LABEL} only applies to HUB-route outbound transactions. / Bahagian Hub hanya terpakai untuk transaksi HUB.`,
      part_redq: `${PART_REDQ_LABEL} only applies to REDQ-route outbound transactions. / Bahagian REDQ hanya terpakai untuk transaksi REDQ.`,
    };
    return notApplicable[part] ?? "This checkpoint does not apply to this transaction.";
  }
  if (status === "ESCALATED") {
    return (
      "This transaction is escalated; checkpoint processing is suspended pending admin review. " +
      "/ Transaksi ini telah dieskalasi; pemprosesan digantung sehingga semakan admin."
    );
  }
  if (status !== step.requiredStatus) {
    return (
      `Out of order: ${step.label} requires status ${step.requiredStatus}, but this ${dirEn} transaction is ${status}. ` +
      `/ Tidak mengikut urutan: ${step.label} memerlukan status ${step.requiredStatus}, tetapi transaksi ${dirBm} ini berstatus ${status}.`
    );
  }
  return null;
}
