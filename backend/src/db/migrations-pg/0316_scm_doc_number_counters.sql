-- 0316_scm_doc_number_counters — a real counter for document numbers.
--
-- 白话（老板版）。单据号码本来是「看现有单据的最大号 + 1」算出来的。08-20 上线清空
-- 把 Houzs Century 的单据全删了，最大号就回到 0，ERP 又发了一次
-- HC-SO-2608-001/002、HC-PO-2608-001、HC-PI-2608-001 —— 这几个号码 AutoCount 账本
-- 在 08-14/17 就已经收过，所以被拒绝（Primary Key Error），它拒绝得没错。
-- 这一版加一张「计数器表」：号码只往上加，删单据不会把号码还回来，中间断号是正常
-- 的（AutoCount、SAP、Odoo、NetSuite 全部都这样）。计数器的起点已经调到账本已有号
-- 码的上面，所以下一张单不会再撞。
--
-- WHY. `mintMonthlyDocNo` derived the next number from the rows that still
-- existed for the month. That is a query, not a counter: deleting the TOP of a
-- series lowers the max and hands the number straight back. golive-wipe-hc.mjs
-- did exactly that on 2026-08-20 -- deliberately, its header said "deleting HC's
-- document rows IS the reset" -- and the licensed AED_HOUZS account book, which
-- is NOT wiped, still held the numbers. docs/doc-number-reissue-coe.md.
--
-- WHAT THIS IS. One row per SERIES, where a series is the doc number without its
-- `-NNN` tail: `HC-SO-2608`, `2990-SI-2608`, `TRIP-2608`, `JE-2608`. That string
-- is the namespace the number lives in -- it is what the minter's LIKE matched
-- and what the unique doc-no indexes protect -- so keying on it needs no company
-- id and no special case for TRIP, which deliberately carries no company prefix
-- and is therefore ONE sequence shared by both companies (lib/companyScope.ts:
-- "Do NOT apply to CROSS-COMPANY shared docs (trips / delivery-planning)").
--
-- GAPS ARE THE POINT, NOT A REGRESSION. AutoCount (running-number maintenance),
-- SAP (NRIV number ranges), Odoo (ir.sequence) and NetSuite all store a counter,
-- never re-derive one from surviving documents, and all four accept gaps. A gap
-- is cosmetic; a re-issue is a data conflict. There is deliberately no
-- gap-filling here.
--
-- REVERSAL: DROP FUNCTION IF EXISTS scm.next_doc_no_n(text, integer);
--           DROP TABLE IF EXISTS scm.doc_number_counters;
--   Reversible cleanly: nothing references the table, no view, FK or trigger
--   depends on either object, and NO document row is touched by this migration,
--   so dropping them changes no document number that already exists. It is safe
--   ONLY together with the code that calls the function -- scm/lib/doc-no.ts
--   falls back to max(suffix)+1 over surviving rows when the RPC is absent
--   (isMissingRpc), so the drop returns the ERP to exactly its pre-2026-08-21
--   behaviour, INCLUDING the re-issue this migration exists to stop. Reversing
--   does not put back numbers already skipped, and does not need to: a gap is
--   the normal state of every counter-based ERP.
-- Verified against: local postgres:16, replayed through splitSqlStatements + one
--   transaction (the pg-migrate path) by backend/tests-pg/docNoCounter.pg.test.ts;
--   and the seed itself measured on PRODUCTION, read-only, BEFORE it was written
--   -- run 32454881949 section (G), which printed the live max, the outbox max
--   and the account-book max for all 27 live series.

