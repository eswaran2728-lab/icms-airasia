export type Role =
  | "warehouse_pic"
  | "post2_avsec"
  | "post6_avsec"
  | "receiver"
  | "supervisor"
  | "enforcement"
  | "vendor"
  | "hub_avsec"
  | "redq_avsec";

export type TransactionStatus =
  | "CREATED"
  | "INFLIGHT_POST_APPROVED"
  | "AIRPORT_POST_APPROVED"
  /** REDQ-route outbound only, between INFLIGHT_POST_APPROVED and AIRPORT_POST_APPROVED. */
  | "REDQ_RESEALED"
  | "COMPLETED"
  | "ESCALATED";

export type Direction = "OUTBOUND" | "INBOUND";

/**
 * Outbound-only routing chosen at Part A creation (default AIRCRAFT,
 * unchanged behavior). INBOUND transactions always stay AIRCRAFT — Hub,
 * REDQ and MAINTENANCE are never valid inbound. MAINTENANCE is never
 * chosen directly — it's auto-derived server-side from the AIRCRAFT route
 * plus the "Vehicle Maintenance" cargo type (GSE Workshop has no security
 * checkpoint and maintenance duration is unknown up front, so the
 * transaction completes at Part C instead of waiting on a Part D that can
 * never happen). See
 * supabase/migrations/20260817000002_multiroute_redq_restructure.sql and
 * supabase/migrations/20260818000001_maintenance_route.sql.
 */
export type TransactionRoute = "AIRCRAFT" | "HUB" | "REDQ" | "MAINTENANCE";
export type HubDestination = "PEN" | "JHB" | "NILAI";

export type DeliveryLocation = "SRA_WAREHOUSE" | "AIRCRAFT";

export type IncidentType =
  | "BROKEN_SEAL"
  | "SEAL_MISMATCH"
  | "UNAUTHORIZED_DRIVER"
  | "UNAUTHORIZED_VEHICLE"
  | "EXPIRED_PASS"
  | "WRONG_SEAL_COLOR"
  | "TIMEOUT"
  | "OTHER"
  | "WHITELIST_VIOLATION"
  | "SEGMENT_TIMEOUT";

export type SealType = "TRUCK_SEAL" | "TROLLEY" | "OTHER";
/** Cargo category checklist on the amended IFCSF (AA/SEC/F/010 Rev.01). */
export type CargoType =
  | "FOOD_BEVERAGE"
  | "PERISHABLE"
  | "DUTY_FREE"
  | "MERCHANDISE"
  | "VEHICLE_MAINTENANCE";
export type SealColor = "BLUE" | "GREEN" | "OTHER";
export type SealCheckpoint = "INFLIGHT_POST" | "AIRPORT_POST" | "PART_D" | "REDQ";

export type Seal = {
  id: string;
  transaction_id: string;
  seal_number: string;
  seal_type: SealType;
  seal_color: SealColor;
  applied_at: string;
  /** Set together, once, only at a REDQ re-seal — the one mutation a seal
   *  row is ever allowed (enforce_seal_supersede_only()). Null means still
   *  the active seal of record. */
  superseded_at: string | null;
  superseded_by: string | null;
  superseded_reason: string | null;
}

export type SealVerification = {
  id: string;
  seal_id: string;
  checkpoint: SealCheckpoint;
  entered_seal_number: string;
  /** Colour the officer observed at this checkpoint (manual pick, Blue/Green only). */
  observed_seal_color: "BLUE" | "GREEN" | null;
  matched: boolean;
  verified_by: string | null;
  verified_at: string;
  photo_url: string | null;
}

export type CateringCompany = {
  id: string;
  name: string;
  code: string;
  is_active: boolean;
  created_at: string;
}

export type TruckType = "Hi-Lift" | "Bonded Truck";

export type VehicleRecord = {
  id: string;
  vehicle_number: string;
  catering_company_id: string | null;
  airport_pass_number: string | null;
  pass_expiry_date: string | null;
  truck_type: TruckType | null;
  truck_registration_number: string | null;
  is_active: boolean;
  created_at: string;
}

export type DriverRecord = {
  id: string;
  name: string;
  staff_id: string;
  catering_company_id: string | null;
  airport_pass_number: string | null;
  pass_expiry_date: string | null;
  /** True when staff_ic_number should be used instead of the airport pass ID. */
  swap_to_staff_ic: boolean;
  /** Malaysian IC format XXXXXX-XX-XXXX; only set when swap_to_staff_ic is true. */
  staff_ic_number: string | null;
  is_active: boolean;
  created_at: string;
}

