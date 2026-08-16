#!/usr/bin/env node
/* Which gate refuses a save on this Sales Order? Read-only.

   A salesperson reports "failed to save" and we cannot see which of the ~13
   guards on the edit path answered. Each guard asks a question the DATABASE can
   answer, so ask them all at once and print the inputs beside every verdict —
   the operator's screenshot only ever shows the LAST message, and the FE
   aborts its save chain on the first rejection, so the visible error is not
   necessarily the only one that would have fired.

   The order below is the order the routes actually run them in:

     POST /:docNo/items   (add a line)
       validateItemCodes(requireActive)  soHasDownstream  selfScopedSales
       soMainMixIntroduced  soProcessingLocked  soPoLocked  qty  allowed_options
     PATCH /:docNo/items/:id  (change a line)
       ... same locks, then the POS money floor:
       posTablet && newLineTotal < prevLineTotal  ->  422 so_total_below_original
     POST /:docNo/amendments
       soEditLocked must be TRUE, else 409 not_locked_no_amendment_needed

   Verdicts are printed WITH their inputs rather than asserted: this re-derives
   predicates that live in TypeScript, and a probe that agrees with itself while
   disagreeing with the server is worse than no probe. Compare the inputs.

   sessionOrigin (the posTablet hinge) lives in Cloudflare D1, NOT Postgres, so
   it is NOT readable here — see the note printed at the end.

   Writes nothing. DOC=2608-020 node scripts/probe-so-save-gates.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const DOCS = (process.env.DOC || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!DOCS.length) { console.error('need DOC="2608-020"'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (c) => (c == null ? '·' : (Number(c) / 100).toFixed(2));

/* soProcessingLocked, ported from routes/mfg-sales-orders.ts. "Today" is the
   Malaysian calendar date; locked STRICTLY AFTER the processing day. */
const TODAY_MY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
function processingLocked(h) {
  const proc = h.processing_date ?? null;
  if (!proc) return { locked: false, why: 'no processing_date — never date-locked' };
  const ymd = String(proc).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return { locked: false, why: `unparseable processing_date ${proc}` };
  if (!(ymd < TODAY_MY)) return { locked: false, why: `processing_date ${ymd} is not BEFORE today ${TODAY_MY}` };
  const status = String(h.status ?? '').toUpperCase();
  if (status) {
    const locked = status !== 'DRAFT' && status !== 'CANCELLED';
    return { locked, why: `processing_date ${ymd} < today ${TODAY_MY}, status ${status}` };
  }
  return { locked: Boolean(h.proceeded_at), why: `no status; proceeded_at=${h.proceeded_at ?? 'null'}` };
}

/* soPoLocked is 2990-ONLY (lib/so-po-lock.ts, owner 2026-08-12) — the test is
   the DOC-NUMBER PREFIX, not company_id. Houzs orders always answer false. */
const isMirroredDoc = (d) => /^2990-/.test(String(d));

