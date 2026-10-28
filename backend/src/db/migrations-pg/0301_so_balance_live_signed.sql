-- 0301 — Let scm.mfg_sales_orders_with_payment_totals.balance_centi_live go
-- NEGATIVE when an order has been over-collected.
--
-- WHY. Over-collection is allowed as of 2026-08-16 (owner: 「需要可以超收
-- negative 边红色」). The SO DETAIL page already reports the signed figure —
-- it is computed in TypeScript (soBalanceCenti, scm/shared/so-outstanding.ts).
-- The SO LIST, the mobile list and delivery planning read this view instead,
-- and its GREATEST(..., 0) floor would keep showing a comfortable RM 0.00 on
-- exactly the orders the owner needs to see in red. Two surfaces disagreeing
-- about one customer's money is the failure this whole area keeps repeating.
--
-- BLAST RADIUS, measured rather than assumed. The view's minuend is
-- local_total_centi, which IS populated on the legacy AutoCount rows, so
-- un-flooring it exposes only genuine over-collections: 8 orders, RM 20,045
-- total across every company (probe-so-overpay.mjs, run 31938039273, section
-- 2). This is deliberately NOT the same rule as the detail page's, which
-- subtracts from total_revenue_centi — that column is 0 on 2,687 live orders
-- and needs the extra "known total" guard soBalanceCenti carries.
--
-- WHY THIS IS A DO BLOCK AND NOT A LITERAL CREATE OR REPLACE VIEW. The
-- deployed view and this repo's last written-out copy of it (0189) DISAGREE:
-- prod still projects so.processing_date, which 0189's body drops. Restating a
-- ~100-column view from the stale copy would either drop a live column or fail
-- outright ("cannot drop columns from view"), and 0189's own header records
-- what a migration that aborts costs here — the runner stops and NOTHING
-- merged after it reaches prod. So the new definition is derived from whatever
-- is actually deployed: read pg_get_viewdef, swap the one expression, put it
-- back. Column list, order and types are unchanged by construction.
--
-- REVERSAL: run the same DO block with `clamped` and `unclamped` swapped —
-- i.e. replace '(so.local_total_centi - COALESCE(p.paid_total, 0::bigint)) AS
-- balance_centi_live' with 'GREATEST(so.local_total_centi -
-- COALESCE(p.paid_total, 0::bigint), 0::bigint) AS balance_centi_live' and
-- CREATE OR REPLACE the view with the result. This touches NO table data — it
-- is a view expression only — so nothing is lost either way and the rollback is
-- exact. Note the ERP's own screens read the signed figure after this ships:
-- reverting the view without reverting soBalanceCenti puts the SO list and the
-- SO detail page back into disagreement on over-collected orders.
-- WHY THE CHECKS BELOW TEST FOR THE FLOOR'S ABSENCE RATHER THAN MATCHING THE
-- REPLACEMENT. First written, this migration wrote `unclamped` into the view
-- and then demanded that exact literal back from pg_get_viewdef. It failed on
-- every deploy from 2026-08-16 11:16Z, and pg-migrate stops at the first
-- failure, so nothing reached production for the rest of that afternoon.
--
-- CREATE OR REPLACE VIEW does not store the text it is handed: Postgres parses
-- it to a tree, and pg_get_viewdef DEPARSES that tree afresh. In pretty mode it
-- emits only the parentheses precedence requires, so the outer pair in
-- `(a - b) AS x` is dropped and the literal can never match. Measured on this
-- exact view, both spellings read from the live catalogue at the same moment
-- (why-0301-refuses.mjs, run against prod 2026-08-16):
--
--   pretty=false  GREATEST((so.local_total_centi - COALESCE(p.paid_total, (0)::bigint)), (0)::bigint) AS balance_centi_live
--   pretty=true   GREATEST(so.local_total_centi - COALESCE(p.paid_total, 0::bigint), 0::bigint) AS balance_centi_live
--
-- Same expression, same server, same instant: the redundant parentheses are
-- gone in the mode this migration reads. So the post-condition asserts what the
-- migration is actually FOR — that the GREATEST floor is no longer in the
-- deployed definition — plus that the column survived. That is not a weaker
-- guard than the original; the original could not pass at all.
DO $$
DECLARE
  cur  text;
  post text;
  next text;
  clamped   constant text :=
    'GREATEST(so.local_total_centi - COALESCE(p.paid_total, 0::bigint), 0::bigint) AS balance_centi_live';
  unclamped constant text :=
    '(so.local_total_centi - COALESCE(p.paid_total, 0::bigint)) AS balance_centi_live';
  /* How the deparser is expected to render `unclamped` once it has been through
     the parser. Used only to recognise an already-applied view, never asserted
     on: the point of the section above is that we do not get to dictate the
     spelling that comes back. */
  signed_bare constant text :=
    'so.local_total_centi - COALESCE(p.paid_total, 0::bigint) AS balance_centi_live';
BEGIN
  cur := pg_get_viewdef('scm.mfg_sales_orders_with_payment_totals'::regclass, true);

  /* Both spellings, for the same reason the post-condition takes neither on
     trust. Testing only for `unclamped` here made a re-run fall through to the
     "refusing to guess" branch below and abort a migration that had already
     done its job. */
  IF position(unclamped IN cur) > 0 OR position(signed_bare IN cur) > 0 THEN
    RAISE NOTICE '0301: balance_centi_live is already signed; nothing to do.';
    RETURN;
  END IF;

  /* Neither form present = the view is not the shape this migration was
     written against. Say so instead of silently leaving the floor in place:
     a no-op here would ship the owner a list that still reads RM 0.00 on an
     over-collected order, and nothing would have complained. */
  IF position(clamped IN cur) = 0 THEN
    RAISE EXCEPTION '0301: balance_centi_live matches neither the clamped nor the '
      'signed form — refusing to guess. Deployed definition:%  %', chr(10), cur;
  END IF;

  next := replace(cur, clamped, unclamped);
  EXECUTE 'CREATE OR REPLACE VIEW scm.mfg_sales_orders_with_payment_totals AS ' || next;

  /* Post-condition on the REPLACED view, read back from the catalogue — the
     EXECUTE succeeding only proves the SQL parsed. Two assertions, because
     "the floor is gone" alone would also be satisfied by a view that had lost
     the column altogether. */
  post := pg_get_viewdef('scm.mfg_sales_orders_with_payment_totals'::regclass, true);

  IF position(clamped IN post) > 0 THEN
    RAISE EXCEPTION '0301: rewrite reported success but the GREATEST floor is still '
      'in the deployed definition.';
  END IF;

  IF position('balance_centi_live' IN post) = 0 THEN
    RAISE EXCEPTION '0301: the rewrite dropped balance_centi_live from the view. '
      'Deployed definition:%  %', chr(10), post;
  END IF;
  RAISE NOTICE '0301: balance_centi_live is now signed (negative = over-collected).';
END $$;
