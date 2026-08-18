import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock3, FileDown, LockKeyhole } from "lucide-react";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/storage";
import { generateQrToken } from "@/lib/qr-token";
import { QrDisplay } from "@/components/qr-display";
import { StatusBadge } from "@/components/status-badge";
import { DirectionBadge } from "@/components/direction-badge";
import { WorkflowStepper } from "@/components/workflow-stepper";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getStep, nextStepFor, type CheckpointPart } from "@/lib/workflow";
import { SegmentCountdown } from "@/components/segment-countdown";
import {
  CARGO_TYPE_LABELS,
  DELIVERY_LOCATION_LABELS,
  HUB_DESTINATION_LABELS,
  INCIDENT_TYPE_LABELS,
  ROUTE_LABELS,
} from "@/lib/constants";
import { formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  SEAL_COLOR_BADGES,
  SEAL_COLOR_LABELS,
  SEAL_TYPE_LABELS,
} from "@/lib/constants";
import type {
  Incident,
  PartA,
  PartBC,
  PartD,
  PartHub,
  PartRedq,
  Seal,
  SealVerification,
  SegmentTimeout,
  Transaction,
  Role,
} from "@/lib/database.types";

export const metadata: Metadata = { title: "Transaction" };
export const dynamic = "force-dynamic";