CREATE TABLE IF NOT EXISTS scm.doc_number_counters (
  -- The doc number WITHOUT its `-NNN` tail. `HC-SO-2608`, `TRIP-2608`, `JE-2608`.
  series      text        PRIMARY KEY CHECK (length(series) > 0),
  -- The number the NEXT mint will hand out. Monotonic: it is only ever raised.
  next_n      integer     NOT NULL CHECK (next_n >= 1),
  -- What set this row where it is. On a money path "why is this series at 3?"
  -- must be answerable from the row, not from a commit message.
  seed_source text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE scm.doc_number_counters IS
  'The authority for document numbers. One row per series (the doc number without its -NNN tail). Minted by scm.next_doc_no_n, which only ever raises next_n -- deleting documents does NOT return their numbers. Gaps are expected and correct; see migration 0316 and docs/doc-number-reissue-coe.md.';

/* THE MINT. One statement, so two concurrent saves cannot read the same value:
   the second waits on the first's row lock and sees the incremented counter.

   p_floor is the highest suffix the caller found in the live rows. It is a
   BELT, not the counter: the answer is GREATEST(counter, floor + 1), so live
   rows can push the counter UP and can never pull it DOWN. That is what lets a
   series this migration never seeded (a table added later, a month with no
   rows) self-seed from its own live max on first use instead of restarting at
   001, and it is what makes the PostgREST 1000-row truncation trap documented
   in scm/lib/doc-no.ts unable to cause a re-issue any more -- a truncated read
   returns a LOW floor, and a low floor is now harmless.

   The one thing p_floor cannot know is the numbers that have LEFT this system.
   The account book holds those and the ERP has no row for them. That is what
   the seed below is for, and it is the only part of this that had to be written
   down from evidence rather than derived. */
CREATE OR REPLACE FUNCTION scm.next_doc_no_n(p_series text, p_floor integer)
RETURNS integer
LANGUAGE sql
VOLATILE
AS $fn$
  INSERT INTO scm.doc_number_counters AS c (series, next_n, seed_source)
  VALUES (
    p_series,
    GREATEST(COALESCE(p_floor, 0), 0) + 2,
    'self-seeded on first use from the live max (' || GREATEST(COALESCE(p_floor, 0), 0) || ')'
  )
  ON CONFLICT (series) DO UPDATE
     SET next_n     = GREATEST(c.next_n, GREATEST(COALESCE(p_floor, 0), 0) + 1) + 1,
         updated_at = now()
  RETURNING next_n - 1;
$fn$;

COMMENT ON FUNCTION scm.next_doc_no_n(text, integer) IS
  'Claim the next suffix for a document series, never below p_floor + 1. Atomic (INSERT .. ON CONFLICT .. RETURNING), monotonic, and the ONLY writer of next_n outside migration 0316 seed. Called by scm/lib/doc-no.ts mintMonthlyDocNo and nextJeNo.';

-- service_role only. It hands out document numbers; an anon caller able to burn
-- them could open a hole in the middle of a legally-numbered series at will.
REVOKE ALL ON FUNCTION scm.next_doc_no_n(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scm.next_doc_no_n(text, integer) TO service_role;

/* ── SEED 1 of 3: the surviving ERP rows ───────────────────────────────────
   Every column a minter owns, per series, max + 1. For every series that has
   live rows this reproduces EXACTLY today's next number, which is what makes
   "2990's series do not move" true by construction rather than by hope -- 2990
   was never wiped and none of its series appear in seed 3 below.

   Reference columns (an SO line, an audit row, an assr case naming its parent)
   are deliberately NOT in this list. They repeat their parent's number by
   design and some of them carry numbers minted by other systems entirely.

   A table or column this database does not have is SKIPPED, not an error: the
   pg test fixtures build a subset, and a migration that dies on a missing table
   blocks every migration after it. */
DO $seed1$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('scm', 'mfg_sales_orders',                'doc_no',         'SO'),
      ('scm', 'purchase_orders',                 'po_number',      'PO'),
      ('scm', 'delivery_orders',                 'do_number',      'DO'),
      ('scm', 'grns',                            'grn_number',     'GRN'),
      ('scm', 'purchase_invoices',               'invoice_number', 'PI'),
      ('scm', 'sales_invoices',                  'invoice_number', 'SI'),
      ('scm', 'payment_vouchers',                'pv_number',      'PV'),
      ('scm', 'delivery_returns',                'return_number',  'DR'),
      ('scm', 'purchase_returns',                'return_number',  'PRT'),
      ('scm', 'stock_takes',                     'take_no',        'STK'),
      ('scm', 'stock_transfers',                 'transfer_no',    'ST'),
      ('scm', 'trips',                           'trip_no',        'TRIP'),
      ('scm', 'consignment_sales_orders',        'doc_no',         'CS'),
      ('scm', 'consignment_delivery_orders',     'do_number',      'CN'),
      ('scm', 'consignment_delivery_returns',    'return_number',  'CRN'),
      ('scm', 'purchase_consignment_orders',     'pc_number',      'PCO'),
      ('scm', 'purchase_consignment_returns',    'return_number',  'PCT'),
      ('scm', 'purchase_consignment_receives',   'receive_number', 'PCR'),
      ('scm', 'journal_entries',                 'je_no',          'JE')
    ) AS t(sch, tbl, col, kind)
  LOOP
    CONTINUE WHEN to_regclass(format('%I.%I', r.sch, r.tbl)) IS NULL;
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = r.sch AND table_name = r.tbl AND column_name = r.col);
    EXECUTE format(
      $q$
      INSERT INTO scm.doc_number_counters AS c (series, next_n, seed_source)
      SELECT head, mx + 1, %L
        FROM (SELECT substring(%I from '^(.*)-[0-9]+$') AS head,
                     max((substring(%I from '-([0-9]+)$'))::int) AS mx
                FROM %I.%I
               WHERE %I ~ '^.+-[0-9]{4}-[0-9]{1,6}$'
               GROUP BY 1) s
       WHERE head IS NOT NULL
      ON CONFLICT (series) DO UPDATE
         SET next_n      = GREATEST(c.next_n, EXCLUDED.next_n),
             seed_source = CASE WHEN EXCLUDED.next_n > c.next_n
                                THEN EXCLUDED.seed_source ELSE c.seed_source END,
             updated_at  = now()
      $q$,
      format('mig 0316 seed 1: max surviving %s.%s.%s (%s)', r.sch, r.tbl, r.col, r.kind),
      r.col, r.col, r.sch, r.tbl, r.col);
  END LOOP;
