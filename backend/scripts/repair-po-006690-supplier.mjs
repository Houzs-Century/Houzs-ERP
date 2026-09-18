// Change the supplier of PO HC-PO-006690 from HOOKKA (400-H003) to NICOLLO
// (400-N002). Fix a wrong-supplier that was picked when the document was raised.
//
// WHAT PROVES IT IS A WRONG SUPPLIER, not a wrong ITEM. The line on this PO
// carries ERP item code 'DIVAN ONLY-(Q)'. That ERP code maps to 4 AutoCount
// items, all of them 'NB-...'; the historical AC snapshot shows every one of
// 3,349 POs that ever carried an NB- item was raised on '400-N002 NICOLLO SDN
// BHD' — the NB- prefix is NICOLLO'S SKU family, not HOOKKA's. HOOKKA's own
// catalogue does not carry DIVAN ONLY at all, which is why the composer's
// verdict — "DIVAN ONLY-(Q) maps to 4 AutoCount items and none belongs to
// supplier 400-H003" — is the same finding by a different route.
//
// The FIX therefore is on the header (the supplier), not on the line (the
// item). Adding a supplier_material_bindings row so 400-H003 nominally sells
// NB-DIVAN ONLY would let this one document sync, and would silently invite
// every future DIVAN ONLY on HOOKKA to sync too, into an account book that has
// never held one — a wrong write is worse than a missing write.
//
// REVERSAL: run this with MODE=plan first to capture BEFORE (it prints the
// current supplier_id UUID and code); to undo, UPDATE scm.purchase_orders SET
// supplier_id = '<BEFORE uuid>' WHERE po_number='HC-PO-006690' AND
// company_id=1;.
//
// RE-RUN: idempotent. When the row is already on NICOLLO the script prints
// "already NICOLLO — nothing to do" and exits 0.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const MODE = process.env.MODE ?? 'plan';
const CONFIRM = process.env.CONFIRM ?? '';
const APPLY = MODE === 'apply';

const PO_NUMBER = 'HC-PO-006690';
const COMPANY_ID = 1;
const TARGET_SUPPLIER_CODE = '400-N002';
const CONFIRM_PHRASE = 'REPAIR-HC-PO-006690';

if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`refuses to apply: CONFIRM must be exactly "${CONFIRM_PHRASE}"`);
  process.exit(1);
}

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
  console.error('no DATABASE_URL — set it in the environment or .dev.vars');
  process.exit(1);
}

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  const [po] = await pg`
    SELECT po.id, po.po_number, po.company_id, po.supplier_id, po.linked_ac_docno,
           s.code AS current_supplier_code, s.name AS current_supplier_name
      FROM scm.purchase_orders po
      LEFT JOIN scm.suppliers s ON s.id = po.supplier_id
     WHERE po.po_number = ${PO_NUMBER}
       AND po.company_id = ${COMPANY_ID}`;

  if (!po) {
    console.error(`NOT FOUND: no PO ${PO_NUMBER} for company ${COMPANY_ID}`);
    process.exit(1);
  }

  console.log('BEFORE:', JSON.stringify({
    po_number: po.po_number,
    supplier_id: po.supplier_id,
    supplier_code: po.current_supplier_code,
    supplier_name: po.current_supplier_name,
    linked_ac_docno: po.linked_ac_docno,
  }, null, 2));

  const [target] = await pg`
    SELECT id, code, name FROM scm.suppliers
     WHERE code = ${TARGET_SUPPLIER_CODE}
       AND company_id = ${COMPANY_ID}`;

  if (!target) {
    console.error(`TARGET NOT FOUND: no supplier with code ${TARGET_SUPPLIER_CODE} in company ${COMPANY_ID}`);
    process.exit(1);
  }

  console.log('TARGET:', JSON.stringify(target, null, 2));

  if (po.current_supplier_code === TARGET_SUPPLIER_CODE) {
    console.log(`OK — already on ${TARGET_SUPPLIER_CODE}. Nothing to do.`);
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`DRY-RUN — no write. Would set supplier_id = ${target.id} (${TARGET_SUPPLIER_CODE}).`);
    console.log('Re-run with MODE=apply CONFIRM=' + CONFIRM_PHRASE + ' to write.');
    process.exit(0);
  }

  const written = await pg`
    UPDATE scm.purchase_orders
       SET supplier_id = ${target.id}
     WHERE po_number = ${PO_NUMBER}
       AND company_id = ${COMPANY_ID}
       AND supplier_id IS DISTINCT FROM ${target.id}
     RETURNING id, po_number`;

  console.log('WROTE:', written.length, 'row(s)');
} finally {
  await pg.end();
}

// FRESH CONNECTION verification, and a SHAPE check that reads the supplier CODE
// through the same join the writer used — a row count of 1 is not proof; the
// only wrong outcome that survives a row count is a wrong supplier having been
// stamped through it.
const pg2 = postgres(url, { ssl: 'require', prepare: false, max: 1 });
try {
  const [after] = await pg2`
    SELECT po.po_number, s.code AS supplier_code, s.name AS supplier_name
      FROM scm.purchase_orders po
      LEFT JOIN scm.suppliers s ON s.id = po.supplier_id
     WHERE po.po_number = ${PO_NUMBER}
       AND po.company_id = ${COMPANY_ID}`;

  console.log('AFTER:', JSON.stringify(after, null, 2));

  if (!APPLY) {
    process.exit(0);
  }

  if (!after || after.supplier_code !== TARGET_SUPPLIER_CODE) {
    console.error(`POST-CHECK FAILED — supplier_code is ${after?.supplier_code}, not ${TARGET_SUPPLIER_CODE}`);
    process.exit(1);
  }

  console.log('OK. Next step: save the PO in the ERP, or dispatch the AutoCount write-back re-queue for this doc; the composer will then read the new supplier and resolve DIVAN ONLY-(Q) to NB-DIVAN ONLY (Q).');
} finally {
  await pg2.end();
}
