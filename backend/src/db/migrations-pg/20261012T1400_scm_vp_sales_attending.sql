-- 20261012T1400_scm_vp_sales_attending.sql
--
-- ERP -> Venture Portal: the SALES ATTENDING push — who the PMS lists at each
-- project (a brand's booth at a fair), live, beside the order feed and the
-- catalogue.
--
-- WHY. The portal scores a salesperson's Fair result at ONE booth a weekend
-- (their "brand week") and pays outstation claims for the fair they worked.
-- Until now its salespeople picked that booth themselves, or the portal guessed
-- it from where they wrote the most bills. The PMS already says where each of
-- them works (public.project_sales_attendees, "Sales Attending"), so the portal
-- takes it from here: the ERP's list first, its own guess only for a weekend
-- the list names nobody. Receiver: POST /api/erp/v1/sales-attending, on the
-- same key as the order feed (the order feed's vp.url with its trailing
-- /sales-orders replaced, scm/lib/venture-portal-attendance.ts).
--
-- THE BODY. One company's booths from `since` on — every project whose
-- start_date reads as a date on or after it, WITH or WITHOUT anybody listed,
-- cancelled ones included (the portal ignores those; an empty list tells it
-- nobody is listed) — each with its listed sales reps and the scm.staff id of
-- the rep's login, which is the id the order feed already sends as the
-- salesperson, so the portal knows the person without matching names. The
-- portal RETIRES any of its booths from `since` on that a delivery does not
-- list, so the list is always complete for that window. Named keys only, like
-- `fair` in vp_build_payloads: a project column added later cannot ride along.
-- No price, cost or customer data is in any of these tables.
--
-- THE WINDOW. since = the first day of the month six months before this one,
-- in MALAYSIA (the database runs in UTC). It moves once a month, which costs
-- one re-send that month. The comparison is on the text 'YYYY-MM-DD', never a
-- cast, so a project whose start_date does not read as a date cannot fail the
-- build: it is left out by the pattern.
--
-- THE DIGEST AND THE MARKS. As the catalogue (20260923T1843, 20260924T1100):
-- the */5 cron asks vp_attendance_digest and sends only when it differs from
-- the last one the portal accepted (scm.venture_portal_attendance_state); a
-- statement trigger on each source table marks
-- scm.venture_portal_attendance_changes in the same transaction, and the SCM
-- write kick pushes while a mark is there, so a Sales Attending edit reaches
-- the portal in seconds. Marks are statement-level and append-only, and the
-- mark function swallows its own failure: a lost mark only means the cron
-- sends it instead, and a PMS save must never fail because of the portal.
--
-- REVERSAL: DROP TRIGGER IF EXISTS vp_attendance_changed ON public.projects,
--   and vp_attendance_changed_upd on the same table; DROP TRIGGER IF EXISTS
--   vp_attendance_changed ON public.project_sales_attendees; DROP TRIGGER IF
--   EXISTS vp_attendance_changed_upd ON public.sales_reps; then
--   DROP FUNCTION IF EXISTS scm.vp_attendance_mark_changed(),
--   scm.vp_attendance_snapshot(bigint), scm.vp_attendance_digest(bigint),
--   scm.vp_build_attendance(bigint); DROP TABLE IF EXISTS
--   scm.venture_portal_attendance_changes, scm.venture_portal_attendance_state.
--   The Worker treats a missing function as "build failed" and sends nothing.
--   No existing table's data, columns or grants are altered.
-- Verified against: production (anogrigyjbduyzclzjgn), read-only via the
--   Supabase MCP on 2026-10-12. The body of vp_build_attendance(1) ran as a
--   plain SELECT: since 2026-04-01, 318 booths (31 cancelled, 257 with nobody
--   listed), 268 listed reps, every one with a login (salespersonId never
--   null), 138,465 bytes as jsonb text; the md5 of its booths equals the one
--   relayed into the portal by hand that day. No project of any company has a
--   start_date that fails the date pattern; only company 1 has projects.
-- RE-RUN: no-op. CREATE OR REPLACE / IF NOT EXISTS / DROP TRIGGER IF EXISTS
--   throughout.

-- ── The body ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION scm.vp_build_attendance(p_company_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = scm, public
AS $fn$
  WITH win AS (
    SELECT (date_trunc('month', now() AT TIME ZONE 'Asia/Kuala_Lumpur') - interval '6 months')::date AS since
  )
  SELECT jsonb_build_object(
           'companyId', p_company_id,
           'since', to_char(w.since, 'YYYY-MM-DD'),
           'booths', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'projectId', p.id,
                      'code', p.code,
                      'name', p.name,
                      'brand', p.brand,
                      'venue', p.venue,
                      'organizer', p.organizer,
                      'startDate', p.start_date,
                      'endDate', p.end_date,
                      'status', p.status,
                      'eventType', et.slug,
                      'attendees', COALESCE((
                        SELECT jsonb_agg(jsonb_build_object(
                                 'salesRepId', r.id,
                                 'code', r.code,
                                 'name', r.name,
                                 -- The rep's login as the order feed names a salesperson.
                                 'salespersonId', st.id)
                               ORDER BY r.name, r.id)
                          FROM public.project_sales_attendees a
                          JOIN public.sales_reps r ON r.id = a.sales_rep_id
                          LEFT JOIN LATERAL (
                            SELECT s.id
                              FROM scm.staff s
                             WHERE s.user_id = r.user_id
                             ORDER BY s.active DESC, s.created_at
                             LIMIT 1) st ON true
                         WHERE a.project_id = p.id), '[]'::jsonb))
                    ORDER BY p.start_date, p.id)
               FROM public.projects p
               LEFT JOIN public.project_event_types et ON et.id = p.event_type_id
              WHERE p.company_id = p_company_id
                AND p.start_date ~ '^\d{4}-\d{2}-\d{2}'
                AND left(p.start_date, 10) >= to_char(w.since, 'YYYY-MM-DD')), '[]'::jsonb))
    FROM win w