export type UserStatus = "pending" | "active" | "rejected";

export type UserProfile = {
  id: string;
  name: string;
  staff_id: string;
  email: string;
  role: Role;
  preferred_language: "en" | "ms";
  /** Self-registered accounts start 'pending' and cannot sign in until an
   *  admin approves them. Existing/admin-created accounts default 'active'. */
  status: UserStatus;
  created_at: string;
}

export type Transaction = {
  id: string;
  transaction_number: string;
  direction: Direction;
  vehicle_number: string;
  driver_name: string;
  driver_id: string;
  /** @deprecated superseded by the seals table; kept for legacy rows */
  seal_number: string | null;
  /** Signed QR token issued at creation (stateless; regenerated for display). */
  qr_token: string | null;
  flight_number: string | null;
  aircraft_registration: string | null;
  catering_company_id: string | null;
  vehicle_id: string | null;
  driver_id_ref: string | null;
  trolley_count: number;
  escort_officer_name: string | null;
  escort_officer_staff_id: string | null;
  /** All-or-nothing with escort_officer_name/staff_id (transactions_escort_pairing_check). */
  escort_vehicle_number: string | null;
  /** IFCSF header field — airport station code/name. */
  station: string | null;
  /** Outbound-only routing chosen at Part A; defaults AIRCRAFT (unchanged
   *  behavior). INBOUND transactions always stay AIRCRAFT. */
  route: TransactionRoute;
  /** Required only when route = 'HUB' (transactions_hub_destination_pairing). */
  hub_destination: HubDestination | null;
  /** IFCSF cargo-type checklist (Food & Beverage, Perishable, etc.) — multi-select. */
  cargo_types: CargoType[];
  /** IFCSF Part A supplies breakdown (Carts/SMU/Pallets/Boxes/Oven Rack + total). */
  supplies_total: number | null;
  supplies_carts: number | null;
  supplies_smu: number | null;
  supplies_pallets: number | null;
  supplies_boxes: number | null;
  supplies_oven_racks: number | null;
  status: TransactionStatus;
  current_stage: "A" | "B" | "C" | "D";
  lifecycle_status: "pending" | "completed" | "escalated";
  escalation_reason: string | null;
  /** True when an outbound transaction was completed without Part D. */
  part_d_skipped: boolean;
  part_d_skip_reason: string | null;
  /** Set by the admin's weekly Export & Reset — never deleted, just hidden
   *  from day-to-day dashboards/lists once archived. */
  archived: boolean;
  archived_at: string | null;
  /** Storage path of the auto-generated completed-form PDF (IFCSF-style),
   *  written once the transaction finishes. Null until then. */
  completed_form_url: string | null;
  /** Set (only) when status changes — the per-segment SLA clock start (Upgrade 5). */
  status_entered_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type SegmentTimeout = {
  id: string;
  direction: Direction;
  from_status: TransactionStatus;
  to_status: TransactionStatus;
  /** Null = no limit for this segment. */
  limit_minutes: number | null;
  created_at: string;
}

export type PartA = {
  id: string;
  transaction_id: string;
  pic_name: string;
  pic_staff_id: string;
  vehicle_search_completed: boolean;
  signature_url: string;
  signature_hash: string | null;
  remarks: string | null;
  completed_by: string;
  completed_at: string;
}

export type PartBC = {
  id: string;
  transaction_id: string;
  avsec_name: string;
  avsec_staff_id: string;
  vehicle_verified: boolean;
  driver_verified: boolean;
  seal_verified: boolean;
  signature_url: string;
  signature_hash: string | null;
  remarks: string | null;
  checkpoint_date: string;
  checkpoint_time: string;
  observed_vehicle_number: string | null;
  observed_driver_name: string | null;
  observed_driver_id: string | null;
  result: "PASS" | "ESCALATE";
  escalation_reason: string | null;
  completed_by: string;
  completed_at: string;
}

export type PartD = {
  id: string;
  transaction_id: string;
  delivery_location: DeliveryLocation;
  receiver_name: string;
  receiver_staff_id: string;
  seal_intact: boolean;
  signature_url: string;
  signature_hash: string | null;
  remarks: string | null;
  checkpoint_date: string;
  checkpoint_time: string;
  result: "PASS" | "ESCALATE";
  escalation_reason: string | null;
  /** Self-reported, required only when delivery_location = 'AIRCRAFT' — no
   *  staff at the aircraft to verify it. */
  aircraft_identifier: string | null;
  completed_by: string;
  completed_at: string;
}

/** Hub AVSEC confirms delivery — terminal step for HUB-route transactions. */
export type PartHub = {
  id: string;
  transaction_id: string;
  /** Must match the transaction's hub_destination (enforce_part_hub_sequence()). */
  confirmed_destination: HubDestination;
  hub_avsec_name: string;
  hub_avsec_staff_id: string;
  remarks: string | null;
  signature_url: string;
  signature_hash: string | null;
  completed_by: string;
  completed_at: string;
}

/**
 * REDQ AVSEC re-seal event — closes out old_seal_id (superseded) and opens
 * new_seal_id, for REDQ-route transactions only. See
 * enforce_part_redq_sequence().
 */
export type PartRedq = {
  id: string;
  transaction_id: string;
  old_seal_id: string;
  new_seal_id: string;
  redq_avsec_name: string;
  redq_avsec_staff_id: string;
  remarks: string | null;
  signature_url: string;
  signature_hash: string | null;
  completed_by: string;
  completed_at: string;
}

export type IncidentStatus = "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "CLOSED";

export type Incident = {
  id: string;
  transaction_id: string;
  incident_type: IncidentType;
  description: string;
  reported_by: string;
  reported_by_id: string | null;
  photo_url: string | null;
  status: IncidentStatus;
  resolved_by: string | null;
  resolution_notes: string | null;
  resolved_at: string | null;
  created_at: string;
}

export type IncidentPhoto = {
  id: string;
  incident_id: string;
  photo_url: string;
  uploaded_at: string;
}

export type AppNotification = {
  id: string;
  user_id: string;
  incident_id: string | null;
  title: string;
  body: string;
  is_read: boolean;
  created_at: string;
}

export type AuditLog = {
  id: string;
  transaction_id: string | null;
  action: string;
  performed_by: string;
  performed_by_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  performed_at: string;
}

export type TransactionWithParts = Transaction & {
  part_a: PartA | null;
  part_b: PartBC | null;
  part_c: PartBC | null;
  part_d: PartD | null;
  incidents: Incident[];
}

/**
 * Vendor Movement Module (AA/SEC/F/019 "Vendors Supplies Security Form") —
 * a second, independent workflow from the catering IFCSF one above.
 * Part A (Vendor) -> Part B (AirAsia Security / Post 2) -> Part C
 * (Warehouse, dual signature). See supabase/migrations/20260813000002_vendor_movement.sql.
 */
export type VendorTransactionStatus =
  | "CREATED"
  | "SECURITY_VERIFIED"
  | "PART_C_PARTIAL"
  | "COMPLETED"
  | "ESCALATED";

export type VendorTransaction = {
  id: string;
  transaction_number: string;
  status: VendorTransactionStatus;
  qr_token: string | null;
  completed_form_url: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type VendorPartA = {
  id: string;
  transaction_id: string;
  driver_name: string;
  nric_number: string;
  seal_number: string;
  signature_url: string;
  completed_by: string;
  completed_at: string;
}

export type VendorPartB = {
  id: string;
  transaction_id: string;
  vehicle_registration_no: string;
  driver_name: string;
  driver_nric: string;
  seal_number: string;
  remarks: string | null;
  signature_url: string;
  avsec_name: string;
  avsec_staff_id: string;
  completed_by: string;
  completed_at: string;
}

/** Single row, filled in by both sides — each pair is all-or-nothing. */
export type VendorPartC = {
  id: string;
  transaction_id: string;
  warehouse_pic_id: string | null;
  warehouse_pic_name: string | null;
  warehouse_signature_url: string | null;
  warehouse_signed_at: string | null;
  vendor_driver_id: string | null;
  vendor_driver_name: string | null;
  vendor_signature_url: string | null;
  vendor_signed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type Database = {
  public: {
    Tables: {
      users: {
        Row: UserProfile;
        Insert: Omit<UserProfile, "created_at" | "preferred_language" | "status"> & {
          created_at?: string;
          preferred_language?: "en" | "ms";
          status?: UserStatus;
        };
        Update: Partial<UserProfile>;
        Relationships: [];
      };
      transactions: {
        Row: Transaction;
        Insert: Omit<
          Transaction,
          | "id"
          | "transaction_number"
          | "status"
          | "created_at"
          | "updated_at"
          | "completed_at"
          | "qr_token"
          | "flight_number"
          | "aircraft_registration"
          | "catering_company_id"
          | "vehicle_id"
          | "driver_id_ref"
          | "trolley_count"
          | "escort_officer_name"
          | "escort_officer_staff_id"
          | "escort_vehicle_number"
          | "station"
          | "cargo_types"
          | "supplies_total"
          | "supplies_carts"
          | "supplies_smu"
          | "supplies_pallets"
          | "supplies_boxes"
          | "supplies_oven_racks"
          | "current_stage"
          | "lifecycle_status"
          | "escalation_reason"
          | "part_d_skipped"
          | "part_d_skip_reason"
          | "archived"
          | "archived_at"
          | "completed_form_url"
          | "status_entered_at"
          | "route"
          | "hub_destination"
        > & {
          id?: string;
          transaction_number?: string;
          status?: TransactionStatus;
          qr_token?: string | null;
          flight_number?: string | null;
          aircraft_registration?: string | null;
          catering_company_id?: string | null;
          vehicle_id?: string | null;
          driver_id_ref?: string | null;
          trolley_count?: number;
          escort_officer_name?: string | null;
          escort_officer_staff_id?: string | null;
          escort_vehicle_number?: string | null;
          station?: string | null;
          route?: TransactionRoute;
          hub_destination?: HubDestination | null;
          cargo_types?: CargoType[];
          supplies_total?: number | null;
          supplies_carts?: number | null;
          supplies_smu?: number | null;
          supplies_pallets?: number | null;
          supplies_boxes?: number | null;
          supplies_oven_racks?: number | null;
          current_stage?: "A" | "B" | "C" | "D";
          lifecycle_status?: "pending" | "completed" | "escalated";
          escalation_reason?: string | null;
          part_d_skipped?: boolean;
          part_d_skip_reason?: string | null;
          archived?: boolean;
          archived_at?: string | null;
          completed_form_url?: string | null;
          status_entered_at?: string;
        };
        Update: Partial<Transaction>;
        Relationships: [];
      };
      part_a: {
        Row: PartA;
        Insert: Omit<PartA, "id" | "completed_at"> & { id?: string; completed_at?: string };
        Update: Partial<PartA>;
        Relationships: [];
      };
      part_b: {
        Row: PartBC;
        Insert: Omit<
          PartBC,
          | "id"
          | "completed_at"
          | "checkpoint_date"
          | "checkpoint_time"
          | "observed_vehicle_number"
          | "observed_driver_name"
          | "observed_driver_id"
          | "result"
          | "escalation_reason"
        > & {
          id?: string;
          completed_at?: string;
          checkpoint_date?: string;
          checkpoint_time?: string;
          observed_vehicle_number?: string | null;
          observed_driver_name?: string | null;
          observed_driver_id?: string | null;
          result?: "PASS" | "ESCALATE";
          escalation_reason?: string | null;
        };
        Update: Partial<PartBC>;
        Relationships: [];
      };
      part_c: {
        Row: PartBC;
        Insert: Database["public"]["Tables"]["part_b"]["Insert"];
        Update: Partial<PartBC>;
        Relationships: [];
      };
      part_d: {
        Row: PartD;
        Insert: Omit<
          PartD,
          | "id"
          | "completed_at"
          | "checkpoint_date"
          | "checkpoint_time"
          | "result"
          | "escalation_reason"
          | "aircraft_identifier"
        > & {
          id?: string;
          completed_at?: string;
          checkpoint_date?: string;
          checkpoint_time?: string;
          result?: "PASS" | "ESCALATE";
          escalation_reason?: string | null;
          aircraft_identifier?: string | null;
        };
        Update: Partial<PartD>;
        Relationships: [];
      };
      part_hub: {
        Row: PartHub;
        Insert: Omit<PartHub, "id" | "completed_at" | "signature_hash" | "remarks"> & {
          id?: string;
          completed_at?: string;
          signature_hash?: string | null;
          remarks?: string | null;
        };
        Update: never;
        Relationships: [];
      };
      part_redq: {
        Row: PartRedq;
        Insert: Omit<PartRedq, "id" | "completed_at" | "signature_hash" | "remarks"> & {
          id?: string;
          completed_at?: string;
          signature_hash?: string | null;
          remarks?: string | null;
        };
        Update: never;
        Relationships: [];
      };
      incidents: {
        Row: Incident;
        Insert: Omit<
          Incident,
          "id" | "created_at" | "status" | "resolved_by" | "resolution_notes" | "resolved_at"
        > & {
          id?: string;
          created_at?: string;
          status?: IncidentStatus;
          resolved_by?: string | null;
          resolution_notes?: string | null;
          resolved_at?: string | null;
        };
        Update: Partial<Incident>;
        Relationships: [];
      };
      incident_photos: {
        Row: IncidentPhoto;
        Insert: Omit<IncidentPhoto, "id" | "uploaded_at"> & { id?: string; uploaded_at?: string };
        Update: never;
        Relationships: [];
      };
      notifications: {
        Row: AppNotification;
        Insert: Omit<AppNotification, "id" | "created_at" | "is_read"> & {
          id?: string;
          created_at?: string;
          is_read?: boolean;
        };
        Update: Partial<AppNotification>;
        Relationships: [];
      };
      cscs_settings: {
        Row: { key: string; value: string };
        Insert: { key: string; value: string };
        Update: Partial<{ key: string; value: string }>;
        Relationships: [];
      };
      audit_logs: {
        Row: AuditLog;
        Insert: Omit<AuditLog, "id" | "performed_at"> & { id?: string; performed_at?: string };
        Update: never;
        Relationships: [];
      };
      catering_companies: {
        Row: CateringCompany;
        Insert: Omit<CateringCompany, "id" | "created_at" | "is_active"> & {
          id?: string;
          is_active?: boolean;
        };
        Update: Partial<CateringCompany>;
        Relationships: [];
      };
      vehicles: {
        Row: VehicleRecord;
        Insert: Omit<VehicleRecord, "id" | "created_at" | "is_active" | "truck_type" | "truck_registration_number"> & {
          id?: string;
          is_active?: boolean;
          truck_type?: TruckType | null;
          truck_registration_number?: string | null;
        };
        Update: Partial<VehicleRecord>;
        Relationships: [];
      };
      drivers: {
        Row: DriverRecord;
        Insert: Omit<DriverRecord, "id" | "created_at" | "is_active" | "swap_to_staff_ic" | "staff_ic_number"> & {
          id?: string;
          is_active?: boolean;
          swap_to_staff_ic?: boolean;
          staff_ic_number?: string | null;
        };
        Update: Partial<DriverRecord>;
        Relationships: [];
      };
      seals: {
        Row: Seal;
        Insert: Omit<
          Seal,
          "id" | "applied_at" | "superseded_at" | "superseded_by" | "superseded_reason"
        > & { id?: string; applied_at?: string };
        // The one permitted mutation (superseded_at/by/reason, set once at a
        // REDQ re-seal) only ever happens inside enforce_part_redq_sequence()
        // as a security-definer write — application code never calls
        // .update() on seals directly, so this stays `never`.
        Update: never;
        Relationships: [];
      };
      seal_verifications: {
        Row: SealVerification;
        Insert: Omit<SealVerification, "id" | "verified_at" | "observed_seal_color"> & {
          id?: string;
          verified_at?: string;
          observed_seal_color?: "BLUE" | "GREEN" | null;
        };
        Update: never;
        Relationships: [];
      };
      segment_timeouts: {
        Row: SegmentTimeout;
        Insert: Omit<SegmentTimeout, "id" | "created_at"> & { id?: string; created_at?: string };
        Update: never;
        Relationships: [];
      };
      vendor_transactions: {
        Row: VendorTransaction;
        Insert: Omit<
          VendorTransaction,
          "id" | "transaction_number" | "status" | "qr_token" | "completed_form_url" | "created_at" | "updated_at" | "completed_at"
        > & {
          id?: string;
          transaction_number?: string;
          status?: VendorTransactionStatus;
          qr_token?: string | null;
          completed_form_url?: string | null;
          created_at?: string;
          updated_at?: string;
          completed_at?: string | null;
        };
        Update: Partial<VendorTransaction>;
        Relationships: [];
      };
      vendor_part_a: {
        Row: VendorPartA;
        Insert: Omit<VendorPartA, "id" | "completed_at"> & { id?: string; completed_at?: string };
        Update: never;
        Relationships: [];
      };
      vendor_part_b: {
        Row: VendorPartB;
        Insert: Omit<VendorPartB, "id" | "completed_at" | "remarks"> & {
          id?: string;
          completed_at?: string;
          remarks?: string | null;
        };
        Update: never;
        Relationships: [];
      };
      vendor_part_c: {
        Row: VendorPartC;
        Insert: Omit<VendorPartC, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<VendorPartC>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      current_user_role: { Args: Record<string, never>; Returns: string };
      next_transaction_number: { Args: Record<string, never>; Returns: string };
      skip_part_d: {
        Args: { p_transaction_id: string; p_reason: string };
        Returns: void;
      };
      archive_all_pending: {
        Args: { p_reason?: string | null };
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
