// ---------------------------------------------------------------------------
// retail-price-sentinel.mjs — the SQL and the verdict behind
// `node scripts/check-2990-retail-price-sentinel.mjs`.
//
// WHY THIS EXISTS. Company 2's (2990's) RETAIL prices are authored in a system
// that is not this one: their POS SKU Master writes them, we only ever write
// COST. On 2026-09-16 a cost mechanism deleted 193 of them and nobody here
// could have noticed — the loss was visible on their tablet, four days later,
// as sofas quoting RM 0. `trg_mfg_products_retail_price_lock` now stops that
// happening inside `seat_height_prices`, where "the writer did not name this
// slot" is a signal the trigger can read.
//
// The FLAT retail columns have no such signal. `sell_price_sen` and
// `pwp_price_sen` are plain scalars: an UPDATE that sets one to a wrong value
// looks exactly like an UPDATE that means to. So the flat columns are watched
// instead of locked, and this is the watcher.
//
// THE COMPARISON. `scm.master_price_history` is the audit trail of every
// hand-made price change — and, crucially, the auto-derive never writes it, so
// it survived the incident intact and was the source the 193 values were
// restored from. For each (item, field) its newest row is what a human last
// said the price should be. The live column should equal that. Where it does
// not, someone changed a retail price without going through the audited path.
//
// WHAT EACH VERDICT MEANS
//   missing      a price the history says exists is GONE from the row.
//                This is the 2026-09-16 shape exactly. ALARM.
//   disagreeing  the row holds a different number than the last audited one.
//                Either an unaudited edit or a partial overwrite. ALARM.
//   guard rows   `scm.retail_price_guard_log` is non-empty: the trigger had to
//                intervene, so some writer is STILL rewriting retail prices and
//                only the database is stopping it. ALARM — the writer should be
//                found and fixed, not left leaning on the guard.
//   derive ON    `scm.auto_derive_product_cost` is on for company 2. Their
//                catalogue must never be derived from our supplier prices.
//                ALARM.
//   unaudited    a live price with no history row behind it. NOT an alarm: a
//                hand repair (the 2026-09-20 restore) and a price older than
//                the audit trail both look like this. Reported so it can be
//                explained, never so it can cry wolf.
//
// WHAT IT CANNOT SEE, stated so a clean run is not over-read:
//   · a retail price that was wrong BEFORE its last audited change — this
//     compares against the audit trail, not against what the price should be;
//   · a wrong value written AND audited by the same actor;
//   · anything on a company other than the one passed in;
//   · `base_price_sen` / `price1_sen` / the `seat_height:` slots — those are
//     COST, ours to change, and deliberately out of scope.
//
// Every statement here is executed against real Postgres in
// tests-pg/retailPriceSentinel.pg.test.ts, including against planted damage,
// because a checker that has only ever seen a healthy database is not known to
// detect anything.
// ---------------------------------------------------------------------------

/** The retail fields that live in flat columns, and the column each one names. */
export const FLAT_FIELDS = [
  { field: 'sell_price_sen', column: 'sell_price_sen' },
  { field: 'pwp_price_sen', column: 'pwp_price_sen' },
];

/* The newest audited value per (item, seat slot), against the live jsonb.
   $1 = company id. Counts come from count(*) over the whole population, never
   from the length of a fetched page. */
export const SEAT_COUNTS_SQL = `
WITH newest AS (
  SELECT DISTINCT ON (h.item_code, h.field)
         h.item_code,
         split_part(h.field, ':', 2) AS slot,
         h.new_value_sen
    FROM scm.master_price_history h
   WHERE h.company_id = $1
     AND h.field LIKE 'seat_height_selling:%'
   ORDER BY h.item_code, h.field, h.changed_at DESC, h.id DESC
), expected AS (
  SELECT item_code,
         split_part(slot, '|', 1) AS height,
         split_part(slot, '|', 2) AS tier,
         new_value_sen AS want_sen
    FROM newest
   WHERE new_value_sen IS NOT NULL
), live AS (
  SELECT p.code AS item_code,
         e.elem->>'height' AS height,
         COALESCE(e.elem->>'tier', 'PRICE_2') AS tier,
         (e.elem->>'sellingPriceSen')::bigint AS have_sen
    FROM scm.mfg_products p
    CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(p.seat_height_prices) = 'array'
                THEN p.seat_height_prices ELSE '[]'::jsonb END) AS e(elem)
   WHERE p.company_id = $1
     AND jsonb_typeof(e.elem->'sellingPriceSen') = 'number'
)
SELECT
  (SELECT count(*) FROM scm.master_price_history h
     WHERE h.company_id = $1 AND h.field LIKE 'seat_height_selling:%')      AS history_rows,
  (SELECT count(*) FROM expected)                                          AS expected_slots,
  (SELECT count(*) FROM live)                                              AS live_slots,
  (SELECT count(*) FROM expected x
      LEFT JOIN live l USING (item_code, height, tier)
     WHERE l.item_code IS NULL)                                            AS missing,
  (SELECT count(*) FROM expected x
      JOIN live l USING (item_code, height, tier)
     WHERE l.have_sen IS DISTINCT FROM x.want_sen)                         AS disagreeing,
  (SELECT count(*) FROM live l
      LEFT JOIN expected x USING (item_code, height, tier)
     WHERE x.item_code IS NULL)                                            AS unaudited
`;