END
$seed1$;

/* ── SEED 2 of 3: what the ERP remembers EXPORTING ─────────────────────────
   scm.autocount_outbox.doc_no is one row per intended export, and
   public.autocount_delivery_orders (migration 0215) is the ERP's own mirror of
   AutoCount's delivery-order headers -- pulled FROM the book, so a number in it
   is the book's word rather than ours. Measured on production 2026-08-21 (run
   32454881949): the mirror holds HC-DO-2608-001 and HC-DO-2608-002, which is a
   SECOND, re-derivable source for the two numbers seed 3 hardcodes for DO.

   Neither is complete, and the reason is the incident itself: the wipe's CLEAR
   list includes scm.autocount_outbox, so the 30 rows that existed before
   2026-08-20 are gone. Their backup was dumped to the runner by the apply that
   deleted them (run 32357340470) and never uploaded, because that run failed
   its post-commit verification and GitHub skips a later step on failure. So
   these two sources can only RAISE the seed, never complete it. */
DO $seed2$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('scm',    'autocount_outbox',          'doc_no', 'every number the ERP has tried to export'),
      ('public', 'autocount_delivery_orders', 'doc_no', 'AutoCount DO header mirror, migration 0215 -- pulled from the book')
    ) AS t(sch, tbl, col, why)
  LOOP
    CONTINUE WHEN to_regclass(format('%I.%I', r.sch, r.tbl)) IS NULL;
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = r.sch AND table_name = r.tbl AND column_name = r.col);
    EXECUTE format(
      $q$
      INSERT INTO scm.doc_number_counters AS c (series, next_n, seed_source)
      SELECT head, mx + 1, %L
        FROM (SELECT substring(%I from '^(.*)-[0-9]+$') AS head,
                     max((substring(%I from '-([0-9]+)$'))::int) AS mx
                FROM %I.%I
               WHERE %I ~ '^.+-[0-9]{4}-[0-9]{1,6}$'
               GROUP BY 1) s
       WHERE head IS NOT NULL
      ON CONFLICT (series) DO UPDATE
         SET next_n      = GREATEST(c.next_n, EXCLUDED.next_n),
             seed_source = CASE WHEN EXCLUDED.next_n > c.next_n
                                THEN EXCLUDED.seed_source ELSE c.seed_source END,
             updated_at  = now()
      $q$,
      format('mig 0316 seed 2: max %s.%s.%s -- %s', r.sch, r.tbl, r.col, r.why),
      r.col, r.col, r.sch, r.tbl, r.col);
  END LOOP;
END
$seed2$;