$fn$;

COMMENT ON FUNCTION scm.vp_build_attendance(bigint) IS
  'One company''s Sales Attending as a Venture Portal delivery body (POST /api/erp/v1/sales-attending): every project from since on, with or without listed reps, cancelled included, each rep with the scm.staff id of its login. Named keys only. Deterministic (ordered by start_date, id; reps by name, id; no timestamp), so md5 of it is a stable digest. Sent by scm/lib/venture-portal-attendance.ts.';

-- The cheap question the cron asks every five minutes.
CREATE OR REPLACE FUNCTION scm.vp_attendance_digest(p_company_id bigint)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = scm, public
AS $fn$
  SELECT md5(scm.vp_build_attendance(p_company_id)::text)
$fn$;

COMMENT ON FUNCTION scm.vp_attendance_digest(bigint) IS
  'md5 of scm.vp_build_attendance(p_company_id)::text — changes exactly when the Sales Attending the portal would receive changes.';

-- The body and ITS digest, from one build. snapshotAt is added after the
-- digest is taken: it is the time of THIS build, which the portal uses to keep
-- the newest of two deliveries that overlap, and never a reason to re-send.
CREATE OR REPLACE FUNCTION scm.vp_attendance_snapshot(p_company_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = scm, public
AS $fn$
DECLARE
  body jsonb := scm.vp_build_attendance(p_company_id);
BEGIN
  RETURN jsonb_build_object('digest', md5(body::text), 'body', body || jsonb_build_object('snapshotAt', now()));
END
$fn$;

COMMENT ON FUNCTION scm.vp_attendance_snapshot(bigint) IS
  '{digest, body} from ONE vp_build_attendance call (body with snapshotAt added after the digest), so the digest the sender records as delivered describes exactly the list it sent.';

-- ── What the sender last delivered ──────────────────────────────────────────
-- One row per company, as scm.venture_portal_catalogue_state: the sender skips
-- a company whose digest equals delivered_digest, and one whose digest the
-- portal already refused with a 400/413/422 (last_outcome 'failed').
-- delivered_digest is cleared whenever the portal MAY hold something else (an
-- answer that never came back), so the next run re-sends instead of trusting
-- it. last_outcome is classifyVpResponse's vocabulary (venture-portal-outbox.ts).
-- No RLS, like the catalogue's: the schema is closed to anon and authenticated,
-- and the service role is granted below.
CREATE TABLE IF NOT EXISTS scm.venture_portal_attendance_state (
  company_id        bigint      PRIMARY KEY,
  delivered_digest  text,
  delivered_at      timestamptz,
  portal_result     jsonb,
  last_digest       text,
  last_outcome      text        CHECK (last_outcome IN ('sent', 'failed', 'retry')),
  last_attempt_at   timestamptz,
  last_http_status  integer,
  last_error        text,
  last_bytes        integer,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE scm.venture_portal_attendance_state IS
  'ERP -> Venture Portal Sales Attending push: per company, the digest of the last list the portal accepted, and the outcome of the latest attempt (sent / failed = 400/413/422, not retried until the list changes or a person forces it / retry). Written by scm/lib/venture-portal-attendance.ts.';

-- ── The marks ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scm.venture_portal_attendance_changes (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source      text        NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE scm.venture_portal_attendance_changes IS
  'ERP -> Venture Portal Sales Attending push: one row per statement that changed what the list sends (statement triggers vp_attendance_changed*). The SCM write kick sends the list while a row is here; every push clears the rows it covers. Written by triggers, read and cleared by scm/lib/venture-portal-attendance.ts.';

-- SECURITY DEFINER because the writers are many roles (the service role, the
-- Hyperdrive origin roles, a session through PostgREST) and none of them is
-- granted this table; it inserts one fixed row and nothing else. It swallows
-- its own failure, as enqueue_vp_outbox_project does: a PMS save must never
-- fail because of the portal, and a lost mark is sent by the cron instead.
CREATE OR REPLACE FUNCTION scm.vp_attendance_mark_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $fn$
BEGIN
  BEGIN
    INSERT INTO scm.venture_portal_attendance_changes (source) VALUES (TG_TABLE_NAME);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION scm.vp_attendance_mark_changed() IS
  'Statement trigger: marks the Venture Portal Sales Attending list changed (scm.venture_portal_attendance_changes). See 20261012T1400_scm_vp_sales_attending.sql.';

-- ── The projects: a booth's identity, brand, place, days, status, type ────
DROP TRIGGER IF EXISTS vp_attendance_changed ON public.projects;
CREATE TRIGGER vp_attendance_changed
  AFTER INSERT OR DELETE ON public.projects
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_attendance_mark_changed();
DROP TRIGGER IF EXISTS vp_attendance_changed_upd ON public.projects;
CREATE TRIGGER vp_attendance_changed_upd
  AFTER UPDATE OF company_id, code, name, brand, venue, organizer, start_date, end_date, status, event_type_id
  ON public.projects
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_attendance_mark_changed();

-- ── Sales Attending itself ─────────────────────────────────────────────────
DROP TRIGGER IF EXISTS vp_attendance_changed ON public.project_sales_attendees;
CREATE TRIGGER vp_attendance_changed
  AFTER INSERT OR UPDATE OR DELETE ON public.project_sales_attendees
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_attendance_mark_changed();

-- ── A rep's name, code or login ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS vp_attendance_changed_upd ON public.sales_reps;
CREATE TRIGGER vp_attendance_changed_upd
  AFTER UPDATE OF name, code, user_id OR DELETE ON public.sales_reps
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_attendance_mark_changed();

-- ── Grants ──────────────────────────────────────────────────────────────────
-- The PostgREST service role is the only caller. Hyperdrive origin roles are
-- matched by prefix, as 20260923T1843 does, because their names live in
-- Cloudflare connection strings and in no file here.
DO $grant$
DECLARE
  g  record;
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'scm.vp_build_attendance(bigint)',
    'scm.vp_attendance_digest(bigint)',
    'scm.vp_attendance_snapshot(bigint)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
    FOR g IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'hyperdrive%' LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, g.rolname);
    END LOOP;
  END LOOP;

  REVOKE ALL ON FUNCTION scm.vp_attendance_mark_changed() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.venture_portal_attendance_state TO service_role;
    GRANT SELECT, DELETE ON scm.venture_portal_attendance_changes TO service_role;
  END IF;
END
$grant$;
