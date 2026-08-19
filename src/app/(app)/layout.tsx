import Link from "next/link";
import {
  ClipboardList,
  LayoutDashboard,
  ListChecks,
  PackageCheck,
  PlusCircle,
  ScanLine,
  ShieldAlert,
  FileBarChart,
  Users,
  ScrollText,
  Archive,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import { requireProfile } from "@/lib/auth";
import { signOut } from "@/lib/actions/auth";
import { getLang } from "@/lib/actions/language";
import { isDriverVendorVariant } from "@/lib/app-variant";
import { LanguageToggle } from "@/components/language-toggle";
import { ROLE_COLORS, ROLE_LABELS } from "@/lib/constants";
import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationsBell } from "@/components/notifications-bell";
import { PwaProvider } from "@/components/pwa-provider";
import { InstallPrompt } from "@/components/install-prompt";
import { BrandMark } from "@/components/brand-mark";
import { AirAsiaMark } from "@/components/airasia-mark";
import { Button } from "@/components/ui/button";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireProfile();
  const lang = await getLang();

  const isPic = profile.role === "warehouse_pic";
  const isVendor = profile.role === "vendor";
  // warehouse_pic scans too now, for Vendor Movement Part C — not a
  // catering checkpoint of their own, but still needs the Scan nav item.
  // hub_avsec/redq_avsec scan for their own Multi-Route checkpoints.
  const canScan = [
    "post2_avsec",
    "post6_avsec",
    "receiver",
    "warehouse_pic",
    "hub_avsec",
    "redq_avsec",
  ].includes(profile.role);
  // Vendor Movement Module: vendor sees only its own deliveries (RLS),
  // warehouse_pic/post2_avsec/supervisor/enforcement see every delivery.
  const canSeeVendorList = [
    "vendor",
    "warehouse_pic",
    "post2_avsec",
    "supervisor",
    "enforcement",
  ].includes(profile.role);
  // The cut-down driver_vendor deployment (see src/lib/app-variant.ts)
  // drops the catering Transactions/Incidents views — neither role there
  // has any use for the wider catering oversight list.
  const showCateringNav = !isDriverVendorVariant;

  const nav = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, show: true },
    {
      href: "/transactions/new",
      label: "New",
      icon: PlusCircle,
      show: isPic,
    },
    {
      href: "/vendor-transactions/new",
      label: "New Delivery",
      icon: PlusCircle,
      show: isVendor,
    },
    {
      href: "/scan",
      label: "Scan",
      icon: ScanLine,
      show: canScan,
    },
    {
      href: "/vendor-transactions",
      label: "Vendor Deliveries",
      icon: PackageCheck,
      show: canSeeVendorList,
    },
    { href: "/transactions", label: "Transactions", icon: ClipboardList, show: showCateringNav },
    { href: "/incidents", label: "Incidents", icon: ShieldAlert, show: showCateringNav },
    {
      href: "/reports",
      label: "Reports",
      icon: FileBarChart,
      show: profile.role === "supervisor" || profile.role === "enforcement",
    },
    {
      href: "/admin/users",
      label: "Users",
      icon: Users,
      show: profile.role === "supervisor",
    },
    {
      href: "/admin/whitelists",
      label: "Whitelists",
      icon: ListChecks,
      show: profile.role === "supervisor",
    },
    {
      href: "/admin/audit",
      label: "Audit Log",
      icon: ScrollText,
      show: profile.role === "supervisor",
    },
    {
      href: "/admin/archive",
      label: "Archive",
      icon: Archive,
      show: profile.role === "supervisor",
    },
  ].filter((item) => item.show);

  // Bottom bar (phones/tablets): exactly the four per-role primary actions —
  // PIC: Dashboard/New/Transactions/Incidents; checkpoint roles: Dashboard/
  // Scan/Transactions/Incidents; vendor: Dashboard/New Delivery/Transactions/
  // Incidents; admin: oversight only (no create/scan).
  const bottomNav = nav.filter((item) =>
    [
      "/dashboard",
      "/transactions/new",
      "/vendor-transactions/new",
      "/scan",
      "/vendor-transactions",
      "/transactions",
      "/incidents",
    ].includes(item.href)
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur">
        <div className="h-0.5 bg-gradient-to-r from-brand via-primary to-brand" />
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-2 px-4">
          <Link href="/dashboard" className="flex items-center gap-2 font-heading font-bold">
            <BrandMark />
            <span className="hidden bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent sm:inline">
              ICMS
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <div className="hidden text-right text-xs sm:block">
              <p className="font-medium">{profile.name}</p>
              <p className="text-muted-foreground">{ROLE_LABELS[profile.role]}</p>
            </div>
            {/* Persistent role badge: makes it unambiguous which role is acting,
                especially AVSEC Post 2 vs Post 6 vs PIC/Receiver/Admin. */}
            <span
              className={`hidden items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium md:inline-flex ${ROLE_COLORS[profile.role]}`}
              title={`${ROLE_LABELS[profile.role]} · Staff ID ${profile.staff_id}`}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {ROLE_LABELS[profile.role]} · Staff ID{" "}
              <span className="font-mono">{profile.staff_id}</span>
            </span>
            <AirAsiaMark />
            <div className="hidden h-6 w-px bg-border sm:block" />
            <PwaProvider />
            <LanguageToggle lang={lang} />
            <NotificationsBell userId={profile.id} />
            <ThemeToggle />
            <form action={signOut}>
              <Button variant="ghost" size="icon" type="submit" aria-label="Sign out">
                <LogOut className="h-5 w-5" />
              </Button>
            </form>
          </div>
        </div>
      </header>

      <InstallPrompt />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-24 md:pb-6">{children}</main>

      {/* Bottom navigation for phones/tablets */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-card md:hidden print:hidden">
        <div className="grid auto-cols-fr grid-flow-col">
          {bottomNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={
                item.href === "/scan" || item.href === "/transactions/new"
                  ? "flex flex-col items-center gap-1 py-2.5 text-[11px] font-bold text-primary"
                  : "flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              }
            >
              <item.icon
                className={
                  item.href === "/scan" || item.href === "/transactions/new" ? "h-6 w-6" : "h-5 w-5"
                }
              />
              {item.label.split(" ")[0]}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
