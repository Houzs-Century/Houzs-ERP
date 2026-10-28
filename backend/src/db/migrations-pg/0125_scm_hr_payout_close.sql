-- 0125: HR commission — period close / payout snapshot.
--
-- NUMBERING: 0124 + 0125 were both free (0123 is used three times). This file
-- must sort AFTER 0124: it snapshots override_mode + the level rates, which
-- 0124 creates. The runner sorts by filename, so 0124 < 0125 guarantees it.
--
-- WHY THIS EXISTS (the gap the owner has NOT ruled on — raised, not invented)
--   /hr/commission RECOMPUTES from the CURRENT config on every single load.
--   There is no payout table and no period close anywhere in the module. So
--   editing one rate in HR Settings silently rewrites what every PAST period
--   pays — retroactively, with no record, for every salesperson at once. Nobody
--   would see it happen: the report simply shows a different number than it
--   showed yesterday, and both look equally authoritative.
--
--   For payroll that is worse than the DRAFT bug this branch also fixes. A
--   wrong figure is one wrong payslip. A figure that MOVES means no commission
--   the owner has ever approved is reproducible — you cannot answer "what did we
--   pay Ah Seng in June and why" with evidence, only with a re-run of today's
--   rates against June's orders, which is a different question wearing the same
--   answer's clothes. Rate history, an audit log, or "don't edit rates" do not
--   fix it: the report would still recompute.
--
-- WHAT CLOSING STORES: BOTH THE OUTPUT AND THE INPUT. This is the decision.
--   · OUTPUT (hr_payout_rows) is AUTHORITATIVE. A closed period is SERVED from
--     these rows — the engine is not re-run. That is the only way "reproducible
--     byte-for-byte" survives a CODE change: storing only the config snapshot
--     lets you re-derive, but re-deriving runs today's engine, so the next
--     rounding fix or bug fix silently moves a payout the owner already
--     approved and paid. An input snapshot cannot protect against a change to
--     the function that consumes it.
--   · INPUT (config_snapshot, override_mode, override_levels_snapshot,
--     engine_version) is the WHY. Storing only the output would leave a frozen
--     RM 4,231.50 with no way to answer "which rates produced this" once the
--     live config has moved on — an unexplainable number is not much better than
--     an unstable one, and the first payroll dispute is exactly when you need it.
--   Both, therefore. They are not redundant: the output is what we owe, the
--   input is why we owe it. Storing either alone loses something payroll needs.
--
-- MAY A CLOSED PERIOD BE REOPENED? YES — RECORDED, NEVER ERASED.
--   Forbidding reopen outright is the tempting answer and the wrong one: real
--   payroll corrections happen (a missed SO, a wrong tier) and a system with no
--   legitimate correction path gets corrected in the database by hand, which is
--   strictly worse than a reopen with a name on it. So reopen is allowed, and
--   made expensive and visible instead of impossible:
--     · it needs its OWN permission key (scm.hr.reopen) — closing is not
--       licence to reopen
--     · it needs a reason (NOT NULL when status='REOPENED')
--     · it NEVER deletes the frozen rows. The period flips to REOPENED and the
--       snapshot stays readable forever.
--     · re-closing INSERTS A NEW ROW at revision+1. History is append-only, so
--       "what did we approve, when, who moved it, and what did it become" is
--       always answerable.
--   The partial unique index below is what enforces "at most ONE live closed
--   snapshot per period" while keeping every superseded revision.
--
-- MONEY COLUMNS ARE bigint, NOT integer
--   A deliberate divergence from the scm centi convention (integer). These
--   columns hold SUMS over a whole company-period, not one order's line. int4
--   tops out at 2,147,483,647 centi = RM 21.4M — reachable, and the failure mode
--   is a mid-close overflow error on the one operation that must not fail. The
--   per-row source columns stay integer upstream. bigint costs nothing here.
--
-- CONVENTIONS
--   timestamptz per 0123 (scm.* is natively PG through PostgREST). pg-migrate
--   splits on /;\s*\n/ BEFORE stripping comments, so every DO block is on ONE
--   physical line and no comment line ends in a semicolon.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1) the period header -------------------------------------------------------
-- Period identity is (company_id, period_from, period_to): /hr/commission is
-- already an arbitrary from/to report and the owner has not ruled that payroll
-- is calendar-monthly, so the close freezes WHATEVER RANGE HE CLOSED rather than
-- inventing a month grain he would have to work around.

CREATE TABLE IF NOT EXISTS scm.hr_payout_periods (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               bigint NOT NULL REFERENCES public.companies(id),
  period_from              date NOT NULL,
  period_to                date NOT NULL,
  revision                 integer NOT NULL DEFAULT 1,
  status                   text NOT NULL DEFAULT 'CLOSED',
  engine_version           text NOT NULL,
  config_snapshot          jsonb NOT NULL,
  override_mode            text NOT NULL,
  override_levels_snapshot jsonb NOT NULL,
  total_centi              bigint NOT NULL DEFAULT 0,
  row_count                integer NOT NULL DEFAULT 0,
  closed_by_staff_id       uuid,
  closed_by_user_id        integer,
  closed_by_name           text NOT NULL DEFAULT '',
  closed_at                timestamptz NOT NULL DEFAULT now(),
  reopened_by_user_id      integer,
  reopened_by_name         text NOT NULL DEFAULT '',
  reopened_at              timestamptz,
  reopen_reason            text,
  CONSTRAINT hr_payout_periods_range_check CHECK (period_from <= period_to),
  CONSTRAINT hr_payout_periods_status_check CHECK (status IN ('PENDING', 'CLOSED', 'REOPENED')),
  CONSTRAINT hr_payout_periods_revision_min CHECK (revision >= 1),
  CONSTRAINT hr_payout_periods_mode_check CHECK (override_mode IN ('showroom', 'chain')),
  CONSTRAINT hr_payout_periods_reopen_reason_required CHECK (status <> 'REOPENED' OR (reopen_reason IS NOT NULL AND length(btrim(reopen_reason)) > 0))
);