/* ── SEED 3 of 3: the numbers the ACCOUNT BOOK holds ───────────────────────
   THE ONLY HARDCODED PART, and the only part that had to be. AED_HOUZS is a
   second namespace the ERP cannot see, cannot wipe, and cannot re-derive: it
   permanently holds every number the ERP ever exported to it. Every value below
   is transcribed from backend/scripts/data/ac-live-proof.json, the repo's only
   record of what has actually reached the book, and each names its own entry.
   Nothing here is a margin, a rounding, or a guess -- the numbers are exactly
   the ones in that file and no higher.

   `2990-` series are ABSENT from this list on purpose. AED_HOUZS is the Houzs
   Century book; nothing 2990 mints has ever been written to it, so 2990's
   counters come from seed 1 alone and land on exactly the number they would
   have minted today.

   HC-GR-2608-001 is in ac-live-proof.json and is deliberately NOT seeded as a
   series: our GRN minter writes `HC-GRN-...` (scm.grns.grn_number), the book's
   number is `HC-GR-...`, and no minter in this system produces that string. A
   counter row for a series nothing mints is a row nobody reads.

   HC-GRN-2608 IS seeded, and it is the ONE value here that is not a book
   number. Say so plainly rather than let it read as one: what is evidenced is
   that the ERP ISSUED HC-GRN-2608-001 and QUEUED IT FOR EXPORT — measured
   read-only on production in run 32454881949 section (C), which found the
   number in both scm.grns.grn_number (created 2026-08-20T12:29:50Z) and
   scm.autocount_outbox.doc_no (12:29:51Z). Both rows were deleted by the
   2026-08-21 go-live wipe, so that run is now the only record of them. Whether
   the office host maps `HC-GRN-…` onto the book's `HC-GR-…` is UNKNOWN and this
   migration does not pretend otherwise; seeding to 2 costs one number and means
   a number already offered to the book is not offered a second time. If the
   answer turns out to be no, the cost was HC-GRN-2608-001 going unused. */
INSERT INTO scm.doc_number_counters AS c (series, next_n, seed_source) VALUES
  ('HC-SO-2608', 3, 'mig 0316 seed 3: AED_HOUZS holds HC-SO-2608-001 and -002 since 2026-08-14 (ac-live-proof.json proof.create_so; two outbox rows status=sent)'),
  ('HC-PO-2608', 2, 'mig 0316 seed 3: AED_HOUZS holds HC-PO-2608-001 since 2026-08-17 (ac-live-proof.json proof.so_to_po; attested by the /po-to-gr FullTransfer that named it as source)'),
  ('HC-DO-2608', 3, 'mig 0316 seed 3: AED_HOUZS holds HC-DO-2608-001 and -002 since 2026-08-17 (ac-live-proof.json proof.so_to_do; independently confirmed by public.autocount_delivery_orders, the DO mirror pulled from the book)'),
  ('HC-SI-2608', 2, 'mig 0316 seed 3: AED_HOUZS holds HC-SI-2608-001 since 2026-08-17 (ac-live-proof.json proof.do_to_iv; SELECT DocNo FROM IV returned it against 300-C002, Cancelled=F)'),
  ('HC-PI-2608', 2, 'mig 0316 seed 3: AED_HOUZS holds HC-PI-2608-001 since 2026-08-17 (ac-live-proof.json proof.gr_to_pi; POST /gr-to-pi answered with that docNo)'),
  ('HC-GRN-2608', 2, 'mig 0316 seed 3: NOT a book number. The ERP issued HC-GRN-2608-001 and queued it for export (run 32454881949 section C: scm.grns 2026-08-20T12:29:50Z, scm.autocount_outbox 12:29:51Z; both rows deleted by the 2026-08-21 wipe). The book holds HC-GR-2608-001 under a different string and whether the host maps one to the other is UNKNOWN')
ON CONFLICT (series) DO UPDATE
   SET next_n      = GREATEST(c.next_n, EXCLUDED.next_n),
       seed_source = CASE WHEN EXCLUDED.next_n > c.next_n
                          THEN EXCLUDED.seed_source
                          ELSE c.seed_source || ' | also: ' || EXCLUDED.seed_source END,
       updated_at  = now();

-- PostgREST caches the schema; nudge it so sb.rpc() resolves the new function
-- immediately after the deploy rather than at the next periodic reload.
NOTIFY pgrst, 'reload schema';
