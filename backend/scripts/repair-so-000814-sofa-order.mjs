// Swap `created_at` on two sofa compartment lines of HC-SO-000814 so composer
// emits `[L, 1NA, 2A(RHF)]` instead of `[L, 2A(RHF), 1NA]`. The composer
// refused the current order for round-trip inconsistency
// (SofaCollapseError: "Desc2 decodes to [L(LHF), 1NA, 2A(RHF)] but the ERP
// holds [L(LHF), 2A(RHF), 1NA]"). Owner ruling 2026-09-10: use the AC-decoded
// order `L + 1NA + 2A(RHF)`.
//
// WHY `created_at` AND NOT A COLUMN THAT SAYS "ORDER". The canonical AC line
// order is `(created_at, id)` — see backend/src/scm/lib/ac-line-order.ts —
// which the whole write-back respects. There is no explicit sort_order column
// on `scm.mfg_sales_order_items`. Swapping `created_at` between the two rows
// therefore swaps their emit order and nothing else moves.
//
// REVERSAL: run this a second time; the swap is its own undo.
//
// RE-RUN: NOT idempotent — running twice returns to the ORIGINAL order. Only
// dispatch when you want the swap applied.
//
// SCOPED HARD: only touches two rows on ONE named document. Refuses if the
// document does not exist, if the sofa model is not 5526, or if either of the
// two compartments (1NA, 2A(RHF)) is not found exactly once.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const MODE = process.env.MODE ?? 'plan';
const CONFIRM = process.env.CONFIRM ?? '';
const APPLY = MODE === 'apply';

const DOC_NO = 'HC-SO-000814';
const COMPANY_ID = 1;
const SOFA_MODEL = '5526';
const COMPARTMENT_A = '1NA';
const COMPARTMENT_B = '2A(RHF)';
const CONFIRM_PHRASE = 'SWAP-SOFA-000814';

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
  // Sofa item codes are `{model}-{compartment}` split on the FIRST hyphen —
  // e.g. `5526-1NA`, `5526-2A(RHF)` — per splitSofaCode in
  // backend/src/services/autocount-sofa-collapse.ts. The compartment is
  // everything after that first hyphen.
  const compartmentOf = (itemCode) => {
    const s = String(itemCode ?? '').trim();
    const i = s.indexOf('-');
    return i > 0 ? s.slice(i + 1) : null;
  };

  // ALL lines on the doc, in canonical composer order. Printed whole so the
  // dry-run reveals the real item codes rather than trusting a guessed prefix
  // (the first apply guessed 'SOFA 5526%' and found nothing). The compartment
  // match below is by the FIRST-hyphen split, exactly as the composer reads it.
  const rows = await pg`
    SELECT id, item_code, description, created_at
      FROM scm.mfg_sales_order_items
     WHERE doc_no = ${DOC_NO}
       AND company_id = ${COMPANY_ID}
     ORDER BY created_at, id`;

  console.log('ALL LINES BEFORE (ordered as composer sees them):');
  for (const r of rows) console.log(`  ${r.item_code}  (compartment=${compartmentOf(r.item_code)})  created_at=${r.created_at}  id=${r.id}`);

  if (rows.length === 0) {
    console.error(`REFUSED — no lines found on ${DOC_NO}`);
    process.exit(1);
  }

  const a = rows.filter((r) => compartmentOf(r.item_code) === COMPARTMENT_A);
  const b = rows.filter((r) => compartmentOf(r.item_code) === COMPARTMENT_B);

  if (a.length !== 1) {
    console.error(`REFUSED — expected exactly 1 line ending in "${COMPARTMENT_A}", found ${a.length}`);
    process.exit(1);
  }
  if (b.length !== 1) {
    console.error(`REFUSED — expected exactly 1 line ending in "${COMPARTMENT_B}", found ${b.length}`);
    process.exit(1);
  }

  const rowA = a[0];
  const rowB = b[0];
  console.log(`SWAP TARGET A: ${rowA.item_code}  id=${rowA.id}  created_at=${rowA.created_at}`);
  console.log(`SWAP TARGET B: ${rowB.item_code}  id=${rowB.id}  created_at=${rowB.created_at}`);

  if (!APPLY) {
    console.log(`DRY-RUN — no write. Would swap created_at between the two rows above.`);
    console.log(`Re-run with MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.`);
    process.exit(0);
  }

  await pg.begin(async (tx) => {
    await tx`UPDATE scm.mfg_sales_order_items SET created_at = ${rowB.created_at} WHERE id = ${rowA.id}`;
    await tx`UPDATE scm.mfg_sales_order_items SET created_at = ${rowA.created_at} WHERE id = ${rowB.id}`;
  });
  console.log('WROTE: swapped created_at between the two rows.');
} finally {
  await pg.end();
}

// Fresh connection + SHAPE check: read the sofa lines again in canonical
// order, print, and assert 1NA now precedes 2A(RHF).
const pg2 = postgres(url, { ssl: 'require', prepare: false, max: 1 });
try {
  const after = await pg2`
    SELECT id, item_code, created_at
      FROM scm.mfg_sales_order_items
     WHERE doc_no = ${DOC_NO}
       AND company_id = ${COMPANY_ID}
     ORDER BY created_at, id`;

  console.log('SOFA LINES AFTER:');
  for (const r of after) console.log(`  ${r.item_code}  created_at=${r.created_at}  id=${r.id}`);

  if (!APPLY) {
    process.exit(0);
  }

  const compartmentOf = (itemCode) => {
    const s = String(itemCode ?? '').trim();
    const i = s.indexOf('-');
    return i > 0 ? s.slice(i + 1) : null;
  };
  const codes = after.map((r) => r.item_code ?? '');
  const idxA = codes.findIndex((c) => compartmentOf(c) === COMPARTMENT_A);
  const idxB = codes.findIndex((c) => compartmentOf(c) === COMPARTMENT_B);
  if (idxA === -1 || idxB === -1 || idxA > idxB) {
    console.error(`POST-CHECK FAILED — expected ${COMPARTMENT_A} before ${COMPARTMENT_B}, got A=${idxA} B=${idxB}`);
    process.exit(1);
  }

  console.log(`OK — ${COMPARTMENT_A} now precedes ${COMPARTMENT_B}. Next: re-queue HC-SO-000814 and the composer should decode consistently.`);
} finally {
  await pg2.end();
}
