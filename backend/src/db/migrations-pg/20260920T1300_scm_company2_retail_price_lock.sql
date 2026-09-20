-- 20260920T1300_scm_company2_retail_price_lock.sql
-- Company 2 (2990) RETAIL prices may only be authored by a writer that says so.
--
-- ─── WHAT WENT WRONG ──────────────────────────────────────────────────────
-- scm.mfg_products.seat_height_prices is ONE jsonb array carrying TWO
-- independent dimensions per (height, tier) slot:
--
--     { height: '24', tier: 'PRICE_1', priceSen: 51975, sellingPriceSen: 99000 }
--                                      └─ COST, ours    └─ RETAIL, 2990's POS
--
-- Nothing in the column's type separates them, so every writer of the COST side
-- rewrites the RETAIL side unless it merges. auto-derive-cost.ts
-- writeProductCost() does not merge — it assigns the whole array built by
-- sofaSeatRowsFromMatrix(), whose rows are {height, tier, priceSen} and never
-- carry sellingPriceSen.
--
-- The stage-4 backfill ran 2026-09-16 16:16-16:19 UTC over company 2 (144 SKUs)
-- and scm.app_config['scm.auto_derive_product_cost'] went ON at 16:19:59, after
-- which every supplier-price write repeated it. Measured 2026-09-20:
-- 269 retail slots expected (per scm.master_price_history), 76 survived,
-- 193 destroyed across 82 SKUs. Nothing was mis-priced — the values were
-- deleted, not corrupted — and all 193 were restored from the audit trail the
-- same day. The flag is OFF pending the writeProductCost() fix.
--
-- The flag row is company_id = 1. autoDeriveEnabled() reads it with NO company
-- filter, so a HOUZS stage-4 GO switched the mechanism on over 2990's
-- catalogue. Fixed separately in the same PR.
--
-- ─── WHY A TRIGGER AND NOT ONLY A CODE FIX ────────────────────────────────
-- The code fix stops THIS writer. The trigger stops the NEXT one. 2990's POS
-- SKU Master is the only surface that may author a retail price — that is the
-- owner's standing rule, not a preference — and the rule has to hold for
-- writers nobody has written yet: a bulk import, a one-off script, a future
-- derive stage. Those converge on this table, so this table is where the rule
-- belongs. Company 1 is NOT touched by any of this.
--
-- ─── THE CONTRACT: KEY PRESENCE IS INTENT ─────────────────────────────────
-- An UPDATE cannot say "I did not mean to touch this", so the trigger reads
-- whether the incoming slot carries the KEY:
--
--   · slot carries `sellingPriceSen`  → the writer meant it; its value wins,
--                                       including an explicit null (= cleared)
--   · slot omits the key              → not a retail writer; the stored retail
--                                       price is carried forward
--   · slot absent from the array      → a cost writer dropped it; the retail
--                                       slot is put back, selling-only
--
-- COST IS NEVER TOUCHED. priceSen rides through exactly as the writer sent it,
-- including a deletion — cost is Houzs's to own.
--
-- The 2990 POS upholds the other half: its grid writes an explicit
-- `sellingPriceSen: null` to clear and never deletes the key or drops the slot
-- (apps/pos/src/lib/products/seat-height-selling.ts, 2990s PR #796, deployed
-- 2026-09-20 BEFORE this migration). Readers already treat null and absent
-- alike — resolveSeatHeightSelling keeps a row only when sellingPriceSen is not
-- null — so a cleared slot reads as unpriced, never as a phantom 0.
--
-- ─── SCOPE, AND WHAT IS NOT COVERED ───────────────────────────────────────
-- Only the jsonb retail dimension is enforced. The flat retail columns
-- (sell_price_sen, pwp_price_sen) cannot be protected the same way: a scalar
-- UPDATE carries no "I did not mean to touch this" signal, and the POS writes
-- them through the same connection as everyone else. They were verified intact
-- on 2026-09-20 (97 + 9 values, 0 disagreeing with scm.master_price_history)
-- and nothing in this backend writes them outside PATCH /mfg-products/:id.
-- The durable answer for those is a writer identity the trigger can check —
-- a request header surfaced to Postgres via PostgREST's request.headers GUC —
-- at which point this function tightens from "carry forward" to "refuse".
-- Until then a daily sentinel catches drift by diffing the columns against
-- scm.master_price_history.
--
-- ─── IDEMPOTENT ───────────────────────────────────────────────────────────
-- Applied by hand to production 2026-09-20 ahead of this file landing, so the
-- runner will re-run it: every statement is CREATE OR REPLACE / IF NOT EXISTS /
-- DROP ... IF EXISTS, and re-running changes nothing.
--
-- ─── REVERSAL ─────────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS trg_mfg_products_retail_price_lock ON scm.mfg_products;
--   DROP FUNCTION IF EXISTS scm.mfg_products_retail_price_lock();
--   -- scm.retail_price_guard_log is evidence; keep it or drop it separately.

SET search_path = public, scm;

