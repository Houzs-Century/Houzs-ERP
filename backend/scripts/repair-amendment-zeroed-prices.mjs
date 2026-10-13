#!/usr/bin/env node
/* SO lines whose sell price was zeroed by a SKU-swap amendment. Find them,
   show them, restore the price the snapshot proves they had — and carry the
   corrected figure onto the delivery and invoice lines built from them.

   WHAT HAPPENED. The amendment editor seeds a SPEC line's new_unit_price_sen
   from the catalogue sell price of the new SKU. A SKU with no catalogue price
   seeds 0; nobody types it, the approver sees a spec change, and
   applySoAmendment (so-revision.ts) trusts the approved figure over the
   catalogue — so the line is written at RM 0 with its totals, the SO header
   rolls up without it, and a DO and SI issued afterwards copy the 0. On
   HC-SO-013490 the line went 850000 -> 0 on 2026-09-11, HC-DO-2610-006 and
   HC-SI-2610-103 were issued at RM 0, and the 0 reached AutoCount.

   WHAT THIS DOES, per SO line the selection in lib/amendment-zeroed-prices.mjs
   returns (applied amendment, SPEC change, snapshot price > 0, requested
   price 0, line still 0):
     1. restores unit_price_sen from the amendment's old_snapshot and recomputes
        total_sen / total_inc_sen / balance_sen / line_margin_sen the way the
        apply engine does;
     2. re-rolls the SO header through the app's OWN recomputeTotals
        (routes/mfg-sales-orders.ts) over lib/pgrest-shim.mjs — no header
        arithmetic lives here;
     3. bumps the header version and writes one mfg_so_audit_log row
        (UPDATE_LINE, source script, note naming the amendment);
     4. for every live Delivery Order line built from it: price, line total and
        margin, then the DO header through recomputeDoTotals, with an entity
        audit row — the same three steps the DO line PATCH performs;
     5. for every live Sales Invoice line built from it: PRINTED as a separate
        step by default. The app freezes an issued invoice's lines wholesale and
        its sanctioned correction is cancel -> fix -> reopen; the invoice also
        carries a GL journal. SI=fix restates it in place instead — line, header
        through the SI recomputeTotals, GL through resyncSiRevenue (void and
        re-post), entity audit row — the exact path a live-line edit takes.

   AUTOCOUNT. Nothing here talks to the account book. The corrected price
   reaches AutoCount through the sanctioned SO write-back only: by default the
   plan prints the "Enqueue SO write-back" workflow inputs; WRITEBACK=enqueue
   calls the app's own enqueueEdit after the apply so the outbox drain sends it.

   THE ALLOW-LIST IS THE DECISION. Some swaps may have been meant as free of
   charge. MODE=apply therefore REQUIRES DOC_NOS: only the orders the owner
   names after reading the plan are touched, and a name with no candidate line
   refuses the whole run.

   MODE=plan (default) prints every candidate and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE PLAN LINE BY LINE" and DOC_NOS,
   writes one SO at a time, and verifies on a fresh connection that every
   restored line, header, DO line and (when fixed) SI line carries the figures
   the plan said — the SHAPE, not a count.

   Env: DATABASE_URL, COMPANY (default 1), DOC_NOS=HC-SO-1,HC-SO-2,
        SI=print|fix (default print), WRITEBACK=print|enqueue (default print).

   RE-RUN: inert. A restored line no longer reads unit_price_sen = 0, so it
   leaves the selection; the SI and write-back steps only act on what is named. */
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import {
  candidateSql, downstreamSql, parseDocNos, soLineMoney, doLineMoney, siLineMoney, shapeMismatches,
} from './lib/amendment-zeroed-prices.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE PLAN LINE BY LINE';
const DOC_NOS = parseDocNos(process.env.DOC_NOS);
const SI_MODE = (process.env.SI || 'print').toLowerCase();
const WRITEBACK = (process.env.WRITEBACK || 'print').toLowerCase();
const SOURCE = 'script:repair-amendment-zeroed-prices';

/* Plain lines, not ::notice:: annotations: the runner keeps at most ten
   annotations per step and drops the rest, which is exactly the table the
   owner has to read line by line. Errors stay annotations so a failed run
   is visible from the summary. */
const note = (m) => console.log(m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
if (APPLY && DOC_NOS.length === 0) {
  bad('MODE=apply requires DOC_NOS=<the orders to restore, comma separated> — the allow-list is the owner\'s line-by-line decision');
  process.exit(2);
}
if (!['print', 'fix'].includes(SI_MODE)) { bad(`SI must be print or fix, got "${SI_MODE}"`); process.exit(2); }
if (!['print', 'enqueue'].includes(WRITEBACK)) { bad(`WRITEBACK must be print or enqueue, got "${WRITEBACK}"`); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/* The app's helpers read the active company off a request context; the
   script's whole run IS one company. */
const ctx = { get: (k) => (k === 'companyId' ? CO : undefined) };

async function readCandidates(client) {
  const lines = await client.unsafe(candidateSql(), [CO, DOC_NOS]);
  const ids = lines.map((l) => l.line_id);
  const down = ids.length ? await client.unsafe(downstreamSql(), [CO, ids]) : [];
  return { lines, down };
}

/** What the apply will write for one SO line and its downstream lines. */
function plan(lines, down) {
  const bySo = new Map();
  for (const l of lines) {
    const money = soLineMoney({ qty: l.qty, unitSen: l.old_unit_price_sen, discountSen: l.discount_sen, lineCostSen: l.line_cost_sen });
    const dos = down.filter((d) => d.kind === 'DO' && d.so_line_id === l.line_id).map((d) => ({
      ...d, after: doLineMoney({ qty: d.qty, unitSen: l.old_unit_price_sen, discountSen: d.discount_sen, lineCostSen: d.line_cost_sen }),
    }));
    const sis = down.filter((d) => d.kind === 'SI' && d.so_line_id === l.line_id).map((d) => ({
      ...d, after: siLineMoney({ qty: d.qty, unitSen: l.old_unit_price_sen, discountSen: d.discount_sen, taxSen: d.tax_sen, lineCostSen: d.line_cost_sen }),
    }));
    const g = bySo.get(l.doc_no) ?? { docNo: l.doc_no, status: l.so_status, version: Number(l.so_version), totalSen: Number(l.so_total_sen ?? 0), lines: [] };
    g.lines.push({ ...l, money, dos, sis });
    bySo.set(l.doc_no, g);
  }
  return [...bySo.values()];
}

function printPlan(groups) {
  note(`\n=== SO LINES ZEROED BY A SKU-SWAP AMENDMENT (company ${CO}${DOC_NOS.length ? `, DOC_NOS=${DOC_NOS.join(',')}` : ''}) ===`);
  note(`  doc_no | status | line | item (was -> now) | qty | old price | current | restored | line total after | DO / SI`);
  let n = 0;
  for (const g of groups) {
    for (const l of g.lines) {
      n += 1;
      const docs = [...l.dos.map((d) => `DO ${d.doc_no} (${d.status})`), ...l.sis.map((s) => `SI ${s.doc_no} (${s.status}, paid ${rm(s.paid_sen)})`)];
      note(`  ${g.docNo} | ${g.status} | ${l.line_id} | ${l.old_item_code ?? '?'} -> ${l.item_code} | ${l.qty} | ${rm(l.old_unit_price_sen)} | ${rm(l.unit_price_sen)} | ${rm(l.money.unit_price_sen)} | ${rm(l.money.total_sen)} | ${docs.length ? docs.join('; ') : '-'}`);
      note(`      amendment ${l.amendment_no} (${l.amendment_id}) ${l.amendment_status} approved ${new Date(l.so_approved_at).toISOString().slice(0, 10)}, requested price ${l.new_unit_price_sen ?? 'null'}${l.cancelled ? ' — LINE IS CANCELLED, skipped' : ''}`);
    }
    const delta = g.lines.filter((l) => !l.cancelled).reduce((s, l) => s + l.money.total_sen, 0);
    note(`      header ${g.docNo}: local_total_sen ${rm(g.totalSen)} now, about ${rm(g.totalSen + delta)} after (the canonical recompute decides), version ${g.version} -> ${g.version + 1}`);
  }
  note(`\n  candidate lines: ${n} on ${groups.length} order(s)`);
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} si=${SI_MODE} writeback=${WRITEBACK}`);

  const { lines, down } = await readCandidates(sql);
  const groups = plan(lines, down);
  if (!lines.length) { note('\nNothing to repair.'); await sql.end({ timeout: 5 }); return; }
  printPlan(groups);

  const missing = DOC_NOS.filter((d) => !groups.some((g) => g.docNo === d));
  if (missing.length) {
    bad(`DOC_NOS names ${missing.length} order(s) with no candidate line: ${missing.join(', ')} — refusing the whole run`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }

  const siRows = groups.flatMap((g) => g.lines.flatMap((l) => l.sis));
  if (siRows.length && SI_MODE === 'print') {
    note(`\n=== SALES INVOICES AT RM 0 — a separate step, not written by this run ===`);
    for (const s of siRows) {
      note(`  SI ${s.doc_no} (${s.status}, total ${rm(s.doc_total_sen)}, paid ${rm(s.paid_sen)}): line ${s.item_id} ${rm(s.unit_price_sen)} -> ${rm(s.after.unit_price_sen)}, line total -> ${rm(s.after.line_total_sen)}`);
    }
    note(`  The app freezes an issued invoice's lines; the sanctioned correction is cancel -> fix -> reopen in the app.`);
    note(`  Or re-run this script with SI=fix to restate these in place (line, header totals, GL re-posted through resyncSiRevenue).`);
  }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" DOC_NOS=${groups.map((g) => g.docNo).join(',')}`);
    await sql.end({ timeout: 5 });
    return;
  }

  /* The app's own roll-ups and audit writers, over the shim. __atomicCommand
     makes them THROW on a failed write instead of logging and returning — a
     script has no client to retry, so a swallowed failure is a silent one. */
  const [{ recomputeTotals }, { recomputeDoTotals }, siFromDo, { resyncSiRevenue }, { recordSoAudit }, { recordEntityAudit }] = await Promise.all([
    import('../src/scm/routes/mfg-sales-orders.ts'),
    import('../src/scm/lib/do-totals.ts'),
    import('../src/scm/lib/si-from-do.ts'),
    import('../src/scm/lib/post-si-revenue.ts'),
    import('../src/scm/lib/so-audit.ts'),
    import('../src/scm/lib/entity-audit.ts'),
  ]);
  const sb = pgrestShim(sql, 'scm');
  sb.__atomicCommand = true;
  const assertNoShimGaps = (what) => {
    if (!sb.__gaps.length) return;
    throw new Error(`shim gap during ${what}: ${sb.__gaps.join('; ')}`);
  };

  note(`\n=== REPAIRING ${groups.length} ORDER(S) ===`);
  const verify = [];
  for (const g of groups) {
    const fieldChanges = [];
    const amendments = new Set();
    for (const l of g.lines) {
      if (l.cancelled) { note(`  SKIP ${g.docNo} line ${l.line_id} — cancelled`); continue; }
      const m = l.money;
      const back = await sql.unsafe(
        `UPDATE scm.mfg_sales_order_items
            SET unit_price_sen = $3, total_sen = $4, total_inc_sen = $4, balance_sen = $4, line_margin_sen = $5
          WHERE id = $1::uuid AND company_id = $2 AND unit_price_sen = 0
        RETURNING id::text AS id`, [l.line_id, CO, m.unit_price_sen, m.total_sen, m.line_margin_sen]);
      if (back.length !== 1) throw new Error(`${g.docNo} line ${l.line_id}: not written (changed since the plan was read?)`);
      note(`  OK  ${g.docNo} line ${l.item_code}: ${rm(0)} -> ${rm(m.unit_price_sen)}, total ${rm(m.total_sen)}`);
      verify.push({ kind: 'SO line', key: `${g.docNo} ${l.item_code}`, table: 'mfg_sales_order_items', id: l.line_id,
        expect: { unit_price_sen: m.unit_price_sen, total_sen: m.total_sen, total_inc_sen: m.total_sen, balance_sen: m.total_sen, line_margin_sen: m.line_margin_sen } });
      fieldChanges.push(
        { field: `line_${l.item_code}_unit_price_sen`, from: 0, to: m.unit_price_sen },
        { field: `line_${l.item_code}_total_sen`, from: Number(l.total_sen ?? 0), to: m.total_sen },
      );
      amendments.add(`${l.amendment_no} (${l.amendment_id})`);

      for (const d of l.dos) {
        const a = d.after;
        const w = await sql.unsafe(
          `UPDATE scm.delivery_order_items
              SET unit_price_sen = $3, line_total_sen = $4, line_margin_sen = $5
            WHERE id = $1::uuid AND company_id = $2 AND unit_price_sen = 0
          RETURNING id::text AS id`, [d.item_id, CO, a.unit_price_sen, a.line_total_sen, a.line_margin_sen]);
        if (w.length !== 1) throw new Error(`DO ${d.doc_no} line ${d.item_id}: not written (changed since the plan was read?)`);
        await recomputeDoTotals(sb, d.doc_id);
        assertNoShimGaps(`recomputeDoTotals(${d.doc_no})`);
        const audit = await recordEntityAudit(sb, {
          entityType: 'DELIVERY_ORDER', entityId: d.doc_id, entityDocNo: d.doc_no, action: 'UPDATE', actor: null,
          companyId: CO, statusSnapshot: d.status, source: SOURCE,
          note: `Line ${l.item_code}: sell price restored after amendment ${l.amendment_no} zeroed it on the Sales Order`,
          fieldChanges: [{ field: 'unitPriceSen', from: 0, to: a.unit_price_sen }, { field: 'lineTotalSen', from: Number(d.line_total_sen ?? 0), to: a.line_total_sen }],
        });
        if (!audit?.recorded) throw new Error(`DO ${d.doc_no}: audit row not recorded (${audit?.reason ?? 'unknown'})`);
        note(`  OK  DO ${d.doc_no} line ${l.item_code}: -> ${rm(a.unit_price_sen)}, re-totalled, audited`);
        verify.push({ kind: 'DO line', key: `${d.doc_no} ${l.item_code}`, table: 'delivery_order_items', id: d.item_id,
          expect: { unit_price_sen: a.unit_price_sen, line_total_sen: a.line_total_sen, line_margin_sen: a.line_margin_sen } });
      }

      for (const s of l.sis) {
        if (SI_MODE !== 'fix') { note(`  --  SI ${s.doc_no} line ${l.item_code} left at ${rm(s.unit_price_sen)} (SI=print; see the step above)`); continue; }
        const a = s.after;
        const w = await sql.unsafe(
          `UPDATE scm.sales_invoice_items
              SET unit_price_sen = $3, line_total_sen = $4, line_margin_sen = $5
            WHERE id = $1::uuid AND company_id = $2 AND unit_price_sen = 0
          RETURNING id::text AS id`, [s.item_id, CO, a.unit_price_sen, a.line_total_sen, a.line_margin_sen]);
        if (w.length !== 1) throw new Error(`SI ${s.doc_no} line ${s.item_id}: not written (changed since the plan was read?)`);
        await siFromDo.recomputeTotals(sb, s.doc_id);
        assertNoShimGaps(`si recomputeTotals(${s.doc_no})`);
        const gl = await resyncSiRevenue(sb, s.invoice_number);
        assertNoShimGaps(`resyncSiRevenue(${s.doc_no})`);
        if (!gl.ok) throw new Error(`SI ${s.doc_no}: GL resync failed — ${gl.status} ${gl.reason ?? ''}`);
        const audit = await recordEntityAudit(sb, {
          entityType: 'SALES_INVOICE', entityId: s.doc_id, entityDocNo: s.doc_no, action: 'UPDATE', actor: null,
          companyId: CO, statusSnapshot: s.status, source: SOURCE,
          note: `Line ${l.item_code}: sell price restored after amendment ${l.amendment_no} zeroed it on the Sales Order; GL ${gl.status}`,
          fieldChanges: [{ field: 'unitPriceSen', from: 0, to: a.unit_price_sen }, { field: 'lineTotalSen', from: Number(s.line_total_sen ?? 0), to: a.line_total_sen }],
        });
        if (!audit?.recorded) throw new Error(`SI ${s.doc_no}: audit row not recorded (${audit?.reason ?? 'unknown'})`);
        note(`  OK  SI ${s.doc_no} line ${l.item_code}: -> ${rm(a.unit_price_sen)}, re-totalled, GL ${gl.status}, audited`);
        verify.push({ kind: 'SI line', key: `${s.doc_no} ${l.item_code}`, table: 'sales_invoice_items', id: s.item_id,
          expect: { unit_price_sen: a.unit_price_sen, line_total_sen: a.line_total_sen, line_margin_sen: a.line_margin_sen } });
      }
    }
    if (!fieldChanges.length) continue;

    await recomputeTotals(sb, g.docNo, ctx);
    assertNoShimGaps(`recomputeTotals(${g.docNo})`);
    const [hdr] = await sql.unsafe(
      `UPDATE scm.mfg_sales_orders SET version = version + 1, updated_at = now()
        WHERE doc_no = $1 AND company_id = $2 AND version = $3
      RETURNING version, local_total_sen`, [g.docNo, CO, g.version]);
    if (!hdr) throw new Error(`${g.docNo}: header version moved from ${g.version} since the plan was read — lines restored, header NOT bumped; re-run the plan`);
    await recordSoAudit(sb, {
      docNo: g.docNo, action: 'UPDATE_LINE', source: SOURCE, statusSnapshot: g.status, fieldChanges,
      note: `Sell price restored from the amendment snapshot: amendment ${[...amendments].join(', ')} swapped the SKU with new_unit_price_sen 0 and the apply wrote RM 0`,
    });
    assertNoShimGaps(`recordSoAudit(${g.docNo})`);
    note(`  OK  ${g.docNo}: header re-totalled to ${rm(hdr.local_total_sen)}, version ${g.version} -> ${hdr.version}, audited`);
    verify.push({ kind: 'SO header', key: g.docNo, table: 'mfg_sales_orders', id: null, docNo: g.docNo,
      expect: { version: Number(hdr.version) }, minTotal: g.lines.filter((l) => !l.cancelled).reduce((s, l) => s + l.money.total_sen, 0) });
  }

  if (WRITEBACK === 'enqueue') {
    note(`\n=== AUTOCOUNT: ENQUEUE THE SO WRITE-BACK (app's enqueueEdit, outbox drain sends it) ===`);
    const { enqueueEdit } = await import('../src/scm/lib/autocount-outbox.ts');
    const sbWb = pgrestShim(sql, 'scm', { writeback: 'enqueue' });
    for (const g of groups) {
      const ok = await enqueueEdit(sbWb, { companyId: CO, docType: 'SO', docNo: g.docNo, createdBy: null });
      if (sbWb.__gaps.length) throw new Error(`shim gap during enqueueEdit(${g.docNo}): ${sbWb.__gaps.join('; ')}`);
      note(ok === false ? `  SKIP ${g.docNo}: enqueueEdit declined (write-back off, or no AutoCount counterpart)` : `  OK  ${g.docNo}: edit enqueued`);
    }
  } else {
    note(`\n=== AUTOCOUNT: NOT TOUCHED. Push the corrected prices with Actions -> "Enqueue SO write-back": target=prod mode=apply docs=${groups.map((g) => g.docNo).join(',')} ===`);
  }

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let failed = 0;
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    for (const v of verify) {
      let row;
      if (v.table === 'mfg_sales_orders') {
        [row] = await check.unsafe(`SELECT version, local_total_sen FROM scm.mfg_sales_orders WHERE doc_no = $1 AND company_id = $2`, [v.docNo, CO]);
      } else {
        const cols = Object.keys(v.expect).join(', ');
        [row] = await check.unsafe(`SELECT ${cols} FROM scm.${v.table} WHERE id = $1::uuid AND company_id = $2`, [v.id, CO]);
      }
      const miss = shapeMismatches(row, v.expect);
      if (v.minTotal != null && row && Number(row.local_total_sen) < v.minTotal) miss.push(`local_total_sen: ${row.local_total_sen} below the restored lines' ${v.minTotal}`);
      if (miss.length) { failed += 1; bad(`  ${v.kind} ${v.key}: ${miss.join('; ')}`); }
      else note(`  ${v.kind} ${v.key}: ${Object.entries(v.expect).map(([k, x]) => `${k}=${x}`).join(' ')}${v.table === 'mfg_sales_orders' ? ` local_total_sen=${row.local_total_sen}` : ''}`);
    }
    const left = await readCandidates(check);
    const stillNamed = left.lines.filter((l) => groups.some((g) => g.docNo === l.doc_no) && !l.cancelled);
    if (stillNamed.length) { failed += 1; bad(`  ${stillNamed.length} named line(s) still select as zeroed`); }
    else note(`  re-run is inert for the named orders: 0 of their lines still select`);
  } finally {
    await check.end({ timeout: 5 });
  }
  if (failed) { bad(`${failed} verification(s) failed`); process.exit(1); }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
