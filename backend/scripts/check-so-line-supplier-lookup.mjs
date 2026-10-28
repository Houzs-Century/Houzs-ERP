// Read-only: why does ONE line of a sales order find its supplier and the line
// beside it, same order and same model, read "— none —"?
//
// The owner, 2026-09-10, with the screen in front of him. On HC-SO-013497 all
// four pieces are 9058 with the same fabric, and two of them show HOOKKA
// INDUSTRIES while `9058-1NA` twice shows nothing:
//
//   9058-L(LHF)  · HR805-90 / SEAT 30 / SPECIAL: ...  -> HOOKKA INDUSTRIES
//   9058-1NA     · HR805-90 / SEAT 30                 -> — none —
//   9058-1NA     · HR805-90 / SEAT 30                 -> — none —
//   9058-1A(RHF) · HR805-90 / SEAT 30                 -> HOOKKA INDUSTRIES
//
// TWO EXPLANATIONS ARE ALREADY DEAD, so this script does not re-chase them.
// `check-supplier-binding-visibility.mjs` (run 34447806315) proved every one of
// the 17 `9058-*` products carries bindings, all `material_kind=mfg_product`,
// all company 1, all with exactly one main supplier and no orphaned supplier
// row — 71 rows, and both readers would return all 71. And the ~1000-row
// PostgREST cap was fixed in the shared reader on 2026-08-19.
//
// WHAT IS LEFT, and it is what this measures. MRP fills its supplier map from
// `suppliersByCode.get(d.item_code)` — the demand row's OWN item_code string,
// matched against the binding's `item_code` string. An exact match. So a line
// whose code differs by CASE, by a trailing space, or by any invisible
// character finds nothing while the product page, reached by product id, shows
// everything. The catalogue is already known to hold case-twins: the same probe
// found `9058-Console` AND `9058-CONSOLE`, two products, same description,
// different main suppliers.
//
// So this prints, for the lines of one or more sales orders: the item_code as
// stored, its LENGTH, its bytes where they are not plain ASCII, whether a
// binding exists for that exact string, and whether one exists for its
// case-folded / trimmed form. If a line matches only after folding, that IS the
// answer. If it matches exactly and MRP still shows none, the answer is
// elsewhere and this script says so instead of implying it found something.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer including "no such document" — that is a finding, not a
// failure. RE-RUN: read-only and stateless.
//
//   DATABASE_URL   required
//   DOC_NOS        comma-separated sales-order doc numbers.
//                  Default: HC-SO-013497,HC-SO-013495
//   COMPANY_ID     default 1
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

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
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/** Show a string the way a matcher sees it: length, and any byte outside plain ASCII. */
const reveal = (s) => {
  if (s == null) return 'NULL';
  const odd = [...s].filter((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126);
  const tail = odd.length
    ? `  ODD BYTES: ${odd.map((ch) => 'U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ')}`
    : '';
  return `"${s}" len=${s.length}${tail}`;
};

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  log(`company=${CO}  documents: ${DOCS.join(', ')}`);
  log('');

  const lines = await sql`
    SELECT i.doc_no, i.item_code, i.item_group, i.qty, i.cancelled,
           o.status::text AS status
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no AND o.company_id = i.company_id
     WHERE i.company_id = ${CO} AND i.doc_no = ANY(${DOCS})
     ORDER BY i.doc_no, i.item_code`;
  log(`sales-order lines found: ${lines.length}`);
  if (lines.length === 0) {
    log('NONE. Either those doc numbers are spelled differently or they belong to');
    log('another company. That is the finding — stop here.');
  }

  const codes = [...new Set(lines.map((l) => l.item_code).filter(Boolean))];

  /* The binding side, by EXACT code — the same match MRP makes. */
  const exact = await sql`
    SELECT b.item_code, COUNT(*)::int AS n
      FROM scm.supplier_material_bindings b
     WHERE b.company_id = ${CO} AND b.material_kind = 'mfg_product'
       AND b.item_code = ANY(${codes})
     GROUP BY b.item_code`;
  const exactBy = new Map(exact.map((r) => [r.item_code, r.n]));

  /* The same question with case and surrounding space taken out. A line that
     matches HERE and not above is the whole answer. */
  const folded = await sql`
    SELECT lower(btrim(b.item_code)) AS folded,
           COUNT(*)::int AS n,
           STRING_AGG(DISTINCT b.item_code, ' | ') AS spellings
      FROM scm.supplier_material_bindings b
     WHERE b.company_id = ${CO} AND b.material_kind = 'mfg_product'
       AND lower(btrim(b.item_code)) = ANY(${codes.map((c) => c.trim().toLowerCase())})
     GROUP BY 1`;
  const foldedBy = new Map(folded.map((r) => [r.folded, r]));

  /* And whether the product itself exists under that exact code — a line whose
     code is in no catalogue at all is a different defect from a case twin. */
  const prods = await sql`
    SELECT code FROM scm.mfg_products
     WHERE company_id = ${CO} AND code = ANY(${codes})`;
  const prodSet = new Set(prods.map((p) => p.code));

  log('');
  log('LINE                                        exact  folded  in catalogue');
  const suspects = [];
  for (const l of lines) {
    const code = l.item_code ?? '';
    const e = exactBy.get(code) ?? 0;
    const f = foldedBy.get(code.trim().toLowerCase());
    const inCat = prodSet.has(code);
    log(`  ${l.doc_no}  ${reveal(code)}`);
    log(`      bindings on the EXACT string: ${e}`
      + `   ·  ignoring case+space: ${f ? f.n : 0}`
      + `   ·  product exists under that exact code: ${inCat ? 'yes' : 'NO'}`);
    if (f && f.spellings && f.spellings !== code) {
      log(`      the bindings are spelled: ${f.spellings}`);
    }
    if (e === 0 && f && f.n > 0) suspects.push({ line: l, f });
    else if (e === 0) suspects.push({ line: l, f: null });
  }

  log('');
  if (suspects.length === 0) {
    log('EVERY line matches a binding on its exact string. So the empty supplier');
    log('column is NOT a code-spelling mismatch, and this script has ruled that');
    log('out rather than found anything. Look next at the response itself — what');
    log('`suppliers` carries for that line — and at the sofa SET grouping, which');
    log('takes its supplier list from the first set in the group.');
  } else {
    const twins = suspects.filter((s) => s.f && s.f.n > 0);
    const orphans = suspects.filter((s) => !s.f || s.f.n === 0);
    if (twins.length > 0) {
      log(`ANSWERED for ${twins.length} line(s): the binding EXISTS but under a`);
      log('differently-spelled code, so the exact match MRP makes finds nothing');
      log('while the product page, reached by id, shows everything:');
      for (const s of twins) {
        log(`  ${s.line.doc_no}  line=${reveal(s.line.item_code)}  bindings on: ${s.f.spellings}`);
      }
    }
    if (orphans.length > 0) {
      log(`${orphans.length} line(s) have NO binding under any spelling — a`);
      log('different problem, and a real one: nothing to raise a purchase order from.');
      for (const s of orphans) log(`  ${s.line.doc_no}  ${reveal(s.line.item_code)}`);
    }
  }
} catch (err) {
  console.error(`query failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