-- Every time the guard had to intervene: who sent what, and what was stored
-- instead. Empty is the healthy state — a row means some writer is still
-- rewriting 2990's retail prices and should be found and fixed.
CREATE TABLE IF NOT EXISTS scm.retail_price_guard_log (
  id                    bigserial PRIMARY KEY,
  at                    timestamptz NOT NULL DEFAULT now(),
  company_id            bigint      NOT NULL,
  item_code             text        NOT NULL,
  incoming              jsonb,
  stored                jsonb,
  applied               jsonb,
  slots_carried_forward integer     NOT NULL DEFAULT 0,
  slots_readded         integer     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_retail_price_guard_log_at
  ON scm.retail_price_guard_log (at DESC);

CREATE OR REPLACE FUNCTION scm.mfg_products_retail_price_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  merged  jsonb;
  carried integer := 0;
  readded integer := 0;
BEGIN
  -- 2990 only. Company 1's catalogue is governed by company 1.
  IF NEW.company_id IS DISTINCT FROM 2 THEN
    RETURN NEW;
  END IF;

  IF NEW.seat_height_prices IS NOT DISTINCT FROM OLD.seat_height_prices THEN
    RETURN NEW;
  END IF;

  IF OLD.seat_height_prices IS NULL
     OR jsonb_typeof(OLD.seat_height_prices) <> 'array' THEN
    RETURN NEW;                                   -- nothing stored to protect
  END IF;

  -- Cheap early-out: no stored retail price on this SKU, nothing to defend.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(OLD.seat_height_prices) AS e(elem)
    WHERE jsonb_typeof(e.elem->'sellingPriceSen') = 'number'
  ) THEN
    RETURN NEW;
  END IF;

  WITH old_slots AS (
    SELECT e.elem,
           e.elem->>'height'                 AS h,
           COALESCE(e.elem->>'tier', 'PRICE_2') AS t
    FROM jsonb_array_elements(OLD.seat_height_prices) AS e(elem)
  ),
  new_slots AS (
    SELECT e.ord,
           e.elem,
           e.elem->>'height'                 AS h,
           COALESCE(e.elem->>'tier', 'PRICE_2') AS t
    FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(NEW.seat_height_prices) = 'array'
                THEN NEW.seat_height_prices
                ELSE '[]'::jsonb END) WITH ORDINALITY AS e(elem, ord)
  ),
  kept AS (
    -- incoming slots: retail carried forward when the writer did not name it
    SELECT n.ord::numeric AS ord,
           CASE
             WHEN n.elem ? 'sellingPriceSen' THEN n.elem
             WHEN o.elem ? 'sellingPriceSen'
               THEN n.elem || jsonb_build_object('sellingPriceSen', o.elem->'sellingPriceSen')
             ELSE n.elem
           END AS elem,
           (NOT (n.elem ? 'sellingPriceSen') AND (o.elem ? 'sellingPriceSen')) AS did_carry
    FROM new_slots n
    LEFT JOIN old_slots o ON o.h = n.h AND o.t = n.t
  ),
  back AS (
    -- priced slots the incoming array dropped entirely: put the retail back
    SELECT (1000000 + row_number() OVER (ORDER BY o.h, o.t))::numeric AS ord,
           jsonb_build_object('height', o.h,
                              'tier',   o.t,
                              'sellingPriceSen', o.elem->'sellingPriceSen') AS elem,
           false AS did_carry
    FROM old_slots o
    WHERE jsonb_typeof(o.elem->'sellingPriceSen') = 'number'
      AND NOT EXISTS (SELECT 1 FROM new_slots n WHERE n.h = o.h AND n.t = o.t)
  ),
  u AS (
    SELECT ord, elem, did_carry, 'kept'::text AS src FROM kept
    UNION ALL
    SELECT ord, elem, did_carry, 'back'::text       FROM back
  )
  SELECT jsonb_agg(u.elem ORDER BY u.ord),
         COALESCE(count(*) FILTER (WHERE u.src = 'kept' AND u.did_carry), 0),
         COALESCE(count(*) FILTER (WHERE u.src = 'back'), 0)
    INTO merged, carried, readded
  FROM u;

  IF merged IS NULL THEN                          -- defensive: never blank the row
    RETURN NEW;
  END IF;

  IF merged IS DISTINCT FROM NEW.seat_height_prices THEN
    INSERT INTO scm.retail_price_guard_log
      (company_id, item_code, incoming, stored, applied,
       slots_carried_forward, slots_readded)
    VALUES
      (NEW.company_id, NEW.code, NEW.seat_height_prices, OLD.seat_height_prices,
       merged, carried, readded);
    NEW.seat_height_prices := merged;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_mfg_products_retail_price_lock ON scm.mfg_products;
CREATE TRIGGER trg_mfg_products_retail_price_lock
  BEFORE UPDATE OF seat_height_prices ON scm.mfg_products
  FOR EACH ROW
  EXECUTE FUNCTION scm.mfg_products_retail_price_lock();