function Sig({ url, label }: { url: string | null; label: string }) {
  if (!url) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={label} className="h-20 rounded border bg-white object-contain" />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        ok
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
          : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
      }`}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      {label}
    </span>
  );
}

const ROLE_LABELS: Partial<Record<Role, string>> = {
  post2_avsec: "In-flight Security Post",
  post6_avsec: "Airport Security Post",
  receiver: "Receiver",
};

function PendingPartCard({
  id,
  title,
  part,
  currentPart,
  responsibleRole,
  viewerRole,
  deadline,
}: {
  id: string;
  title: string;
  part: CheckpointPart;
  currentPart: CheckpointPart | null;
  responsibleRole: Role;
  viewerRole: Role;
  /** SLA deadline for this segment (Upgrade 5), null when uncapped. */
  deadline?: string | null;
}) {
  const isCurrent = currentPart === part;
  const actionable = isCurrent && viewerRole === responsibleRole;
  const slug = part.replace("_", "-");

  return (
    <Card className={actionable ? "border-primary bg-primary/5" : "border-dashed"}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {actionable ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-primary">
                <Clock3 className="h-4 w-4" /> Your turn — ready to verify
              </div>
              {isCurrent ? <SegmentCountdown deadline={deadline ?? null} /> : null}
            </div>
            <Link href={`/transactions/${id}/${slug}`}>
              <Button className="w-full" size="lg">Scan / Verify</Button>
            </Link>
          </div>
        ) : isCurrent ? (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
              <Clock3 className="h-4 w-4" /> Awaiting {ROLE_LABELS[responsibleRole]}
            </div>
            <SegmentCountdown deadline={deadline ?? null} />
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LockKeyhole className="h-4 w-4" /> Locked — earlier checkpoint not completed
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default async function TransactionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; approved?: string; completed?: string; escalated?: string }>;
}) {
  const { id } = await params;
  const flags = await searchParams;
  const profile = await requireProfile();
  const supabase = await createClient();

  const { data: tx } = await supabase
    .from("transactions")
    .select("*, catering_companies(name)")
    .eq("id", id)
    .single();
  if (!tx) notFound();
  const transaction = tx as unknown as Transaction & {
    catering_companies: { name: string } | null;
  };

  const [a, b, c, d, hub, redq, inc, sealRes] = await Promise.all([
    supabase.from("part_a").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_b").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_c").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_d").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_hub").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_redq").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("incidents").select("*").eq("transaction_id", id).order("created_at"),
    supabase
      .from("seals")
      .select("*, seal_verifications(*)")
      .eq("transaction_id", id)
      .order("applied_at"),
  ]);

  const partA = a.data as PartA | null;
  const partB = b.data as PartBC | null;
  const partC = c.data as PartBC | null;
  const partD = d.data as PartD | null;
  const partHub = hub.data as PartHub | null;
  const partRedq = redq.data as PartRedq | null;
  const incidents = (inc.data ?? []) as Incident[];
  const seals = (sealRes.data ?? []) as unknown as (Seal & {
    seal_verifications: SealVerification[];
  })[];

  const [sigA, sigB, sigC, sigD, sigHub, sigRedq] = await Promise.all([
    signedUrl("signatures", partA?.signature_url ?? null),
    signedUrl("signatures", partB?.signature_url ?? null),
    signedUrl("signatures", partC?.signature_url ?? null),
    signedUrl("signatures", partD?.signature_url ?? null),
    signedUrl("signatures", partHub?.signature_url ?? null),
    signedUrl("signatures", partRedq?.signature_url ?? null),
  ]);
  const incidentPhotos = await Promise.all(
    incidents.map((i) => signedUrl("incident-photos", i.photo_url))
  );
  const completedFormUrl = await signedUrl("completed-forms", transaction.completed_form_url);

  // Which checkpoint can this user action right now? (direction- and route-aware)
  const nextStep = nextStepFor(transaction.direction, transaction.status, transaction.route);
  const nextAction =
    nextStep && profile.role === nextStep.role
      ? {
          href: `/transactions/${id}/${nextStep.slug}`,
          label: `Complete ${nextStep.shortLabel}`,
        }
      : null;
  const currentPart = nextStep?.part ?? null;

  // Segment SLA deadline (Upgrade 5) for whichever checkpoint is currently
  // pending — null when the transaction is done/escalated, or the segment
  // is uncapped (e.g. outbound Post 6 -> Receiver has no limit).
  let segmentDeadline: string | null = null;
  if (currentPart) {
    const { data: segmentTimeout } = await supabase
      .from("segment_timeouts")
      .select("limit_minutes")
      .eq("direction", transaction.direction)
      .eq("from_status", transaction.status)
      .maybeSingle();
    const limitMinutes = (segmentTimeout as Pick<SegmentTimeout, "limit_minutes"> | null)
      ?.limit_minutes;
    if (limitMinutes != null) {
      segmentDeadline = new Date(
        new Date(transaction.status_entered_at).getTime() + limitMinutes * 60_000
      ).toISOString();
    }
  }

  const suppliesSum =
    (transaction.supplies_total ?? 0) +
    (transaction.supplies_carts ?? 0) +
    (transaction.supplies_smu ?? 0) +
    (transaction.supplies_pallets ?? 0) +
    (transaction.supplies_boxes ?? 0) +
    (transaction.supplies_oven_racks ?? 0);

  // Part D is optional: the receiver or an admin can close the transaction
  // out from AIRPORT_POST_APPROVED without ever completing Part D.
  const canSkipPartD =
    transaction.direction === "OUTBOUND" &&
    transaction.status === "AIRPORT_POST_APPROVED" &&
    !partD &&
    (profile.role === "receiver" || profile.role === "supervisor");

  const banner = flags.created
    ? "Transaction created. Print or show the QR pass at Post 2."
    : flags.approved
      ? "Checkpoint recorded."
      : flags.completed
        ? transaction.part_d_skipped
          ? "Transaction completed without Part D."
          : "Delivery confirmed — transaction completed."
        : flags.escalated
          ? "Incident reported. Transaction escalated and admin notified."
          : null;

  return (
    <div className="space-y-4">
      {banner ? (
        <p
          className={`rounded-md p-3 text-sm font-medium ${
            flags.escalated
              ? "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200"
              : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
          }`}
        >
          {banner}
        </p>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-bold tracking-tight">
            {transaction.transaction_number}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusBadge status={transaction.status} />
            <DirectionBadge direction={transaction.direction} />
            {segmentDeadline ? <SegmentCountdown deadline={segmentDeadline} /> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {nextAction ? (
            <Link href={nextAction.href}>
              <Button size="lg">{nextAction.label}</Button>
            </Link>
          ) : null}
          {canSkipPartD ? (
            <Link href={`/transactions/${id}/skip-part-d`}>
              <Button size="lg" variant="secondary">
                Complete without Part D
              </Button>
            </Link>
          ) : null}
          {completedFormUrl ? (
            <a href={completedFormUrl} target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="secondary">
                <FileDown className="mr-1 h-4 w-4" />
                Completed Form (PDF)
              </Button>
            </a>
          ) : null}
          {transaction.status !== "COMPLETED" ||
          profile.role === "supervisor" ||
          profile.role === "enforcement" ? (
            <Link href={`/transactions/${id}/incident`}>
              <Button variant="destructive" size="lg">
                Report Incident
              </Button>
            </Link>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Consignment</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {transaction.station ? (
              <Row label="Station" value={<span className="font-mono">{transaction.station}</span>} />
            ) : null}
            {transaction.route !== "AIRCRAFT" ? (
              <Row
                label="Route"
                value={
                  transaction.route === "HUB" && transaction.hub_destination
                    ? `Hub — ${HUB_DESTINATION_LABELS[transaction.hub_destination]}`
                    : ROUTE_LABELS[transaction.route]
                }
              />
            ) : null}
            <Row label="Vehicle" value={<span className="font-mono">{transaction.vehicle_number}</span>} />
            <Row label="Driver" value={transaction.driver_name} />
            <Row label="Driver ID" value={<span className="font-mono">{transaction.driver_id}</span>} />
            {transaction.flight_number ? (
              <Row label="Flight" value={<span className="font-mono">{transaction.flight_number}</span>} />
            ) : null}
            {transaction.aircraft_registration ? (
              <Row
                label="Aircraft"
                value={<span className="font-mono">{transaction.aircraft_registration}</span>}
              />
            ) : null}
            {transaction.catering_companies ? (
              <Row label="Catering Company" value={transaction.catering_companies.name} />
            ) : null}
            {transaction.trolley_count > 0 ? (
              <Row label="Trolleys" value={transaction.trolley_count} />
            ) : null}
            {transaction.cargo_types.length > 0 ? (
              <Row
                label="Cargo Type"
                value={
                  <span className="flex flex-wrap justify-end gap-1">
                    {transaction.cargo_types.map((c) => (
                      <Badge key={c} className="border bg-muted text-muted-foreground">
                        {CARGO_TYPE_LABELS[c]}
                      </Badge>
                    ))}
                  </span>
                }
              />
            ) : null}
            {suppliesSum > 0 ? (
              <Row
                label="In-flight Supplies"
                value={
                  <span className="font-mono">
                    {transaction.supplies_total ?? suppliesSum} total
                    {" — "}
                    {[
                      transaction.supplies_carts ? `${transaction.supplies_carts} carts` : null,
                      transaction.supplies_smu ? `${transaction.supplies_smu} SMU` : null,
                      transaction.supplies_pallets ? `${transaction.supplies_pallets} pallets` : null,
                      transaction.supplies_boxes ? `${transaction.supplies_boxes} boxes` : null,
                      transaction.supplies_oven_racks
                        ? `${transaction.supplies_oven_racks} oven rack`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </span>
                }
              />
            ) : null}
            {transaction.escort_officer_name ? (
              <Row
                label="Escort Officer"
                value={`${transaction.escort_officer_name}${transaction.escort_officer_staff_id ? ` (${transaction.escort_officer_staff_id})` : ""}`}
              />
            ) : null}
            {transaction.escort_vehicle_number ? (
              <Row
                label="Escort Vehicle"
                value={<span className="font-mono">{transaction.escort_vehicle_number}</span>}
              />
            ) : null}
            <Row label="Created" value={formatDateTime(transaction.created_at)} />
            <Row label="Completed" value={formatDateTime(transaction.completed_at)} />
            <div className="space-y-2 pt-2">
              <p className="text-sm text-muted-foreground">Seals ({seals.length})</p>
              {seals.map((seal) => (
                <div key={seal.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge className={SEAL_COLOR_BADGES[seal.seal_color]}>
                    {SEAL_COLOR_LABELS[seal.seal_color]} {SEAL_TYPE_LABELS[seal.seal_type]}
                  </Badge>
                  <span className="font-mono font-medium">{seal.seal_number}</span>
                  {seal.superseded_at ? (
                    <span
                      className="text-xs font-semibold text-muted-foreground"
                      title={`Superseded ${formatDateTime(seal.superseded_at)}${seal.superseded_reason ? ` — ${seal.superseded_reason}` : ""}`}
                    >
                      Superseded {formatDateTime(seal.superseded_at)}
                    </span>
                  ) : null}
                  {seal.seal_verifications.length > 0 ? (
                    <span
                      className={`text-xs ${
                        seal.seal_verifications.every((v) => v.matched)
                          ? "text-emerald-600"
                          : "font-semibold text-red-600"
                      }`}
                    >
                      {seal.seal_verifications.filter((v) => v.matched).length}/
                      {seal.seal_verifications.length} checks matched
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">not yet verified</span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">QR Pass</CardTitle>
          </CardHeader>
          <CardContent>
            <QrDisplay
              token={generateQrToken(transaction.id)}
              transactionNumber={transaction.transaction_number}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Workflow Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <WorkflowStepper
              direction={transaction.direction}
              status={transaction.status}
              route={transaction.route}
              parts={{
                part_b: !!partB,
                part_c: !!partC,
                part_d: !!partD || transaction.part_d_skipped,
                part_hub: !!partHub,
                part_redq: !!partRedq,
              }}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {partA ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Part A — Warehouse PIC</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label="PIC" value={`${partA.pic_name} (${partA.pic_staff_id})`} />
              <Row label="Completed" value={formatDateTime(partA.completed_at)} />
              <div className="flex flex-wrap gap-2">
                <Check ok={partA.vehicle_search_completed} label="Vehicle search" />
              </div>
              {partA.remarks ? <p className="text-sm text-muted-foreground">“{partA.remarks}”</p> : null}
              <Sig url={sigA} label="PIC signature" />
            </CardContent>
          </Card>
        ) : null}

        {partB ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Part B — AVSEC Post 2</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label="Officer" value={`${partB.avsec_name} (${partB.avsec_staff_id})`} />
              <Row label="Completed" value={formatDateTime(partB.completed_at)} />
              <div className="flex flex-wrap gap-2">
                <Check ok={partB.vehicle_verified} label="Vehicle" />
                <Check ok={partB.driver_verified} label="Driver" />
                <Check ok={partB.seal_verified} label="Seal" />
              </div>
              {partB.remarks ? <p className="text-sm text-muted-foreground">“{partB.remarks}”</p> : null}
              <Sig url={sigB} label="Officer signature" />
            </CardContent>
          </Card>
        ) : (
          <PendingPartCard
            id={id}
            title="Part B — AVSEC Post 2"
            part="part_b"
            currentPart={currentPart}
            responsibleRole={
              getStep(transaction.direction, "part_b", transaction.route)?.role ?? "post2_avsec"
            }
            viewerRole={profile.role}
            deadline={segmentDeadline}
          />
        )}

        {transaction.route === "HUB" ? (
          partHub ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Part Hub — Delivery Confirmation</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Row
                  label="Hub AVSEC"
                  value={`${partHub.hub_avsec_name} (${partHub.hub_avsec_staff_id})`}
                />
                <Row
                  label="Confirmed Destination"
                  value={HUB_DESTINATION_LABELS[partHub.confirmed_destination]}
                />
                <Row label="Completed" value={formatDateTime(partHub.completed_at)} />
                {partHub.remarks ? (
                  <p className="text-sm text-muted-foreground">“{partHub.remarks}”</p>
                ) : null}
                <Sig url={sigHub} label="Hub AVSEC signature" />
              </CardContent>
            </Card>
          ) : (
            <PendingPartCard
              id={id}
              title="Part Hub — Delivery Confirmation"
              part="part_hub"
              currentPart={currentPart}
              responsibleRole="hub_avsec"
              viewerRole={profile.role}
              deadline={segmentDeadline}
            />
          )
        ) : (
          <>
            {transaction.route === "REDQ" ? (
              partRedq ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Part REDQ — Re-seal</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Row
                      label="REDQ AVSEC"
                      value={`${partRedq.redq_avsec_name} (${partRedq.redq_avsec_staff_id})`}
                    />
                    <Row label="Completed" value={formatDateTime(partRedq.completed_at)} />
                    {partRedq.remarks ? (
                      <p className="text-sm text-muted-foreground">“{partRedq.remarks}”</p>
                    ) : null}
                    <Sig url={sigRedq} label="REDQ AVSEC signature" />
                  </CardContent>
                </Card>
              ) : (
                <PendingPartCard
                  id={id}
                  title="Part REDQ — Re-seal"
                  part="part_redq"
                  currentPart={currentPart}
                  responsibleRole="redq_avsec"
                  viewerRole={profile.role}
                  deadline={segmentDeadline}
                />
              )
            ) : null}

            {partC ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Part C — AVSEC Post 6</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Row label="Officer" value={`${partC.avsec_name} (${partC.avsec_staff_id})`} />
                  <Row label="Completed" value={formatDateTime(partC.completed_at)} />
                  <div className="flex flex-wrap gap-2">
                    <Check ok={partC.vehicle_verified} label="Vehicle" />
                    <Check ok={partC.driver_verified} label="Driver" />
                    <Check ok={partC.seal_verified} label="Seal" />
                  </div>
                  {partC.remarks ? (
                    <p className="text-sm text-muted-foreground">“{partC.remarks}”</p>
                  ) : null}
                  <Sig url={sigC} label="Officer signature" />
                </CardContent>
              </Card>
            ) : (
              <PendingPartCard
                id={id}
                title="Part C — AVSEC Post 6"
                part="part_c"
                currentPart={currentPart}
                responsibleRole={
                  getStep(transaction.direction, "part_c", transaction.route)?.role ?? "post6_avsec"
                }
                viewerRole={profile.role}
                deadline={segmentDeadline}
              />
            )}
          </>
        )}

        {partD ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Part D — Delivery</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row
                label="Receiver"
                value={`${partD.receiver_name} (${partD.receiver_staff_id})`}
              />
              <Row label="Location" value={DELIVERY_LOCATION_LABELS[partD.delivery_location]} />
              {partD.aircraft_identifier ? (
                <Row label="Aircraft Identifier" value={<span className="font-mono">{partD.aircraft_identifier}</span>} />
              ) : null}
              <Row label="Completed" value={formatDateTime(partD.completed_at)} />
              <div className="flex flex-wrap gap-2">
                <Check ok={partD.seal_intact} label="Seal intact" />
              </div>
              {partD.remarks ? <p className="text-sm text-muted-foreground">“{partD.remarks}”</p> : null}
              <Sig url={sigD} label="Receiver signature" />
            </CardContent>
          </Card>
        ) : transaction.part_d_skipped ? (
          <Card className="border-dashed">
            <CardHeader>
              <CardTitle className="text-base">Part D — Delivery</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="font-medium text-muted-foreground">
                Skipped — transaction completed without Part D.
              </p>
              {transaction.part_d_skip_reason ? (
                <p className="text-muted-foreground">“{transaction.part_d_skip_reason}”</p>
              ) : null}
            </CardContent>
          </Card>
        ) : transaction.direction === "OUTBOUND" &&
          transaction.route !== "HUB" &&
          transaction.route !== "MAINTENANCE" ? (
          <PendingPartCard
            id={id}
            title="Part D — Delivery"
            part="part_d"
            currentPart={currentPart}
            responsibleRole="receiver"
            viewerRole={profile.role}
          />
        ) : profile.role === "supervisor" || profile.role === "enforcement" ? (
          <Card className="border-dashed">
            <CardHeader><CardTitle className="text-base">Part D — Delivery</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {transaction.route === "HUB"
                ? "Not applicable to HUB-route transactions — Part Hub is the terminal step."
                : transaction.route === "MAINTENANCE"
                  ? "Not applicable — GSE Workshop has no security checkpoint; this transaction completed at Part C."
                  : "Not applicable to inbound transactions."}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {incidents.length > 0 ? (
        <Card className="border-red-300 dark:border-red-900">
          <CardHeader>
            <CardTitle className="text-base text-red-700 dark:text-red-300">
              Incidents ({incidents.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {incidents.map((incident, i) => (
              <div key={incident.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    {INCIDENT_TYPE_LABELS[incident.incident_type]}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(incident.created_at)} · {incident.reported_by}
                  </span>
                </div>
                <p className="mt-1 text-sm">{incident.description}</p>
                {incidentPhotos[i] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={incidentPhotos[i]!}
                    alt="Incident evidence"
                    className="mt-2 max-h-56 rounded border object-contain"
                  />
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