async function main() {
  note(`\nToday (Malaysia) = ${TODAY_MY}`);

  for (const doc of DOCS) {
    note(`\n${'='.repeat(74)}\n=== ${doc} ===`);

    let heads = await sql`
      SELECT doc_no, company_id, status, revision,
             processing_date::text AS processing_date,
             proceeded_at::text AS proceeded_at,
             customer_delivery_date::text AS customer_delivery_date,
             salesperson_id::text AS salesperson_id,
             local_total_centi, deposit_centi
        FROM scm.mfg_sales_orders WHERE doc_no = ${doc}`;
    if (!heads.length) {
      heads = await sql`
        SELECT doc_no, company_id, status, revision,
               processing_date::text AS processing_date,
               proceeded_at::text AS proceeded_at,
               customer_delivery_date::text AS customer_delivery_date,
               salesperson_id::text AS salesperson_id,
               local_total_centi, deposit_centi
          FROM scm.mfg_sales_orders WHERE doc_no LIKE ${'%' + doc + '%'}
         ORDER BY doc_no LIMIT 10`;
      if (heads.length) note(`  (no exact doc_no; matched ${heads.length} by substring)`);
    }
    if (!heads.length) { note('  NO SUCH SALES ORDER'); continue; }

    for (const h of heads) {
      note(`\n  ${h.doc_no}  company=${h.company_id}  status=${h.status}  revision=${h.revision ?? '·'}`);
      note(`    processing_date  ${h.processing_date ?? '(null)'}`);
      note(`    proceeded_at     ${h.proceeded_at ?? '(null)'}`);
      note(`    delivery_date    ${h.customer_delivery_date ?? '(null)'}`);
      note(`    salesperson_id   ${h.salesperson_id ?? '(null)'}`);
      note(`    total            ${rm(h.local_total_centi)}   deposit ${rm(h.deposit_centi)}`);

      const lines = await sql`
        SELECT id::text AS id, line_no, item_code, item_group, qty, cancelled,
               unit_price_centi, discount_centi, total_centi, stock_status,
               variants::text AS variants
          FROM scm.mfg_sales_order_items
         WHERE doc_no = ${h.doc_no} AND company_id = ${h.company_id}
         ORDER BY line_no`;
      note(`\n    --- lines (${lines.length}) ---`);
      for (const l of lines) {
        note(`    ${String(l.line_no).padStart(2)}  ${String(l.item_code ?? '(none)').padEnd(34)} [${l.item_group ?? '-'}]`
           + ` qty=${l.qty} unit=${rm(l.unit_price_centi)} disc=${rm(l.discount_centi)} total=${rm(l.total_centi)}`
           + `${l.cancelled ? '  CANCELLED' : ''}`);
        note(`        variants ${(l.variants ?? '').slice(0, 160)}`);
      }

      /* ---- GATE 1: soHasDownstream (hard lock, blocks add AND amendment) ---- */
      const [dos, sis] = await Promise.all([
        sql`SELECT doc_no, status FROM scm.delivery_orders WHERE so_doc_no = ${h.doc_no}`,
        sql`SELECT doc_no, status FROM scm.sales_invoices  WHERE so_doc_no = ${h.doc_no}`,
      ]);
      const liveDo = dos.filter((r) => String(r.status).toUpperCase() !== 'CANCELLED');
      const liveSi = sis.filter((r) => String(r.status).toUpperCase() !== 'CANCELLED');
      note(`\n    GATE soHasDownstream  DO ${liveDo.length} live / ${dos.length} total`
         + `   SI ${liveSi.length} live / ${sis.length} total`);
      for (const r of [...dos, ...sis]) note(`        ${r.doc_no}  ${r.status}`);
      const hardLocked = liveDo.length > 0 || liveSi.length > 0;
      note(`      -> ${hardLocked ? 'HARD LOCKED — add-line 409, amendment 409' : 'open'}`);

      /* ---- GATE 2: soProcessingLocked ---- */
      const pl = processingLocked(h);
      note(`\n    GATE soProcessingLocked  ${pl.locked ? 'LOCKED' : 'open'}  (${pl.why})`);

      /* ---- GATE 3: soPoLocked (2990 doc-prefix only) ---- */
      const ids = lines.map((l) => l.id);
      let poRows = [];
      if (ids.length) {
        poRows = await sql`
          SELECT p.po_number, p.status, i.so_item_id::text AS so_item_id
            FROM scm.purchase_order_items i
            JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
           WHERE i.so_item_id = ANY(${ids}::uuid[])`;
      }
      const livePo = poRows.filter((r) => String(r.status).toUpperCase() !== 'CANCELLED');
      const mirrored = isMirroredDoc(h.doc_no);
      note(`\n    GATE soPoLocked  doc prefix 2990? ${mirrored ? 'YES' : 'NO — Houzs, this gate always answers false'}`);
      note(`      PO lines bound to this SO: ${poRows.length}  (live ${livePo.length})`);
      for (const r of poRows) note(`        ${r.po_number}  ${r.status}  so_item=${(r.so_item_id ?? '').slice(0, 8)}`);
      const poLocked = mirrored && livePo.length > 0;
      note(`      -> ${poLocked ? 'PO LOCKED' : 'open'}`);

      /* ---- The three doors ---- */
      const softLocked = pl.locked || poLocked;
      note(`\n    ===== VERDICT =====`);
      note(`    direct line edit / add : ${hardLocked ? 'REFUSED (downstream DO/SI)' : softLocked ? 'REFUSED 409 (soft lock — must amend)' : 'ALLOWED by the locks'}`);
      note(`    amendment route        : ${hardLocked ? 'REFUSED 409 (hard locked)' : softLocked ? 'ALLOWED' : 'REFUSED 409 not_locked_no_amendment_needed'}`);
      if (!hardLocked && !softLocked) {
        note(`    NOTE: neither lock is on, so a save that still failed was refused by a`);
        note(`          NON-lock gate — the POS money floor, allowed_options, variant`);
        note(`          completeness, an inactive item code, the write lease, or the`);
        note(`          FE's own pre-save checks. Those are listed below.`);
      }

      /* ---- Non-lock gates the DB can still answer ---- */
      const amendments = await sql`
        SELECT amendment_no, status, lane, created_at::text AS created_at
          FROM scm.so_amendments WHERE so_doc_no = ${h.doc_no}
         ORDER BY created_at DESC LIMIT 10`;
      note(`\n    so_amendments rows: ${amendments.length}`);
      for (const a of amendments) note(`        ${a.amendment_no}  ${a.status}  lane=${a.lane ?? '·'}  ${a.created_at?.slice(0, 19)}`);

      /* An add-line names a NEW code and validateItemCodes runs requireActive.
         Print the BEDFRAME catalog for this company so an inactive/missing code
         is visible as the reason a pick could not be saved. */
      const bf = await sql`
        SELECT code, name, active, category
          FROM scm.mfg_products
         WHERE company_id = ${h.company_id} AND upper(coalesce(category,'')) = 'BEDFRAME'
         ORDER BY active DESC, code LIMIT 40`;
      const inactive = bf.filter((r) => r.active === false);
      note(`\n    BEDFRAME catalog for company ${h.company_id}: ${bf.length} shown, ${inactive.length} INACTIVE`);
      note(`      (an add-line uses requireActive — an INACTIVE code 409s "unknown item code")`);
      for (const r of inactive.slice(0, 15)) note(`        INACTIVE  ${r.code}  ${r.name ?? ''}`);

      /* Variant completeness is enforced by the FE only when a processing date
         exists. Say so explicitly — it is the likeliest non-lock refusal for a
         freshly-added bedframe, which needs five attributes. */
      note(`\n    FE variant gate: processing_date is ${h.processing_date ? 'SET' : 'NULL'} ->`
         + ` a new BEDFRAME line ${h.processing_date ? 'MUST carry fabricCode, gap, divanHeight, legHeight, totalHeight before Save' : 'may be saved with variant gaps'}`);
    }
  }

  note(`\n${'='.repeat(74)}`);
  note(`sessionOrigin (the posTablet hinge for the money floor) lives in Cloudflare`);
  note(`D1 \`sessions.origin\`, not Postgres — this probe CANNOT read it. The only`);
  note(`writer of 'pos' is routes/pos.ts's PIN door, and every emitter of`);
  note(`"Changes cannot reduce the bill below the original sales order total" is`);
  note(`gated on it, so seeing that message IS the evidence the session is POS.`);
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });
