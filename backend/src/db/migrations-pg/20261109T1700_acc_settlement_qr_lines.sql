-- 20261109T1700_acc_settlement_qr_lines.sql
-- DuitNow QR lines on a merchant report (owner 2026-11-09: 「这个hlbb merchant
-- 的0000PP 是qr direct 去bank 的，不算卡机的」 → 「A 照传，做」).
-- Hong Leong's QR merchant (00005992284) prints its QR payments in the card
-- layout: TENURE/CASHOUT* = DN, and 0000PP where a card's approval code sits.
-- The sale behind one is keyed Online and booked straight to the bank, so a QR
-- line is matched to that sale — never to card money — books nothing when it
-- is linked, and is no part of what the report owes through the acquirer's
-- clearing account.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   1. scm.acc_settlement_rows.channel — NULL for every existing line (card);
--      'QR' for a QR line. Nullable, no default: catalogue-only, no rewrite.
--   2. Hong Leong's layout (scm.acc_acquirer_config, code HLB) learns which
--      column says how a line was paid: column_map gains qr / qr_values. A
--      layout that already has them is left alone.
--   3. The QR lines already uploaded and still OPEN — HLB, reference 0000PP,
--      not confirmed, holding no payment, on a report no bank credit has been
--      booked against — become QR lines with no reference. On 2026-11-09 that
--      is 2990's six (rows 136, 847, 848, 851, 856, 857). Confirmed QR lines
--      (keyed as card, August–October) are the ledger's and are left as they
--      were booked.
--   4. Those lines' reports owe only their card lines: gross / fee / net (and
--      a stated net, were one printed) lose the QR lines' money. Only a report
--      with no bank credit booked against it; a second run finds the head
--      already card-only and changes nothing.
--   Nothing posts.
--
-- REVERSAL:
--   Revert the code first (acc/settlement-parse.ts, acc/settlement-match.ts,
--   acc/settlement.ts, acc/settlement-rematch.ts, acc/bank*.ts and
--   routes/accounting-settlement.ts / accounting-bank*.ts read this column).
--   UPDATE scm.acc_settlement_rows SET ref = '0000PP' WHERE channel = 'QR' AND ref IS NULL;
--   UPDATE scm.acc_settlement_batches b SET gross_sen = t.g, fee_sen = t.f, net_sen = t.n
--     FROM (SELECT batch_id, sum(gross_sen) g, sum(fee_sen) f, sum(net_sen) n FROM scm.acc_settlement_rows GROUP BY batch_id) t
--     WHERE b.id = t.batch_id AND b.id IN (SELECT batch_id FROM scm.acc_settlement_rows WHERE channel = 'QR');
--   UPDATE scm.acc_acquirer_config SET column_map = column_map - 'qr' - 'qr_values' WHERE code = 'HLB';
--   ALTER TABLE scm.acc_settlement_rows DROP CONSTRAINT IF EXISTS acc_settlement_row_channel;
--   ALTER TABLE scm.acc_settlement_rows DROP COLUMN IF EXISTS channel;
--   GRANTS: none — a column on an existing table rides that table's grants.

SET search_path = public, scm;

ALTER TABLE scm.acc_settlement_rows
  ADD COLUMN IF NOT EXISTS channel text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'acc_settlement_row_channel') THEN
    ALTER TABLE scm.acc_settlement_rows
      ADD CONSTRAINT acc_settlement_row_channel CHECK (channel IS NULL OR channel = 'QR');
  END IF;
END $$;

UPDATE scm.acc_acquirer_config
   SET column_map = column_map || jsonb_build_object('qr', 'TENURE/CASHOUT*', 'qr_values', 'DN,WC,WL')
 WHERE code = 'HLB'
   AND column_map IS NOT NULL
   AND NOT (column_map ? 'qr');

UPDATE scm.acc_settlement_rows r
   SET channel = 'QR', ref = NULL, updated_at = now()
 WHERE r.acquirer_code = 'HLB'
   AND upper(btrim(r.ref)) = '0000PP'
   AND r.channel IS NULL
   AND r.confirmed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM scm.acc_settlement_matches m WHERE m.settlement_row_id = r.id)
   AND NOT EXISTS (SELECT 1 FROM scm.acc_settlement_receipts x WHERE x.batch_id = r.batch_id);

UPDATE scm.acc_settlement_batches b
   SET gross_sen = t.card_gross,
       fee_sen = t.card_fee,
       net_sen = t.card_net,
       stated_net_sen = CASE WHEN b.stated_net_sen IS NULL THEN NULL ELSE b.stated_net_sen - t.qr_net END,
       updated_at = now()
  FROM (
    SELECT batch_id,
           coalesce(sum(gross_sen) FILTER (WHERE channel IS DISTINCT FROM 'QR'), 0) AS card_gross,
           coalesce(sum(fee_sen)   FILTER (WHERE channel IS DISTINCT FROM 'QR'), 0) AS card_fee,
           coalesce(sum(net_sen)   FILTER (WHERE channel IS DISTINCT FROM 'QR'), 0) AS card_net,
           coalesce(sum(net_sen)   FILTER (WHERE channel = 'QR'), 0)                AS qr_net
      FROM scm.acc_settlement_rows
     GROUP BY batch_id
    HAVING bool_or(channel = 'QR')
  ) t
 WHERE b.id = t.batch_id
   AND b.net_sen <> t.card_net
   AND NOT EXISTS (SELECT 1 FROM scm.acc_settlement_receipts x WHERE x.batch_id = b.id);
