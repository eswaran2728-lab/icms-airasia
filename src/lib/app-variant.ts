import type { Role } from "./database.types";

/**
 * Lets the exact same codebase/Supabase project serve a second, cut-down
 * deployment for warehouse drivers and vendors only — set
 * NEXT_PUBLIC_APP_VARIANT=driver_vendor on that Vercel project's env vars
 * (leave unset, or "full", for the main ICMS deployment). This only
 * changes what the UI *offers* (nav items, registration role picker) —
 * every real authorization check (requireRole, RLS) is unchanged and
 * still enforced identically on both deployments, so this is a UX
 * convenience, not a security boundary.
 *
 * NEXT_PUBLIC_ (not a server-only var) because the registration form is
 * a client component and needs to read it too.
 */
export const APP_VARIANT = process.env.NEXT_PUBLIC_APP_VARIANT ?? "full";
export const isDriverVendorVariant = APP_VARIANT === "driver_vendor";

/** Roles the driver_vendor variant's registration form offers. */
export const DRIVER_VENDOR_ROLES: Role[] = ["warehouse_pic", "vendor"];
