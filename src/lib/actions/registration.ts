"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { DRIVER_VENDOR_ROLES, isDriverVendorVariant } from "@/lib/app-variant";
import type { Role } from "@/lib/database.types";

export interface RegisterState {
  error: string | null;
  success: string | null;
}

const ALL_REGISTERABLE_ROLES: Role[] = [
  "warehouse_pic",
  "post2_avsec",
  "post6_avsec",
  "receiver",
  "enforcement",
  "vendor",
  "hub_avsec",
  "redq_avsec",
];

// Re-validated server-side, the same way the client-side picker in
// register-form.tsx is narrowed — the driver_vendor deployment (see
// src/lib/app-variant.ts) must not let anyone actually register outside
// its two roles even if they bypass the form.
const REGISTERABLE_ROLES: Role[] = isDriverVendorVariant
  ? DRIVER_VENDOR_ROLES
  : ALL_REGISTERABLE_ROLES;

/**
 * Public: new staff self-registration. Creates a real Supabase Auth
 * account right away (so credentials live only in Supabase Auth, never
 * a second password store) but the profile is inserted with
 * status='pending', which blocks sign-in until an admin approves it
 * (enforced in signIn, src/lib/actions/auth.ts).
 */
export async function registerStaff(
  _prev: RegisterState,
  formData: FormData
): Promise<RegisterState> {
  const name = String(formData.get("name") ?? "").trim();
  const staffId = String(formData.get("staff_id") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "") as Role;
  const password = String(formData.get("password") ?? "");

  if (!name || !staffId || !email) {
    return { error: "Name, staff ID and email are required.", success: null };
  }
  if (!REGISTERABLE_ROLES.includes(role)) {
    return { error: "Select a valid checkpoint.", success: null };
  }
  if (password.length < 10) {
    return { error: "Password must be at least 10 characters.", success: null };
  }

  const admin = createAdminClient();

  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authError || !created.user) {
    return { error: authError?.message ?? "Could not create account.", success: null };
  }

  const { error: profileError } = await admin.from("users").insert({
    id: created.user.id,
    name,
    staff_id: staffId,
    email,
    role,
    status: "pending",
  });

  if (profileError) {
    await admin.auth.admin.deleteUser(created.user.id);
    return { error: `Registration could not be saved: ${profileError.message}`, success: null };
  }

  return {
    error: null,
    success: "Registration submitted. An admin must approve your account before you can sign in.",
  };
}

export interface ApprovalState {
  error: string | null;
}

/** Admin approves a pending registration — flips status to active. */
export async function approveStaff(
  _prev: ApprovalState,
  formData: FormData
): Promise<ApprovalState> {
  await requireRole(["supervisor"]);
  const userId = String(formData.get("user_id") ?? "");
  if (!userId) return { error: "Missing account reference." };

  const admin = createAdminClient();
  const { error } = await admin.from("users").update({ status: "active" }).eq("id", userId);
  if (error) return { error: error.message };

  revalidatePath("/admin/users");
  return { error: null };
}

/**
 * Admin rejects a pending registration. The account is kept for history
 * (never deleted) and stays permanently blocked from sign-in.
 */
export async function rejectStaff(
  _prev: ApprovalState,
  formData: FormData
): Promise<ApprovalState> {
  await requireRole(["supervisor"]);
  const userId = String(formData.get("user_id") ?? "");
  if (!userId) return { error: "Missing account reference." };

  const admin = createAdminClient();
  const { error } = await admin.from("users").update({ status: "rejected" }).eq("id", userId);
  if (error) return { error: error.message };

  revalidatePath("/admin/users");
  return { error: null };
}
