// THE BUG CLASS "key without identity", pinned at every live site that had it.
// docs/bugs/0672-bug-class-key-without-identity-*.md.
//
// The class: a link between two rows is written on the strength of a KEY (an
// AutoCount DtlKey, a doc number, a row position, a client-supplied uuid)
// without asserting that the IDENTITY of the two sides agrees. The link then
// looks structurally valid and is semantically wrong, and nothing downstream
// can tell — `purchase_order_items.so_item_id` decides what the floor is told
// is READY (isHardBoundLine, src/scm/lib/so-stock-allocation.ts), so a wrong
// one lights the wrong bed.
//
// WHY THESE ASSERTIONS READ SOURCE INSTEAD OF CALLING THE CODE. The property
// being pinned is not "the rule is right" — `normItemCode`,
// `soLinkTargetRefusal` and `lineLinkItemMismatch` all have behavioural tests
// (soPoDedication.test.mjs, soLinkItemIdentity.test.ts,
// lineLinkItemIdentity.test.ts). The property is "the rule is APPLIED AT THIS
// CALL SITE", and a call-site population is exactly what a unit test cannot
// see: that is the whole lesson of
// docs/bugs/0099-bug-class-unverified-completeness-claim, and the same
// instrument scripts/check-optional-decision-params.mjs already uses here.
//
// Every assertion below FAILED on the tree it was written against, and those
// red runs are the evidence in the bug entries. If a refactor moves the code,
// do NOT delete the assertion — re-anchor it, or replace it with a behavioural
// test that proves the same refusal.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const read = (p) => readFileSync(join(BACKEND, p), 'utf8');

/** The text between two anchors, so the assertion is scoped to ONE call site. */
function between(src, startAnchor, endAnchor, label) {
  const a = src.indexOf(startAnchor);
  expect(a, `${label}: start anchor not found — re-anchor this test, do not delete it`).toBeGreaterThan(-1);
  const b = src.indexOf(endAnchor, a);
  expect(b, `${label}: end anchor not found — re-anchor this test, do not delete it`).toBeGreaterThan(a);
  return src.slice(a, b + endAnchor.length);
}

describe('sync-ac-delta lane `dedi` — the SO -> PO dedication written from the DtlKey pair', () => {
  /* Lane `links` got the item-code guard on 2026-09-07 (planSoPoDedications,
     scripts/lib/ac-po-line.mjs). Lane `dedi`, thirty lines further down the
     SAME file, writes the SAME column from the SAME FromSODtlKey/DtlKey pair
     and built its plan inline, so it kept the defect. It is in the workflow's
     DEFAULT lanes string, so an apply dispatch with untouched inputs runs it. */
  const src = read('scripts/sync-ac-delta.mjs');
  const lane = between(src, 'const dediPoItems = new Set(', 'dediPlan.push({', 'dedi lane');

  it('refuses a dedication whose two ERP rows name a different product', () => {
    expect(lane).toMatch(/normItemCode\s*\(\s*si\.item_code\s*\)\s*!==\s*normItemCode\s*\(\s*pi\.item_code\s*\)/);
  });

  it('records the refusal instead of dropping it silently', () => {
    expect(lane).toMatch(/dediMismatch\.push/);
  });

  it('imports the rule rather than restating it', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bnormItemCode\b[^}]*\}\s*from\s*["']\.\/lib\/ac-po-line\.mjs["']/);
  });
});

describe('POST /purchase-orders — the client-supplied so_item_id on the CREATE path', () => {
  /* The same file gates this bind on FOUR other call sites — soLinkTargetRefusal
     at the add-line, the patch-line and both allocation paths — and its
     `so_link_material_mismatch` 409 is the refusal. The create path read the SO
     lines for company scope and the qty cap and stopped there; its own comment
     said it "mirrors soLinkTargetRefusal", and it mirrored only the company
     half. A New-PO form line for product B could therefore be linked to an SO
     line for product A, which is 0671's damage entered through the front door
     instead of through the importer. */
  const src = read('src/scm/routes/mfg-purchase-orders.ts');
  const block = between(src, 'const lineSoItemIds = items', 'so_item_id:   soItemId,', 'PO create');

  it('reads the SO line item_code, so the two sides CAN be compared', () => {
    expect(block).toMatch(/select\(\s*'id,\s*doc_no,\s*item_code/);
  });

  /* The rule itself lives in lib/so-link-item-identity.ts and is covered
     behaviourally by soLinkItemIdentity.test.ts. What this pins is that the
     create path CALLS it — the property a unit test cannot see. */
  it('refuses a bind whose two lines name a different product', () => {
    expect(block).toMatch(/soLinkItemMismatch\(\s*items\s*,\s*soRows\s*\)/);
    expect(src).toMatch(/import\s*\{[^}]*soLinkItemMismatch[^}]*\}\s*from\s*'\.\.\/lib\/so-link-item-identity'/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   SITE 15 — the client-supplied line-to-line binds.

   Each of these paths takes a source-line uuid straight out of the request body
   and writes it to a link column. Every one of them checks the COMPANY of that
   source line, most check the parent document's status, and most cap the
   QUANTITY against the source line's remaining. Not one compared the ITEM, so a
   line ordering product B could name a source line for product A — a valid
   foreign key pointing at a different product, which does not dangle and lowers
   no coverage count.

   probe-link-identity.mjs run 34172468269 (2026-09-08 08:13 local) found 5 such
   rows already live: 2 on sales_invoice_items.do_item_id and 3 on
   purchase_invoice_items.grn_item_id, across 5 documents, none a permutation.

   WHY THE MECHANISM DIFFERS PER SITE, and why this test accepts any of them.
   The rule has ONE home (lib/line-link-item-identity.ts) and three ways in:

     assertSourceLinesInCompany(..., { lines, linkField, source })
         where the path ALREADY proves the source line's company — the identity
         read joins an assertion that was already being made.
     lineLinkItemMismatch(...)
         where the path ALREADY holds the source rows, so comparing the product
         costs no extra round trip.
     assertLinkedLineItemsMatch(...)
         where neither is true and the guard takes its own batched read.

   Pinning one SPECIFIC mechanism per site would make this test a copy of the
   code. What it pins is that SOME assertion of identity runs at this call site.

   Every assertion below failed on 9a23806a0: 10 failed, 5 passed.
   ──────────────────────────────────────────────────────────────────────────── */

/** Any of the three ways the one rule is reached. */
const APPLIES_IDENTITY = /assertLinkedLineItemsMatch\(|lineLinkItemMismatch\(|linkField:|piGrnSourceRefusal\(|siLinkedItemCodes\(/;

const SITE_15 = [
  {
    /* BOTH sales-invoice write paths funnel through checkSiOverRemaining, so
       the rule lives INSIDE it. "A guard whose inputs are assembled somewhere
       else is a guard that can be starved" is that file's own header, written
       about this very function's reopen sibling. */
    label: 'checkSiOverRemaining — the one gate both SI write paths funnel through',
    file: 'src/scm/lib/do-line-remaining.ts',
    start: 'export async function checkSiOverRemaining(',
    end: 'return offenders.length > 0',
  },
  {
    label: 'the SI identity read happens BEFORE the quantity cap',
    file: 'src/scm/lib/do-line-remaining.ts',
    start: 'async function siLinkedItemCodes(',
    end: 'return bad ? { status: 409, body: bad } : null;',
  },
  {
    label: 'sales-invoices POST / still funnels through that gate',
    file: 'src/scm/routes/sales-invoices.ts',
    start: 'const over = await checkSiOverRemaining(sb, items);',
    end: 'if (over) return c.json(over.body, over.status);',
    expect: /checkSiOverRemaining/,
  },
  {
    label: 'sales-invoices POST /:id/items still funnels through that gate',
    file: 'src/scm/routes/sales-invoices.ts',
    start: 'const over = await checkSiOverRemaining(sb, [it]);',
    end: 'if (over) return c.json(over.body, over.status);',
    expect: /checkSiOverRemaining/,
  },
  {
    /* Beyond 0672's list, and the SALES twin of the purchase PATCH arm below.
       unlinkedEditRefusal beside it is scoped to a STORED link of null, so a
       line ALREADY carrying a do_item_id could have its item_code rewritten
       under a live link — and doLineRemaining then spends that delivery
       line's allowance on a different product. */
    label: 'sales-invoices PATCH line — item_code may not drift under a live link',
    file: 'src/scm/routes/sales-invoices.ts',
    start: "const repoint = await unlinkedEditRefusal(sb, 'sales-invoice', {",
    end: "sb.from('sales_invoice_items').update(updates)",
  },
  {
    label: 'purchase-invoices POST / — grn_item_id from the create body',
    file: 'src/scm/routes/purchase-invoices.ts',
    start: 'const wantByGrnItem = new Map<string, number>();',
    end: 'if (bad) return refuseWithoutWriting(c, bad.body, bad.status);',
  },
  {
    label: 'pi-grn-source-guard asserts identity BEFORE the quantity cap',
    file: 'src/scm/lib/pi-grn-source-guard.ts',
    start: 'const byId = new Map<string, GiRow>',
    end: 'const over: Array<{ grnItemId: string; requested: number; remaining: number }> = [];',
  },
  {
    label: 'purchase-invoices POST /:id/items — grn_item_id on the add-line',
    file: 'src/scm/routes/purchase-invoices.ts',
    start: "assertSourceLinesInCompany(sb, c, 'grn_items', [grnItemId], { lines: [it]",
    end: 'purchase_invoice_id: piId,',
  },
  {
    /* Beyond 0672's list. Its second structural observation is that four EDIT
       paths let item_code be rewritten UNDER a live link; this is one of them. */
    label: 'purchase-invoices PATCH line — item_code may not drift under a live link',
    file: 'src/scm/routes/purchase-invoices.ts',
    start: 'THE LINK CAN ALSO DRIFT AFTER THE FACT',
    end: 'if (!xl.ok) return c.json(xl.body, xl.status);',
  },
  {
    label: 'grns POST / — purchase_order_item_id from the create body',
    file: 'src/scm/routes/grns.ts',
    start: "assertSourceLinesInCompany(sb, c, 'purchase_order_items', [...acceptedByPoItem.keys()]",
    end: 'if (!xl.ok) return refuseWithoutWriting(c, xl.body, xl.status);',
  },
  {
    label: 'grns POST /:id/items — purchase_order_item_id on the add-line',
    file: 'src/scm/routes/grns.ts',
    start: "assertSourceLinesInCompany(sb, c, 'purchase_order_items', [addLinePoItemId]",
    end: 'if (!xl.ok) return refuseWithoutWriting(c, xl.body, xl.status);',
  },
  {
    label: 'purchase-returns POST / — grn_item_id from the create body',
    file: 'src/scm/routes/purchase-returns.ts',
    start: 'let totalRefund = 0;',
    end: 'const itemRows = items.map((it) => {',
    before: true,
  },
  {
    label: 'purchase-returns POST /:id/items — grn_item_id on the add-line',
    file: 'src/scm/routes/purchase-returns.ts',
    start: "const xl = await assertSourceLinesInCompany(sb, c, 'grn_items', [grnItemId]",
    end: 'const row: Record<string, unknown> = {',
  },
  {
    label: 'delivery-returns POST / — do_item_id from the create body',
    file: 'src/scm/routes/delivery-returns.ts',
    start: 'const over = await checkDrOverRemaining(sb, items);',
    end: 'const rows = items.map((it) => buildItemRow(h.id, it, sourceCostByDoItem));',
  },
  {
    label: 'delivery-returns POST /:id/items — do_item_id on the add-line',
    file: 'src/scm/routes/delivery-returns.ts',
    start: 'const over = await checkDrOverRemaining(sb, [it]);',
    end: 'const row = buildItemRow(id, it, await sourceUnitCostByItemId(',
  },
  {
    label: 'delivery-orders POST / — so_item_id from the create body',
    file: 'src/scm/routes/delivery-orders-mfg.ts',
    start: 'const lineSoItemIds = items',
    end: 'const offender = await firstUndeliverableSo(sb, refDocNos);',
  },
  {
    label: 'delivery-orders POST /:id/items — so_item_id on the add-line',
    file: 'src/scm/routes/delivery-orders-mfg.ts',
    start: 'const soIdc = await assertLinkedLineItemsMatch(',
    end: 'const addPhotos = await loadCarriedSoLinePhotos(',
  },
];

describe('site 15 — the client-supplied line-to-line binds assert the ITEM, not just the key', () => {
  for (const site of SITE_15) {
    it(site.label, () => {
      const src = read(site.file);
      const block = site.before
        ? src.slice(Math.max(0, src.indexOf(site.start) - 3000), src.indexOf(site.start))
        : between(src, site.start, site.end, site.label);
      expect(block, `${site.label}: no identity assertion at this call site — re-anchor this test, do not delete it`)
        .toMatch(site.expect ?? APPLIES_IDENTITY);
    });
  }
});