/* Every offending seat slot, so the alarm can name one. Unbounded on purpose:
   the healthy answer is zero rows, and a real incident is a few hundred. */
export const SEAT_OFFENDERS_SQL = `
WITH newest AS (
  SELECT DISTINCT ON (h.item_code, h.field)
         h.item_code,
         split_part(h.field, ':', 2) AS slot,
         h.new_value_sen
    FROM scm.master_price_history h
   WHERE h.company_id = $1
     AND h.field LIKE 'seat_height_selling:%'
   ORDER BY h.item_code, h.field, h.changed_at DESC, h.id DESC
), expected AS (
  SELECT item_code,
         split_part(slot, '|', 1) AS height,
         split_part(slot, '|', 2) AS tier,
         new_value_sen AS want_sen
    FROM newest
   WHERE new_value_sen IS NOT NULL
), live AS (
  SELECT p.code AS item_code,
         e.elem->>'height' AS height,
         COALESCE(e.elem->>'tier', 'PRICE_2') AS tier,
         (e.elem->>'sellingPriceSen')::bigint AS have_sen
    FROM scm.mfg_products p
    CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(p.seat_height_prices) = 'array'
                THEN p.seat_height_prices ELSE '[]'::jsonb END) AS e(elem)
   WHERE p.company_id = $1
     AND jsonb_typeof(e.elem->'sellingPriceSen') = 'number'
)
SELECT 'missing' AS kind, x.item_code, x.height, x.tier, x.want_sen, NULL::bigint AS have_sen
  FROM expected x LEFT JOIN live l USING (item_code, height, tier)
 WHERE l.item_code IS NULL
UNION ALL
SELECT 'disagreeing', x.item_code, x.height, x.tier, x.want_sen, l.have_sen
  FROM expected x JOIN live l USING (item_code, height, tier)
 WHERE l.have_sen IS DISTINCT FROM x.want_sen
 ORDER BY 1, 2, 3, 4
`;

/* The same comparison for the flat retail columns. The column is chosen by the
   field name in SQL rather than by interpolating an identifier, so no part of
   this string is ever built from data. */
export const FLAT_COUNTS_SQL = `
WITH newest AS (
  SELECT DISTINCT ON (h.item_code, h.field) h.item_code, h.field, h.new_value_sen
    FROM scm.master_price_history h
   WHERE h.company_id = $1
     AND h.field IN ('sell_price_sen', 'pwp_price_sen')
   ORDER BY h.item_code, h.field, h.changed_at DESC, h.id DESC
), paired AS (
  SELECT n.field, n.item_code, n.new_value_sen AS want_sen, p.code AS live_code,
         CASE n.field WHEN 'sell_price_sen' THEN p.sell_price_sen
                      WHEN 'pwp_price_sen'  THEN p.pwp_price_sen END AS have_sen
    FROM newest n
    LEFT JOIN scm.mfg_products p ON p.code = n.item_code AND p.company_id = $1
)
SELECT field,
       count(*)                                                   AS audited_skus,
       count(*) FILTER (WHERE live_code IS NULL)                   AS sku_gone,
       count(*) FILTER (WHERE live_code IS NOT NULL
                          AND want_sen IS NOT NULL
                          AND have_sen IS NULL)                    AS missing,
       count(*) FILTER (WHERE live_code IS NOT NULL
                          AND have_sen IS NOT NULL
                          AND have_sen IS DISTINCT FROM want_sen)  AS disagreeing
  FROM paired
 GROUP BY field
 ORDER BY field
`;

export const FLAT_OFFENDERS_SQL = `
WITH newest AS (
  SELECT DISTINCT ON (h.item_code, h.field) h.item_code, h.field, h.new_value_sen
    FROM scm.master_price_history h
   WHERE h.company_id = $1
     AND h.field IN ('sell_price_sen', 'pwp_price_sen')
   ORDER BY h.item_code, h.field, h.changed_at DESC, h.id DESC
), paired AS (
  SELECT n.field, n.item_code, n.new_value_sen AS want_sen, p.code AS live_code,
         CASE n.field WHEN 'sell_price_sen' THEN p.sell_price_sen
                      WHEN 'pwp_price_sen'  THEN p.pwp_price_sen END AS have_sen
    FROM newest n
    LEFT JOIN scm.mfg_products p ON p.code = n.item_code AND p.company_id = $1
)
SELECT CASE WHEN have_sen IS NULL THEN 'missing' ELSE 'disagreeing' END AS kind,
       field, item_code, want_sen, have_sen
  FROM paired
 WHERE live_code IS NOT NULL
   AND want_sen IS NOT NULL
   AND have_sen IS DISTINCT FROM want_sen
 ORDER BY 2, 3
`;

