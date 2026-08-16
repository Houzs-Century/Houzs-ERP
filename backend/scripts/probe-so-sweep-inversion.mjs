#!/usr/bin/env node
/* Can the stock-allocation sweep's two id-chunked reads be INVERTED without
   changing the rows they return? READ-ONLY. Every statement below is a SELECT.

   WHY. probe-so-save-cost.mjs measured one global sweep at 123 serial
   Worker->PostgREST round trips on prod (run 31937764356, 2026-08-16). 89 of
   those 123 are three reads whose cost is set by the number of IDS chunked into
   them, not by the number of rows that come back:

     71  delivery_order_items  .in('so_item_id', <14,169 live SO-line ids>)  -> 83 rows
     18  purchase_order_items  .in('so_item_id', <3,520 bedframe/sofa ids>)
      6  mfg_sales_order_items .in('id', <1,123 sofa ids>) for allocated_batch_no

   The proposed inversion asks PostgREST for the same rows the other way round:
   start FROM mfg_sales_order_items (which already carries the live-SO filter as
   a one-level embedded filter, exactly as routes/mrp.ts:473 does) and pull the
   child rows through an `!inner` embed, so the id list never has to be
   enumerated in a URL at all.

   An inversion is only safe if the RESULT SET is identical, and that is a
   property of the DATA, not of the SQL — so it is asked here, of production,
   rather than reasoned about. Two things have to hold:

     1. the FOREIGN KEYS the embeds resolve through must exist (PostgREST can
        only embed along a real FK constraint; without one the request 400s);
     2. old-set MINUS new-set and new-set MINUS old-set must BOTH be empty.

   A count match is NOT a set match — this repo has paid for that distinction
   (`res.count` answered the wrong question three times, jsonb-double-encoding-coe).
   So the symmetric difference is computed row by row, and the counts are printed
   only as colour.

   RE-RUN: idempotent — it is a read. Running it twice changes nothing.

   node scripts/probe-so-sweep-inversion.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `FAIL ${m}`);

/* Byte-identical to backend/src/scm/shared/so-terminal-states.ts. Inlined as a
   SQL literal rather than bound: these are compile-time constants, and a bound
   text[] is exactly the parameter-inference shape that has produced 42883 on
   this database before. */
const TERMINAL = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT'];
const TERM = TERMINAL.map((s) => `'${s}'`).join(',');
const LIVE_SO = `s.status NOT IN (${TERM})`;

/* The sweep's step-2 line set, verbatim: non-cancelled lines of live SOs. Both
   the OLD and the NEW formulation below are expressed against THIS, because it
   is what `lineIds` in so-stock-allocation.ts:245 actually holds. */
const LIVE_LINES = `
  SELECT i.id, i.doc_no, i.item_group
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
   WHERE ${LIVE_SO} AND i.cancelled = false`;

const PAGE = 1000;   // paginate-all.ts PAGE
const CHUNK = 200;   // paginate-all.ts chunkIn default `size`
const pagesFor = (rows) => Math.floor(rows / PAGE) + 1;
const chunksFor = (ids) => Math.max(1, Math.ceil(ids / CHUNK));

let failures = 0;

async function one(query) { return (await sql.unsafe(query))[0]; }

/* Printed as each answer lands, never collected and printed at the end: the
   sibling probe died on step 4 and threw away three counts it had already got
   right. A number that has been measured must reach the log before the next
   statement can fail. */
async function count(label, query) {
  const t0 = Date.now();
  const n = Number((await one(query)).n);
  note(`  ${String(n).padStart(7)}  ${label}   [${Date.now() - t0} ms]`);
  return n;
}

