-- 0246 — `is_own_fleet` can no longer contradict `carrier_company_id`.
--
-- WHY. Owner, 2026-08-02, looking at MSJ TRANSPORT's card: "这个 OwnFleet Card
-- 为什么会叫 OwnFleet 呢? 如果是 OwnFleet 的话，当我在 create 这一个 3PL 的
-- company 的时候，我就会直接 create 掉了" and "我都点着这个... 我都开着这一间公司
-- 了，你还给我 3PL company 那边给我去选，那不是有问题吗?"
--
-- He is right, and the flag is worse than redundant. 0207 added it "so the
-- reconciliation view can label own-fleet vs 3PL" — a question
-- `carrier_company_id IS NULL` already answers. It was then stored, validated,
-- returned by the API and offered as a checkbox, and **never read** for any
-- behaviour: grep the backend and the only hits are the SELECT list, the
-- serializer and the two writers. Even the card list groups by
-- `carrierCompanyId == null`, not by this flag.
--
-- So the checkbox's only power was to make a card disagree with itself: MSJ
-- TRANSPORT's card, carrier_company_id set, ticked "Own-fleet card". Nothing
-- would have failed; the card would simply have described itself two ways.
--
-- FROM HERE THE FLAG IS DERIVED. The routes write it beside carrier_company_id
-- and never on its own; this migration makes that an invariant the database
-- keeps rather than a convention the next writer has to remember.
--
-- BACKFILL FIRST, THEN CONSTRAIN — the order matters. An existing row that
-- disagrees would fail the CHECK and, per the deploy model, block every later
-- migration. The UPDATE is unconditional, so nothing can be left behind.
--
-- WHAT THIS DOES NOT DO: drop the column. It is read by the API contract and by
-- the reconciliation view's labelling; a derived column that is honest is worth
-- more than a schema change that ripples through both. It stops being writable
-- independently, which is the whole complaint.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, one transaction.
-- RE-CHECK THE NUMBER AT MERGE — 0246 was next free above 0245.

SET search_path = scm, public;

UPDATE scm.delivery_rate_cards
   SET is_own_fleet = (carrier_company_id IS NULL)
 WHERE is_own_fleet IS DISTINCT FROM (carrier_company_id IS NULL);

ALTER TABLE scm.delivery_rate_cards
  DROP CONSTRAINT IF EXISTS delivery_rate_cards_own_fleet_derived;

ALTER TABLE scm.delivery_rate_cards
  ADD CONSTRAINT delivery_rate_cards_own_fleet_derived
  CHECK (is_own_fleet = (carrier_company_id IS NULL));
