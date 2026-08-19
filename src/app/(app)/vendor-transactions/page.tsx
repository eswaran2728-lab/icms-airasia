import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VENDOR_STATUS_COLORS, VENDOR_STATUS_LABELS } from "@/lib/constants";
import { formatDateTime } from "@/lib/utils";
import type { VendorTransaction, VendorTransactionStatus } from "@/lib/database.types";
import { vendorNextStepFor } from "@/lib/workflow-vendor";

export const metadata: Metadata = { title: "Vendor Deliveries" };
export const dynamic = "force-dynamic";

interface SearchParams {
  q?: string;
  status?: string;
  from?: string;
  to?: string;
}

export default async function VendorTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const profile = await requireProfile();
  const supabase = await createClient();

  // RLS already scopes this: a `vendor` account only ever sees its own
  // rows (created_by = auth.uid()); warehouse_pic/post2_avsec/supervisor/
  // enforcement see every delivery. No extra filtering needed here.
  let query = supabase
    .from("vendor_transactions")
    .select("*, vendor_part_a(driver_name, seal_number)")
    .order("created_at", { ascending: false })
    .limit(200);

  const q = params.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_(),]/g, "")}%`;
    query = query.ilike("transaction_number", like);
  }
  if (params.status && params.status in VENDOR_STATUS_LABELS) {
    query = query.eq("status", params.status as VendorTransactionStatus);
  }
  if (params.from) {
    query = query.gte("created_at", new Date(`${params.from}T00:00:00`).toISOString());
  }
  if (params.to) {
    query = query.lte("created_at", new Date(`${params.to}T23:59:59`).toISOString());
  }

  const { data } = await query;
  const transactions = ((data ?? []) as unknown as (VendorTransaction & {
    vendor_part_a: { driver_name: string; seal_number: string }[];
  })[]).sort((left, right) => {
    const rank = (transaction: VendorTransaction) => {
      const next = vendorNextStepFor(transaction.status);
      if (next?.role === profile.role) return 0;
      if (transaction.status !== "COMPLETED" && transaction.status !== "ESCALATED") return 1;
      if (transaction.status === "ESCALATED") return 2;
      return 3;
    };
    return rank(left) - rank(right) || Date.parse(right.created_at) - Date.parse(left.created_at);
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Vendor Deliveries</h1>
          <p className="text-sm text-muted-foreground">
            {profile.role === "vendor"
              ? "Your deliveries."
              : "Vendor Movement Module — AA/SEC/F/019."}
          </p>
        </div>
        {profile.role === "vendor" ? (
          <Link href="/vendor-transactions/new">
            <Button size="lg">+ New Delivery</Button>
          </Link>
        ) : null}
      </div>

      <Card>
        <CardContent className="pt-6">
          <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1 lg:col-span-1">
              <Label htmlFor="q">Search</Label>
              <Input id="q" name="q" defaultValue={params.q ?? ""} placeholder="Delivery no…" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="status">Status</Label>
              <Select id="status" name="status" defaultValue={params.status ?? ""}>
                <option value="">All statuses</option>
                {Object.entries(VENDOR_STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="from">From</Label>
              <Input id="from" name="from" type="date" defaultValue={params.from ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="to">To</Label>
              <Input id="to" name="to" type="date" defaultValue={params.to ?? ""} />
            </div>
            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
              <Button type="submit">Apply filters</Button>
              <Link href="/vendor-transactions">
                <Button variant="ghost" type="button">
                  Reset
                </Button>
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Delivery</TableHead>
              <TableHead>Driver</TableHead>
              <TableHead>Seal</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  No deliveries match your filters.
                </TableCell>
              </TableRow>
            ) : (
              transactions.map((t) => {
                const actionable = vendorNextStepFor(t.status)?.role === profile.role;
                const partA = t.vendor_part_a[0];
                return (
                  <TableRow
                    key={t.id}
                    className={
                      actionable ? "bg-primary/5 ring-1 ring-inset ring-primary/20" : undefined
                    }
                  >
                    <TableCell>
                      <Link
                        href={`/vendor-transactions/${t.id}`}
                        className="font-mono font-medium text-primary hover:underline"
                      >
                        {t.transaction_number}
                      </Link>
                      {actionable ? (
                        <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                          Your turn
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>{partA?.driver_name ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{partA?.seal_number ?? "—"}</TableCell>
                    <TableCell>
                      <Badge className={VENDOR_STATUS_COLORS[t.status]}>
                        {VENDOR_STATUS_LABELS[t.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(t.created_at)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