/* The trigger's own record. Guarded by to_regclass so this runs on a database
   where the migration has not been applied — it then says so rather than
   crashing, and rather than an absent table reading as "no interventions". */
export const GUARD_LOG_SQL = `
SELECT to_regclass('scm.retail_price_guard_log') IS NOT NULL AS present
`;

export const GUARD_ROWS_SQL = `
SELECT at, item_code, slots_carried_forward, slots_readded
  FROM scm.retail_price_guard_log
 WHERE company_id = $1
 ORDER BY at DESC
`;

export const GUARD_COUNT_SQL = `
SELECT count(*) AS rows, max(at) AS newest
  FROM scm.retail_price_guard_log
 WHERE company_id = $1
`;

/* Which companies have the cost auto-derive switched on. The flag is per
   company (it was read WITHOUT a company predicate until 2026-09-20, which is
   how one company's decision reached another's catalogue). */
export const DERIVE_FLAG_SQL = `
SELECT company_id, value
  FROM scm.app_config
 WHERE key = 'scm.auto_derive_product_cost'
 ORDER BY company_id
`;

/** Is a flag value ON? Same reading as autoDeriveEnabled(): on/1/true, nothing else. */
export const flagIsOn = (value) => ['on', '1', 'true'].includes(String(value ?? '').trim().toLowerCase());

/**
 * The verdict, as a pure function of what the queries returned, so the decision
 * can be tested without a database and the CLI holds no judgement of its own.
 *
 * `alarms` is what makes the run fail; `notes` is what a reader needs to make
 * sense of it. A verdict over an EMPTY population is refused outright: if this
 * company has no audited retail history at all, the comparison had nothing to
 * compare and "clean" would be a lie.
 */
export function verdict({ companyId, seat, flat, guard, flags }) {
  const alarms = [];
  const notes = [];

  if (Number(seat.history_rows) === 0) {
    alarms.push(
      `no audited retail history for company ${companyId} — scm.master_price_history has 0 'seat_height_selling:' rows, ` +
        'so this check had nothing to compare. That is a broken sentinel, not a clean database.',
    );
  }

  if (Number(seat.missing) > 0) {
    alarms.push(
      `${seat.missing} seat retail price(s) the audit trail says exist are GONE from scm.mfg_products — ` +
        'this is the 2026-09-16 shape. Restore from master_price_history and find the writer.',
    );
  }
  if (Number(seat.disagreeing) > 0) {
    alarms.push(
      `${seat.disagreeing} seat retail price(s) hold a different value than the last audited change — ` +
        'someone wrote a retail price outside the POS SKU Master.',
    );
  }
  if (Number(seat.unaudited) > 0) {
    notes.push(
      `${seat.unaudited} live seat retail price(s) have no history row behind them (a hand repair or a price older ` +
        'than the audit trail). Not an alarm; worth being able to explain.',
    );
  }

  for (const row of flat) {
    if (Number(row.missing) > 0) {
      alarms.push(`${row.missing} SKU(s) lost their audited ${row.field}.`);
    }
    if (Number(row.disagreeing) > 0) {
      alarms.push(`${row.disagreeing} SKU(s) hold a ${row.field} that no audited change accounts for.`);
    }
    if (Number(row.sku_gone) > 0) {
      notes.push(`${row.sku_gone} SKU(s) with ${row.field} history no longer exist on company ${companyId}.`);
    }
  }

  if (!guard.present) {
    notes.push(
      'scm.retail_price_guard_log is not present, so the trigger leg was not checked — ' +
        'migration 20260920T1300 has not been applied to this database.',
    );
  } else if (Number(guard.rows) > 0) {
    alarms.push(
      `scm.retail_price_guard_log has ${guard.rows} row(s) (newest ${guard.newest}): the database had to put a retail ` +
        'price back. Some writer is still rewriting them and is only being stopped by the guard.',
    );
  }

  for (const f of flags) {
    if (Number(f.company_id) === Number(companyId) && flagIsOn(f.value)) {
      alarms.push(
        `scm.auto_derive_product_cost is '${f.value}' for company ${companyId}. Their catalogue must never be derived ` +
          'from our supplier prices.',
      );
    }
  }

  return { ok: alarms.length === 0, alarms, notes };
}
