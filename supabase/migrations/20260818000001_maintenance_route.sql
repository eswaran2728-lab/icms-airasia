-- ============================================================
-- ICMS: GSE Workshop Maintenance route.
--
-- Adds a fourth outbound-only route, MAINTENANCE, alongside today's
-- AIRCRAFT/HUB/REDQ:
--   MAINTENANCE: A -> B -> C (terminal — no D)
--
-- Unlike HUB/REDQ, MAINTENANCE is never chosen directly at Part A —
-- it's auto-derived server-side (src/lib/actions/transactions.ts,
-- createTransaction) from the default AIRCRAFT route plus the
-- "Vehicle Maintenance" cargo type. GSE Workshop (the final physical
-- destination) has no security checkpoint of its own and the
-- maintenance duration is unknown up front, so the transaction
-- finalizes at Part C — Airport Post (Post 6) instead of waiting on a
-- Part D that can never happen. The completed-form PDF continues to
-- overlay onto the IFCSF outbound page (same as AIRCRAFT/REDQ) with
-- Part D simply left blank, same pattern already used for HUB.
-- ============================================================

-- ------------------------------------------------------------
-- transactions.route: widen the allowed values. This is the same
-- inline check constraint added in
-- 20260817000002_multiroute_redq_restructure.sql
-- (`add column route text not null default 'AIRCRAFT' check (route in
-- (...))`), so it carries Postgres's default auto-generated name for
-- an unnamed column-level check: <table>_<column>_check.
-- ------------------------------------------------------------
alter table public.transactions drop constraint transactions_route_check;
alter table public.transactions
  add constraint transactions_route_check
  check (route in ('AIRCRAFT', 'HUB', 'REDQ', 'MAINTENANCE'));

-- A MAINTENANCE-route transaction must always carry the cargo type it
-- was derived from — defense-in-depth mirroring the existing
-- transactions_hub_destination_pairing check. Deliberately one-way:
-- picking "Vehicle Maintenance" cargo without route = MAINTENANCE is
-- still valid (e.g. combined with HUB/REDQ, which already have their
-- own terminal step and aren't affected by this route).
alter table public.transactions
  add constraint transactions_maintenance_cargo_pairing check (
    route <> 'MAINTENANCE' or 'VEHICLE_MAINTENANCE' = any (cargo_types)
  );

-- ------------------------------------------------------------
-- enforce_part_sequence(): MAINTENANCE-route Part C behaves exactly
-- like AIRCRAFT-route Part C (same required status, INFLIGHT_POST_
-- APPROVED) except it finalizes the transaction directly instead of
-- advancing to AIRPORT_POST_APPROVED. Part D is blocked outright for
-- MAINTENANCE, mirroring the existing HUB block, for a clear error
-- message (status alone would already prevent it, since MAINTENANCE
-- transactions never reach AIRPORT_POST_APPROVED).
-- ------------------------------------------------------------
create or replace function public.enforce_part_sequence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_direction text;
  v_route text;
begin
  select status, direction, route into v_status, v_direction, v_route
  from transactions where id = new.transaction_id for update;

  if v_status is null then
    raise exception 'CSCS: transaction not found / transaksi tidak dijumpai';
  end if;

  if v_status = 'ESCALATED' then
    raise exception 'CSCS: transaction escalated, checkpoint processing suspended / transaksi dieskalasi, pemprosesan pusat pemeriksaan digantung';
  end if;

  if tg_table_name = 'part_b' then
    if v_direction = 'OUTBOUND' then
      if v_status <> 'CREATED' then
        raise exception 'CSCS: out of order - outbound Part B (In-flight Post) requires status CREATED, current % / tidak mengikut urutan - Bahagian B keluar memerlukan status CREATED, kini %', v_status, v_status;
      end if;
      update transactions set status = 'INFLIGHT_POST_APPROVED' where id = new.transaction_id;
    else
      if v_status <> 'AIRPORT_POST_APPROVED' then
        raise exception 'CSCS: out of order - inbound Part B (In-flight Post, final) requires status AIRPORT_POST_APPROVED, current % / tidak mengikut urutan - Bahagian B masuk (akhir) memerlukan status AIRPORT_POST_APPROVED, kini %', v_status, v_status;
      end if;
      update transactions set status = 'COMPLETED', completed_at = now() where id = new.transaction_id;
    end if;

  elsif tg_table_name = 'part_c' then
    if v_route = 'HUB' then
      raise exception 'ICMS: Part C does not apply to HUB-route transactions — use Part Hub instead';
    end if;
    if v_direction = 'OUTBOUND' then
      if v_route = 'REDQ' then
        if v_status <> 'REDQ_RESEALED' then
          raise exception 'ICMS: out of order - REDQ-route Part C requires status REDQ_RESEALED, current %', v_status;
        end if;
      else
        if v_status <> 'INFLIGHT_POST_APPROVED' then
          raise exception 'CSCS: out of order - outbound Part C (Airport Post) requires status INFLIGHT_POST_APPROVED, current % / tidak mengikut urutan - Bahagian C keluar memerlukan status INFLIGHT_POST_APPROVED, kini %', v_status, v_status;
        end if;
      end if;
    else
      if v_status <> 'CREATED' then
        raise exception 'CSCS: out of order - inbound Part C (Airport Post) requires status CREATED, current % / tidak mengikut urutan - Bahagian C masuk memerlukan status CREATED, kini %', v_status, v_status;
      end if;
    end if;
    if v_route = 'MAINTENANCE' then
      -- Terminal step for MAINTENANCE route — no Part D (GSE Workshop
      -- has no checkpoint and maintenance duration is unknown).
      update transactions set status = 'COMPLETED', completed_at = now() where id = new.transaction_id;
    else
      update transactions set status = 'AIRPORT_POST_APPROVED' where id = new.transaction_id;
    end if;

  elsif tg_table_name = 'part_d' then
    if v_route = 'HUB' then
      raise exception 'ICMS: Part D does not apply to HUB-route transactions — Part Hub is the terminal step';
    end if;
    if v_route = 'MAINTENANCE' then
      raise exception 'ICMS: Part D does not apply to MAINTENANCE-route transactions — Part C is the terminal step';
    end if;
    if v_direction = 'INBOUND' then
      raise exception 'CSCS: Part D does not apply to inbound transactions / Bahagian D tidak terpakai untuk transaksi masuk';
    end if;
    if v_status <> 'AIRPORT_POST_APPROVED' then
      raise exception 'CSCS: out of order - Part D requires status AIRPORT_POST_APPROVED, current % / tidak mengikut urutan - Bahagian D memerlukan status AIRPORT_POST_APPROVED, kini %', v_status, v_status;
    end if;
    update transactions set status = 'COMPLETED', completed_at = now() where id = new.transaction_id;
  end if;

  return new;
end;
$$;