async function symmetricDifference(label, oldSet, newSet) {
  const miss = Number((await one(
    `SELECT count(*)::int AS n FROM (${oldSet} EXCEPT ${newSet}) t`)).n);
  const extra = Number((await one(
    `SELECT count(*)::int AS n FROM (${newSet} EXCEPT ${oldSet}) t`)).n);
  if (miss === 0 && extra === 0) {
    note(`  IDENTICAL  ${label} — old EXCEPT new = 0, new EXCEPT old = 0`);
  } else {
    failures += 1;
    bad(`${label} — the inversion is NOT equivalent: ${miss} row(s) the old read returns and the new one does not, ${extra} the other way. DO NOT SHIP IT.`);
  }
  return { miss, extra };
}

async function main() {
  note(`=== SO sweep read inversion — ${new Date().toISOString()} (read-only) ===\n`);

  /* ── 1. The FKs the embeds resolve through ─────────────────────────────────
     PostgREST resolves `a!inner(b)` from a FOREIGN KEY, not from a matching
     column name. No constraint -> no embed -> a 400 in production. And MORE than
     one FK between the same pair is just as fatal in the other direction: the
     embed becomes ambiguous and has to be disambiguated by constraint name. */
  note('--- FOREIGN KEYS the proposed embeds need (PostgREST resolves embeds from these) ---');
  const fks = await sql.unsafe(`
    SELECT con.conname                       AS name,
           src.relname                       AS child_table,
           att.attname                       AS child_column,
           tgt.relname                       AS parent_table
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace ns ON ns.oid = src.relnamespace
      JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
     WHERE con.contype = 'f'
       AND ns.nspname = 'scm'
       AND src.relname IN ('delivery_order_items','purchase_order_items')
       AND att.attname IN ('so_item_id','delivery_order_id','purchase_order_id')
     ORDER BY src.relname, att.attname`);
  for (const f of fks) note(`  ${f.child_table}.${f.child_column} -> ${f.parent_table}   [${f.name}]`);
  const need = [
    ['delivery_order_items', 'so_item_id', 'mfg_sales_order_items'],
    ['purchase_order_items', 'so_item_id', 'mfg_sales_order_items'],
  ];
  for (const [t, col, parent] of need) {
    const hits = fks.filter((f) => f.child_table === t && f.child_column === col && f.parent_table === parent);
    if (hits.length === 1) note(`  OK        ${t}.${col} -> ${parent} is embeddable (exactly one FK)`);
    else if (hits.length === 0) { failures += 1; bad(`${t}.${col} has NO foreign key to ${parent} — PostgREST cannot embed it. The inversion that reads ${t} through an embed CANNOT ship.`); }
    else { failures += 1; bad(`${t}.${col} has ${hits.length} foreign keys to ${parent} — the embed is AMBIGUOUS and must name a constraint.`); }
  }

  /* ── 2. delivery_order_items: 71 chunked requests -> 1 embedded read ───────
     OLD (so-stock-allocation.ts:248): every live line id chunked 200 at a time
     into `.in('so_item_id', batch)`, then a SECOND read of delivery_orders to
     drop CANCELLED / DRAFT parents in JS (:259-273).
     NEW: FROM mfg_sales_order_items with the live-SO filter as a one-level
     embedded filter, pulling delivery_order_items through an `!inner` embed.
     Only the ACTIVE-parent rows are compared, because :277 discards the rest
     before anything downstream can see them. */
  note('\n--- delivery_order_items: is the inverted read the same set? ---');
  const OLD_DO = `
    SELECT d.id
      FROM scm.delivery_order_items d
      JOIN scm.delivery_orders o ON o.id = d.delivery_order_id
     WHERE d.so_item_id IN (SELECT id FROM (${LIVE_LINES}) l)
       AND upper(coalesce(o.status::text,'')) NOT IN ('CANCELLED','DRAFT')`;
  const NEW_DO = `
    SELECT d.id
      FROM (${LIVE_LINES}) l
      JOIN scm.delivery_order_items d ON d.so_item_id = l.id
      JOIN scm.delivery_orders o ON o.id = d.delivery_order_id
     WHERE upper(coalesce(o.status::text,'')) NOT IN ('CANCELLED','DRAFT')`;
  await count('rows the OLD read keeps (after its JS parent-status filter)',
    `SELECT count(*)::int AS n FROM (${OLD_DO}) t`);
  await count('rows the NEW embedded read returns',
    `SELECT count(*)::int AS n FROM (${NEW_DO}) t`);
  await symmetricDifference('delivery_order_items', OLD_DO, NEW_DO);
  const doParentLines = await count('live SO lines that HAVE a DO line (top-level rows the NEW read pages over)',
    `SELECT count(DISTINCT l.id)::int AS n FROM (${LIVE_LINES}) l
       JOIN scm.delivery_order_items d ON d.so_item_id = l.id`);
  const activeDos = await count('distinct DOs behind them (the surviving delivery_orders chunk)',
    `SELECT count(DISTINCT d.delivery_order_id)::int AS n FROM (${LIVE_LINES}) l
       JOIN scm.delivery_order_items d ON d.so_item_id = l.id`);

  /* Recorded for the record, NOT relied on. An earlier draft of this change
     planned to reach the same rows through delivery_orders.so_doc_no, which is
     only equivalent while every DO line's SO line sits on the SO its own DO
     header names. The shipped inversion does not depend on that, and this is
     the number that says whether it ever could have. */
  await count('DO lines whose SO line is NOT on the SO its DO header names (must be 0 for the so_doc_no route; the shipped route does not use it)',
    `SELECT count(*)::int AS n
       FROM scm.delivery_order_items d
       JOIN scm.mfg_sales_order_items i ON i.id = d.so_item_id
       JOIN scm.delivery_orders o ON o.id = d.delivery_order_id
      WHERE o.so_doc_no IS DISTINCT FROM i.doc_no`);

  /* ── 3. purchase_order_items: 18 chunked requests -> a paged embedded read ──
     OLD (:443): the bedframe/sofa line ids chunked 200 at a time. The JS then
     keeps only rows with received_qty > 0 (:452), so the comparison applies
     that filter to both sides — a row the caller throws away is not a
     difference. NEW drops the item_group narrowing entirely and filters it in
     JS instead (`dedicatedReady` is only ever read for bound lines), so the
     case-insensitive lower() the old code does in JS has nothing to match in
     SQL and cannot drift. */
  note('\n--- purchase_order_items: is the inverted read the same set? ---');
  const BOUND = `SELECT id FROM (${LIVE_LINES}) l WHERE lower(coalesce(l.item_group,'')) IN ('bedframe','sofa')`;
  /* Compared by PRIMARY KEY, not by the value tuple: EXCEPT is a SET operator,
     so two identical (so_item_id, qty, received_qty) rows would collapse into
     one and a lost duplicate would read as "identical". dedicatedReady SUMS
     these rows, so a duplicate is exactly what must not go missing. */
  const OLD_PO = `
    SELECT p.id
      FROM scm.purchase_order_items p
     WHERE p.so_item_id IN (${BOUND})
       AND coalesce(p.received_qty, 0) > 0`;
  const NEW_PO = `
    SELECT p.id
      FROM (${LIVE_LINES}) l
      JOIN scm.purchase_order_items p ON p.so_item_id = l.id
     WHERE coalesce(p.received_qty, 0) > 0
       AND lower(coalesce(l.item_group,'')) IN ('bedframe','sofa')`;
  await count('rows the OLD read contributes to dedicatedReady',
    `SELECT count(*)::int AS n FROM (${OLD_PO}) t`);
  await symmetricDifference('purchase_order_items (received_qty > 0)', OLD_PO, NEW_PO);
  const poParentLines = await count('live SO lines that HAVE a PO link (top-level rows the NEW read pages over)',
    `SELECT count(DISTINCT l.id)::int AS n FROM (${LIVE_LINES}) l
       JOIN scm.purchase_order_items p ON p.so_item_id = l.id`);
  const poParentLinesReceived = await count('  ... of those, with received_qty > 0 (if the server-side filter is kept)',
    `SELECT count(DISTINCT l.id)::int AS n FROM (${LIVE_LINES}) l
       JOIN scm.purchase_order_items p ON p.so_item_id = l.id
      WHERE coalesce(p.received_qty,0) > 0`);

  /* ── 4. allocated_batch_no: 6 chunked requests -> 0 ────────────────────────
     Not an inversion — the column simply moves into the step-2 select that
     already reads every one of these rows. Nothing to prove about the SET; what
     IS worth proving is that the forward-compat guard at :234 is now dead
     weight, i.e. the column exists. */
  note('\n--- allocated_batch_no: does the column the step-2 select would fold in exist? ---');
  const col = await one(`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema='scm' AND table_name='mfg_sales_order_items'
       AND column_name='allocated_batch_no'`);
  note(Number(col.n) === 1
    ? '  OK        scm.mfg_sales_order_items.allocated_batch_no exists (mig 0121 applied) — the second read is pure duplication'
    : '  ABSENT    allocated_batch_no is NOT on this database — the forward-compat retry is load-bearing, keep it');

  /* ── 5. What the sweep costs before and after, from THESE numbers ──────────*/
  note('\n--- SERIAL round trips for the three reads, from the counts above ---');
  const liveLines = await count('live SO lines (the id list the OLD reads chunk)',
    `SELECT count(*)::int AS n FROM (${LIVE_LINES}) t`);
  /* isBatchedLine, in SQL — the same union probe-so-save-cost.mjs uses. */
  const sofaLines = await count('sofa lines (the allocated_batch_no id list)', `
    SELECT count(*)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
     WHERE ${LIVE_SO} AND i.cancelled = false
       AND (upper(coalesce(i.item_group,'')) LIKE '%SOFA%'
            OR i.item_code IN (SELECT code FROM scm.mfg_products
                                WHERE upper(coalesce(category::text,'')) = 'SOFA'))`);
  const boundLines = await count('bedframe + sofa lines (the purchase_order_items id list)',
    `SELECT count(*)::int AS n FROM (${BOUND}) t`);

  const before = {
    'delivery_order_items (chunkIn every live line id)': chunksFor(liveLines),
    'delivery_orders (chunkIn DO ids)': chunksFor(activeDos),
    'purchase_order_items (chunkIn bedframe/sofa line ids)': chunksFor(boundLines),
    'mfg_sales_order_items allocated_batch_no (chunkIn sofa line ids)': chunksFor(sofaLines),
  };
  const after = {
    'delivery_order_items (paginateAll over the embedded read)': pagesFor(doParentLines),
    'delivery_orders (chunkIn DO ids)': chunksFor(activeDos),
    'purchase_order_items (paginateAll over the embedded read)': pagesFor(poParentLinesReceived),
    'mfg_sales_order_items allocated_batch_no (folded into step 2)': 0,
  };
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  note('');
  for (const k of Object.keys(before)) {
    note(`  ${String(before[k]).padStart(4)} -> ${String(after[k]).padStart(3)}   ${k}`);
  }
  note(`  ${String(sum(before)).padStart(4)} -> ${String(sum(after)).padStart(3)}   TOTAL for these four reads`);
  note(`  the other 27 round trips of the 123 (lock, orders, lines, products,`);
  note('  balances, lots) are unchanged, so one sweep goes'
    + ` ${123} -> ${123 - sum(before) + sum(after)} serial round trips.`);
  note(`  Unchanged: ${poParentLines} live lines carry a PO link, ${poParentLinesReceived} of them received.`);

  note('');
  if (failures > 0) { bad(`${failures} equivalence check(s) FAILED — the inversion changes what the sweep reads.`); }
  else note('  All equivalence checks passed: every inverted read returns exactly the old set.');

  await sql.end({ timeout: 5 });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });
