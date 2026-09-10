// Read-only: does MRP's OWN supplier read lose a bound SKU, and where?
//
// Run under tsx (it imports the real chunk arithmetic from src):
//   npx tsx scripts/probe-mrp-supplier-map-loss.mjs
//
// THE QUESTION, NARROWED. `docs/bugs/0780` has already killed four explanations
// for "— none —" on a line whose product IS bound: the bindings are not missing
// (run 34447806315 — 71 rows, all mfg_product, all company 1), the two readers
// do not carry different predicates (same run), the codes are not mis-spelled
// (run 34454717897 — every line of HC-SO-013497/013495 matches on its EXACT
// string), and the ~1000-row PostgREST cap was fixed in the shared reader on
// 2026-08-19. What is left is MRP's own read: does `suppliersByCode` come back
// empty for a code whose rows demonstrably exist?
//
// WHY THE SNAPSHOT IS THE EVIDENCE, and not a re-run of the query. The MRP page
// serves `scm.mrp_snapshots.result` for the default view, and that row is the
// FROZEN OUTPUT of computeMrp — produced by the Worker, through the real
// supabase-js/PostgREST transport, with the real chunking and paging, every ~15
// minutes. Its `sofaSets[].suppliers` and `skus[].suppliers` are literally what
// `suppliersByCode` produced. So reading that jsonb answers "did the data reach
// the response intact?" WITHOUT PostgREST credentials, which this repository
// deliberately does not hold (docs/bugs/0433: probe-mrp-read-ceiling's REST half
// has never once run because SUPABASE_SERVICE_ROLE_KEY must never become an
// Actions secret here). `docs/bugs/0777` settled its own question the same way.
//
// A LIMIT WORTH STATING: the Sofa TAB asks for `?category=SOFA`, which is not
// the default view, so that tab computes live and does not read this row. The
// snapshot is still the right instrument — same function, same client, same
// read — but it is EVIDENCE ABOUT THE ENGINE, not a recording of the owner's
// request. Where the two could differ, this script says so rather than implying
// it watched his screen.
//
// WHAT IS PRINTED
//   1. the snapshot's age and size, so a stale row is never read as fresh;
//   2. every snapshot entry for the reported documents — item code, coverage,
//      and how many suppliers the engine attached;
//   3. the WHOLE snapshot, per item code: suppliers attached vs bindings that
//      exist, classified — LOST (bindings exist, none attached), PARTIAL,
//      SPLIT (the same code attached different counts on its own rows, which one
//      Map lookup cannot produce), STALE (more attached than exist), and
//      legitimately UNBOUND;
//   4. for anything LOST: when its bindings were created, so "added after he
//      looked" is refuted or confirmed rather than assumed;
//   5. the chunk arithmetic the shared reader would use over this snapshot's
//      code list — batch size, batch count, rows per batch against PAGE — so a
//      truncation is visible as a number instead of a theory.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer INCLUDING "no snapshot row" and "nothing is lost" — the
// ANSWER is the output, and a red job would read as "the check broke".
//
// RE-RUN: read-only and stateless.
//
//   DATABASE_URL   required
//   COMPANY_ID     default 1 (Houzs Century)
//   DOC_NOS        comma-separated sales orders to print line by line.
//                  Default: HC-SO-013497,HC-SO-013495
//   TOP            how many codes to list per class. Default 40
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { chunkSizeForUrl, PAGE } from '../src/scm/lib/paginate-all.ts';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
  process.exit(1);
}

const CO = Number(process.env.COMPANY_ID ?? 1);
const DOCS = (process.env.DOC_NOS ?? 'HC-SO-013497,HC-SO-013495')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TOP = Number(process.env.TOP ?? 40);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  log(`company=${CO}  documents printed line by line: ${DOCS.join(', ')}`);
  log('');

  // 1. The snapshot itself.
  const [snap] = await sql`
    SELECT to_char(computed_at, 'YYYY-MM-DD HH24:MI:SS') AS computed_txt,
           EXTRACT(EPOCH FROM (now() - computed_at))::int AS age_s,
           pg_column_size(result) AS bytes,
           COALESCE(jsonb_array_length(result->'skus'), -1) AS n_skus,
           COALESCE(jsonb_array_length(result->'sofaSets'), -1) AS n_sofa
      FROM scm.mrp_snapshots WHERE company_id = ${CO}`;
  if (!snap) {
    log(`scm.mrp_snapshots has NO row for company ${CO}.`);
    log('That is the finding: this company has never had a planning run stored, so');
    log('there is no frozen engine output to read and this script can say nothing');
    log('about the supplier map. Press Regenerate on the MRP page first, or run this');
    log('against a company that has one. Stopping — nothing is inserted.');
    await sql.end();
    process.exit(0);
  }
  log(`snapshot computed_at ${snap.computed_txt} UTC  (${Math.round(snap.age_s / 60)} min old)`);
  log(`  result jsonb ${snap.bytes} bytes  ·  skus ${snap.n_skus}  ·  sofaSets ${snap.n_sofa}`);
  log('');

  // 2. The reported documents, entry by entry.
  const docRows = await sql`
    SELECT s->>'soDocNo'   AS doc,
           s->>'itemCode'  AS code,
           s->>'variantLabel' AS vlabel,
           COALESCE((s->>'qty')::numeric, 0)         AS qty,
           COALESCE((s->>'shortageQty')::numeric, 0) AS shortage,
           s->>'poNumber'  AS po_number,
           s->>'poSupplierName' AS po_supplier,
           jsonb_array_length(COALESCE(s->'suppliers', '[]'::jsonb)) AS n_sup,
           (SELECT string_agg(x->>'name', ' | ' ORDER BY x->>'name')
              FROM jsonb_array_elements(COALESCE(s->'suppliers', '[]'::jsonb)) x) AS sup_names
      FROM scm.mrp_snapshots m, jsonb_array_elements(m.result->'sofaSets') s
     WHERE m.company_id = ${CO} AND s->>'soDocNo' = ANY(${DOCS})
     UNION ALL
    SELECT l->>'soDocNo',
           k->>'itemCode',
           k->>'variantLabel',
           COALESCE((l->>'qty')::numeric, 0),
           COALESCE((l->>'shortageQty')::numeric, 0),
           l->>'poNumber',
           l->>'poSupplierName',
           jsonb_array_length(COALESCE(k->'suppliers', '[]'::jsonb)),
           (SELECT string_agg(x->>'name', ' | ' ORDER BY x->>'name')
              FROM jsonb_array_elements(COALESCE(k->'suppliers', '[]'::jsonb)) x)
      FROM scm.mrp_snapshots m,
           jsonb_array_elements(m.result->'skus') k,
           jsonb_array_elements(COALESCE(k->'lines', '[]'::jsonb)) l
     WHERE m.company_id = ${CO} AND l->>'soDocNo' = ANY(${DOCS})
     ORDER BY 1, 2`;
  log(`snapshot rows for those documents: ${docRows.length}`);
  if (docRows.length === 0) {
    log('  NONE. Those documents carry no open demand in this planning run — so the');
    log('  engine put no row on the page for them at all, which is a different');
    log('  question from "the supplier cell is empty".');
  }
  for (const r of docRows) {
    const cover = r.po_number ? `PO ${r.po_number} (${r.po_supplier ?? 'no supplier name'})`
      : Number(r.shortage) > 0 ? `SHORT ${r.shortage}` : 'stock';
    log(`  ${r.doc}  ${r.code}  [${r.vlabel ?? 'no variant'}]  qty ${r.qty}  ${cover}`);
    log(`      suppliers the engine attached: ${r.n_sup}`
      + (r.n_sup > 0 ? `  -> ${r.sup_names}` : '   <-- a SHORT row like this renders "— none —"'));
  }
  log('');

  // 3. The whole snapshot, per item code.
  const perCode = await sql`
    WITH entries AS (
      SELECT s->>'itemCode' AS code,
             jsonb_array_length(COALESCE(s->'suppliers', '[]'::jsonb)) AS n,
             COALESCE((s->>'shortageQty')::numeric, 0) AS shortage
        FROM scm.mrp_snapshots m, jsonb_array_elements(m.result->'sofaSets') s
       WHERE m.company_id = ${CO}
       UNION ALL
      SELECT k->>'itemCode',
             jsonb_array_length(COALESCE(k->'suppliers', '[]'::jsonb)),
             COALESCE((k->>'shortage')::numeric, 0)
        FROM scm.mrp_snapshots m, jsonb_array_elements(m.result->'skus') k
       WHERE m.company_id = ${CO}
    ), per_code AS (
      SELECT code, MIN(n)::int AS mn, MAX(n)::int AS mx, COUNT(*)::int AS rows,
             SUM(CASE WHEN shortage > 0 THEN 1 ELSE 0 END)::int AS short_rows
        FROM entries WHERE code IS NOT NULL GROUP BY code
    ), bind AS (
      SELECT item_code, COUNT(*)::int AS n,
             to_char(MIN(created_at), 'YYYY-MM-DD') AS first_created,
             to_char(MAX(created_at), 'YYYY-MM-DD') AS last_created
        FROM scm.supplier_material_bindings
       WHERE company_id = ${CO} AND material_kind = 'mfg_product'
       GROUP BY item_code
    )
    SELECT p.code, p.mn, p.mx, p.rows, p.short_rows,
           COALESCE(b.n, 0) AS bindings, b.first_created, b.last_created
      FROM per_code p LEFT JOIN bind b ON b.item_code = p.code
     ORDER BY p.code`;

  const lost = perCode.filter((r) => r.bindings > 0 && r.mx === 0);
  const split = perCode.filter((r) => r.mn !== r.mx);
  const partial = perCode.filter((r) => r.mx > 0 && r.mx < r.bindings);
  const stale = perCode.filter((r) => r.mx > r.bindings);
  const unbound = perCode.filter((r) => r.bindings === 0 && r.mx === 0);
  const whole = perCode.filter((r) => r.bindings > 0 && r.mn === r.bindings && r.mx === r.bindings);

  log(`item codes in the snapshot: ${perCode.length}`);
  log(`  every binding attached (mn = mx = bindings):        ${whole.length}`);
  log(`  LOST — bindings exist, NONE attached:               ${lost.length}`);
  log(`  PARTIAL — some attached, fewer than exist:          ${partial.length}`);
  log(`  SPLIT — one code, different counts on its own rows: ${split.length}`);
  log(`  STALE — more attached than the table now holds:     ${stale.length}`);
  log(`  legitimately unbound (0 bindings, 0 attached):      ${unbound.length}`);
  log('');

  if (lost.length > 0) {
    const shortLost = lost.filter((r) => r.short_rows > 0);
    log(`CONFIRMED: ${lost.length} item code(s) carry bindings the engine did not attach.`);
    log(`${shortLost.length} of them have at least one SHORT row — a row the buyer cannot`);
    log('turn into a purchase order from this page.');
    log('');
    log('code                            attached  bindings  rows  short  bindings created');
    for (const r of lost.slice(0, TOP)) {
      log(`  ${String(r.code).padEnd(28)}  ${String(r.mx).padStart(8)}  ${String(r.bindings).padStart(8)}`
        + `  ${String(r.rows).padStart(4)}  ${String(r.short_rows).padStart(5)}  ${r.first_created}..${r.last_created}`);
    }
    if (lost.length > TOP) log(`  ... and ${lost.length - TOP} more (raise TOP to list them).`);
  } else {
    log('NOT REPRODUCED IN THE SNAPSHOT: every item code the engine planned carries every');
    log('binding that exists for it. So the engine\'s supplier read is whole in this');
    log('planning run, and an empty Supplier cell on screen did NOT come from this map');
    log('being short. That is a refutation, not a finding — look next at what the browser');
    log('is holding (the persisted react-query cache) and at the live compute path the');
    log('?category= tabs take, which does not read this row.');
  }
  log('');

  if (split.length > 0) {
    log(`${split.length} code(s) attached DIFFERENT counts on their own rows — one Map lookup`);
    log('cannot produce that, so a supplier list is being written per row somewhere it');
    log('should not be:');
    for (const r of split.slice(0, TOP)) {
      log(`  ${r.code}  min ${r.mn}  max ${r.mx}  over ${r.rows} row(s)  ·  bindings ${r.bindings}`);
    }
    log('');
  }
  if (partial.length > 0) {
    log(`${partial.length} code(s) attached FEWER suppliers than exist (the alternate a buyer`);
    log('picks from the dropdown is what goes missing first):');
    for (const r of partial.slice(0, TOP)) log(`  ${r.code}  attached ${r.mx}  ·  bindings ${r.bindings}`);
    log('');
  }
  if (stale.length > 0) {
    log(`${stale.length} code(s) attached MORE than the table now holds — bindings deleted since`);
    log('this run, i.e. a staleness signal about the snapshot, not a loss:');
    for (const r of stale.slice(0, TOP)) log(`  ${r.code}  attached ${r.mx}  ·  bindings now ${r.bindings}`);
    log('');
  }

  // 4. The chunk arithmetic, in numbers.
  const codes = perCode.map((r) => r.code);
  const size = chunkSizeForUrl(codes);
  const bindByCode = new Map(perCode.map((r) => [r.code, r.bindings]));
  const batches = [];
  for (let i = 0; i < codes.length; i += size) batches.push(codes.slice(i, i + size));
  const rowsPerBatch = batches.map((b) => b.reduce((n, c) => n + (bindByCode.get(c) ?? 0), 0));
  const over = rowsPerBatch.filter((n) => n > PAGE).length;
  log('the shared reader over THIS code list (lib/supplier-bindings.ts arithmetic):');
  log(`  codes ${codes.length}  ·  chunkSizeForUrl ${size}  ·  batches ${batches.length}  ·  PAGE ${PAGE}`);
  log(`  binding rows per batch: ${rowsPerBatch.join(', ')}`);
  log(`  batches that need a SECOND page: ${over}`);
  if (over === 0) {
    log('  So no batch reaches the response cap at all: every batch is one page, and a');
    log('  cap cannot be what empties a code here. It also could not produce THIS shape —');
    log('  the read orders is_main_supplier DESC first, so a truncation drops ALTERNATES');
    log('  before it ever drops a main.');
  }
} catch (err) {
  console.error(`query failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
