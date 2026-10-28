-- 0129_scm_dp_orders.sql — the DP Order (delivery-planning job) table.
--
-- Owner spec 2026-07-18: unify delivery / customer-pickup / service / setup /
-- dismantle / SUPPLIER-pickup into ONE "DP Order" concept feeding Delivery
-- Planning. Each job type auto-fills its party from a DIFFERENT master, and the
-- masters DISAGREE on shape (survey 2026-07-18):
--   • scm.suppliers has a SINGLE free-text `address` (no address1-4, no city).
--   • public.projects (PMS) has free-text `venue_address` + `state`; the PIC is a
--     users(id) FK, so the PIC name/phone live on public.users.
--   • the SO header has address1-4 + city + postcode + customer_state.
-- Because no single master fits, dp_orders carries its OWN snapshot of the
-- resolved party (name / contact / structured address / state) — auto-filled from
-- whichever master on create, then editable. The source-document columns keep the
-- link back for provenance.
--
-- Source links are BARE columns (soft links, no FK) on purpose: they cross
-- schemas (public.projects, public.assr_cases) and follow the codebase's existing
-- soft-link pattern (mfg_sales_orders.customer_id, trip_stops.so_id are the same).
-- This also avoids the scm.staff ON-DELETE-SET-NULL trap on a referenced master.
--
-- dp_no is the DP-YYMMDD-<plateLetters><NN> number, minted at SCHEDULE (when a
-- lorry+date are assigned — the plate letters come from the lorry). NULL until
-- then, so the partial unique index only constrains minted numbers.
--
-- HOUSE STYLE: no runtime self-apply, IF NOT EXISTS throughout, plain statements
-- (no PL/pgSQL), SET search_path so unqualified scm types resolve.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.dp_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    bigint,
  dp_no         text,
  job_type      scm.trip_stop_type NOT NULL,
  party_type    text NOT NULL,
  so_doc_no     text,
  do_id         uuid,
  assr_case_id  bigint,
  supplier_id   uuid,
  project_id    bigint,
  party_name    text,
  contact_name  text,
  contact_phone text,
  address1      text,
  address2      text,
  address3      text,
  address4      text,
  city          text,
  postcode      text,
  state         text,
  requested_date date,
  trip_id       uuid,
  trip_stop_id  uuid,
  status        text NOT NULL DEFAULT 'PENDING_SCHEDULE',
  remark        text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dp_orders_status ON scm.dp_orders (status, requested_date);
CREATE INDEX IF NOT EXISTS idx_dp_orders_trip ON scm.dp_orders (trip_id);
CREATE INDEX IF NOT EXISTS idx_dp_orders_company ON scm.dp_orders (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dp_orders_dp_no ON scm.dp_orders (dp_no) WHERE dp_no IS NOT NULL;
