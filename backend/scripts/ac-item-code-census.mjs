#!/usr/bin/env node
/* ac-item-code-census.mjs — for EVERY supplier binding, what code would reach
   the account book, and does the book hold it?
   ===========================================================================

   PLAIN LANGUAGE (老板版):
   老板 2026-08-25:「确保全部 supplier 全部 SKU 进 AutoCount 都知道要开什么
   code」。这支工具**只读**：把每一笔 binding 丢进真正的解析器，印出「AutoCount
   会收到什么」以及「帐本认不认得」，按供应商分组，最后给一张总表。
   它不改任何东西，它是让我们知道缺口有多大的那张地图。

   ── WHY IT EXISTS ────────────────────────────────────────────────────────
   Every AutoCount failure this repo has fixed has the same shape: the ERP sent
   a code the book did not know, and nobody found out until a document was
   already stuck. The fixes are a hand-maintained list of refusals
   (ItemCodeError, MissingLocationError, Desc2TooLongError, MissingAgentError,
   MissingSalesLocationError, MissingCreditorError, KeylessLineError,
   SofaCollapseError) and every entry in it is a scar — added after a document
   failed in a licensed book.

   A list of past failures cannot tell you about the next one. This does the
   opposite: it asks the question for EVERY binding at once, before anything is
   sent, so the gap is a number on a page instead of a document stuck at 11pm.

   ── WHAT EACH ROW MEANS ──────────────────────────────────────────────────
     IN BOOK   the resolver returns a code AED_HOUZS already holds. Nothing to
               do; this line will land.
     WOULD OPEN the resolver returns a code the book does NOT hold, so
               /ensure-masters would create it. Not automatically wrong — that
               is how a genuinely new SKU arrives — but on an OLD product it
               means the ERP and the book disagree about what the thing is
               called, and ItemCode is what carries stock.
     REFUSED   the resolver will not answer. The document is refused before it
               is sent, with the reason printed here.

   ── READ-ONLY ────────────────────────────────────────────────────────────
   One SELECT. No writes, no SDK session, no host call. Safe on production and
   safe to run as often as you like.

   RE-RUN: idempotent by construction — it writes nothing. A second run just
     re-reads and prints the same census against whatever the data says then.
   =========================================================================== */
import postgres from 'postgres';
import { resolveAcItemCode, acItemIndex } from '../src/services/autocount-item-code.js';

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

/* A cap so one runaway supplier cannot bury the report. 0 = print every row. */
const PER_SUPPLIER = Number(process.env.ROWS_PER_SUPPLIER ?? 8);

const pg = postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 20 });
const index = acItemIndex();

try {
  notice(`account-book snapshot: ${index.rows} item(s), ${index.acCodes.size} distinct ItemCode(s)`);

  const rows = await pg`
    SELECT s.code AS supplier_code, s.name AS supplier_name,
           b.item_code, b.supplier_sku, b.material_kind
      FROM scm.supplier_material_bindings b
      JOIN scm.suppliers s ON s.id = b.supplier_id
     WHERE b.material_kind = 'mfg_product'
     ORDER BY s.code, b.item_code`;

  notice(`=== ${rows.length} binding row(s) across every supplier ===`);

  const bySup = new Map();
  const tally = { inBook: 0, wouldOpen: 0, refused: 0 };
  const refusalKinds = new Map();

  for (const r of rows) {
    const v = resolveAcItemCode(r.item_code, {
      supplierCode: r.supplier_code,
      index,
      bindings: new Map([[r.item_code.toUpperCase(), (r.supplier_sku ?? '').trim()]]),
    });
    let verdict, detail;
    if (!v.ok) {
      verdict = 'REFUSED'; detail = `${v.reason}: ${v.detail}`;
      tally.refused++;
      refusalKinds.set(v.reason, (refusalKinds.get(v.reason) ?? 0) + 1);
    } else if (index.acCodes.has(v.acItemCode.toUpperCase())) {
      verdict = 'IN BOOK'; detail = v.acItemCode; tally.inBook++;
    } else {
      verdict = 'WOULD OPEN'; detail = v.acItemCode; tally.wouldOpen++;
    }
    const key = `${r.supplier_code} — ${r.supplier_name}`;
    if (!bySup.has(key)) bySup.set(key, { rows: [], n: { 'IN BOOK': 0, 'WOULD OPEN': 0, REFUSED: 0 } });
    const g = bySup.get(key);
    g.n[verdict]++;
    g.rows.push({ itemCode: r.item_code, sku: r.supplier_sku, verdict, detail });
  }

  for (const [sup, g] of bySup) {
    notice(`${sup}   in-book ${g.n['IN BOOK']} / would-open ${g.n['WOULD OPEN']} / refused ${g.n.REFUSED}`);
    const show = PER_SUPPLIER > 0 ? g.rows.slice(0, PER_SUPPLIER) : g.rows;
    for (const x of show) {
      notice(`    ${x.verdict.padEnd(10)} ${x.itemCode}  sku=${JSON.stringify(x.sku)}  ->  ${x.detail}`);
    }
    /* NO SILENT TRUNCATION. A report that quietly showed the first eight and
       said nothing would read as "these are all of them". */
    if (PER_SUPPLIER > 0 && g.rows.length > PER_SUPPLIER) {
      notice(`    … ${g.rows.length - PER_SUPPLIER} more row(s) not printed (ROWS_PER_SUPPLIER=${PER_SUPPLIER}; set 0 for all)`);
    }
  }

  notice('=== TOTAL ===');
  notice(`  IN BOOK     ${tally.inBook}`);
  notice(`  WOULD OPEN  ${tally.wouldOpen}`);
  notice(`  REFUSED     ${tally.refused}`);
  for (const [kind, n] of refusalKinds) notice(`      refused/${kind}: ${n}`);
  notice(`  suppliers with at least one binding: ${bySup.size}`);
} finally {
  await pg.end({ timeout: 5 });
}