-- WHY 'PENDING' EXISTS: PostgREST gives the API no transaction, so a close is
-- necessarily "write the header, write the rows" as separate requests. Writing
-- the header as CLOSED first would mean a failure or crash mid-way leaves a LIVE
-- closed period carrying only some of its rows — a corrupt payout that reads as
-- authoritative, which is the worst possible failure for this table. So a close
-- is TWO-PHASE: insert the header PENDING, write every row, and only then flip to
-- CLOSED. Reads serve status='CLOSED' only, so an interrupted close is inert
-- rather than wrong, and it is safe to simply retry. A stranded PENDING row is
-- garbage, not a payout.
--
-- At most ONE live CLOSED snapshot per (company, period) — but every PENDING and
-- REOPENED revision is kept. This is the append-only history rule as an index: a
-- re-close inserts revision+1 and can only succeed once the previous revision is
-- REOPENED, so two live snapshots of one period cannot exist. It also settles a
-- concurrent double-close for free: both racers may write PENDING, but only one
-- can flip to CLOSED — the loser gets a 23505 and stays inert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_payout_periods_live ON scm.hr_payout_periods (company_id, period_from, period_to) WHERE status = 'CLOSED';

CREATE INDEX IF NOT EXISTS idx_hr_payout_periods_company_range ON scm.hr_payout_periods (company_id, period_from, period_to);

-- 2) the frozen rows ---------------------------------------------------------
-- The six figures the close must freeze (goods, rate, personal, override,
-- item-KPI, total) are REAL COLUMNS, not a JSON blob: they are what the module
-- exists to produce and they must stay queryable without parsing.
--
-- NO FOREIGN KEY ON staff_id, AND THE NAMES ARE DENORMALISED — both deliberate.
-- hr_salesperson_profiles carries ON DELETE CASCADE to scm.staff, which is right
-- for a profile and catastrophic for a payslip: deleting a staff row must never
-- delete evidence of what they were paid. Same reason staff_name / showroom_name
-- are copied in rather than joined — renaming a showroom in 2027 must not
-- silently retitle a payout closed in 2026. A snapshot that still moves is not
-- a snapshot.
--
-- override_rate_bps IS NULLABLE and that is load-bearing: in chain mode there is
-- no single override rate (it is Σ over levels of different rates on different
-- bases). NULL means "not a single rate, read override_detail" — writing 0 there
-- would state that someone earned a 0% override, which is a different and false
-- claim.

CREATE TABLE IF NOT EXISTS scm.hr_payout_rows (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id                 uuid NOT NULL REFERENCES scm.hr_payout_periods(id) ON DELETE CASCADE,
  company_id                bigint NOT NULL REFERENCES public.companies(id),
  staff_id                  uuid NOT NULL,
  staff_name                text NOT NULL DEFAULT '',
  showroom_id               uuid,
  showroom_name             text NOT NULL DEFAULT '',
  showroom_goods_centi      bigint NOT NULL DEFAULT 0,
  showroom_kpi_hit          boolean NOT NULL DEFAULT false,
  tier                      text NOT NULL DEFAULT 'sales',
  personal_goods_centi      bigint NOT NULL DEFAULT 0,
  personal_rate_bps         integer NOT NULL DEFAULT 0,
  personal_commission_centi bigint NOT NULL DEFAULT 0,
  override_rate_bps         integer,
  override_commission_centi bigint NOT NULL DEFAULT 0,
  override_detail           jsonb,
  item_kpi_centi            bigint NOT NULL DEFAULT 0,
  kpi_detail                jsonb,
  total_centi               bigint NOT NULL DEFAULT 0,
  sort_index                integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_payout_rows_period_staff_unique UNIQUE (period_id, staff_id)
);

-- UNIQUE (period_id, staff_id) is the second double-pay guard, at rest: whatever
-- the engine does, one person cannot end up with two payout rows in one closed
-- period.

CREATE INDEX IF NOT EXISTS idx_hr_payout_rows_period ON scm.hr_payout_rows (period_id, sort_index);

CREATE INDEX IF NOT EXISTS idx_hr_payout_rows_company_staff ON scm.hr_payout_rows (company_id, staff_id);

-- 3) PostgREST schema cache ---------------------------------------------------
-- Same requirement as 0124 step 4, for the same reason: /api/scm/* resolves
-- tables from a CACHED schema, so hr_payout_periods and hr_payout_rows are
-- invisible to PostgREST — and every close 404s — until it reloads. Repeated
-- here rather than left to 0124 because the two files apply in SEPARATE
-- transactions: a run that stops between them would leave these two tables
-- created but unreachable.
NOTIFY pgrst, 'reload schema';
