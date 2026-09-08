// THE BUG CLASS "key without identity", pinned at the two live sites that had
// it. docs/bugs/0672-bug-class-key-without-identity-*.md.
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
// being pinned is not "the rule is right" — `normItemCode` and
// `soLinkTargetRefusal` are both already covered by behavioural tests
// (soPoDedication.test.mjs; the 409 shape in mfg-purchase-orders.ts). The
// property is "the rule is APPLIED AT THIS CALL SITE", and a call-site
// population is exactly what a unit test cannot see: that is the whole lesson
// of docs/bugs/0099-bug-class-unverified-completeness-claim, and the same
// instrument scripts/check-optional-decision-params.mjs already uses here.
//
// Both assertions below FAILED on e1604f649, the tree this file was written
// against, and that red run is the evidence in the bug entry. If a refactor
// moves the code, do NOT delete the assertion — re-anchor it, or replace it
// with a behavioural test that proves the same refusal.
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
   SITE 15 — the NINE client-supplied line-to-line binds.

   Each of these routes takes a source-line uuid straight out of the request
   body and writes it to a link column. Every one of them checks the COMPANY of
   that source line (assertSourceLinesInCompany), most check the parent
   document's status, and most cap the quantity against the source line's
   remaining. Not one compared the ITEM, so a line ordering product B could
   name a source line for product A — a valid foreign key pointing at a
   different product, which does not dangle and lowers no coverage count.

   probe-link-identity.mjs run 34139187692 found 5 such rows already live: 2 on
   sales_invoice_items.do_item_id and 3 on purchase_invoice_items.grn_item_id,
   across 5 documents, none of them a positional permutation.

   These assertions pin that the guard is APPLIED AT EACH CALL SITE. The rule
   itself is `lineLinkItemMismatch` and is covered behaviourally by
   lineLinkItemIdentity.test.ts; a call-site POPULATION is exactly what a unit
   test cannot see (docs/bugs/0099). Every assertion below failed on 9a23806a0,
   the tree they were written against.
   ──────────────────────────────────────────────────────────────────────────── */

/** Each bind point: the file, an anchor pair scoping the assertion to ONE call
 *  site, and the source-line table the guard must read back. */
const SITE_15 = [
  {
    label: 'sales-invoices POST / — do_item_id from the create body',
    file: 'src/scm/routes/sales-invoices.ts',
    start: 'const over = await checkSiOverRemaining(sb, items);',
    end: 'const rows = items.map((it, lineNo) => buildItemRow(h.id, it, lineNo));',
    table: 'delivery_order_items',
  },
  {
    label: 'sales-invoices POST /:id/items — do_item_id on the add-line',
    file: 'src/scm/routes/sales-invoices.ts',
    start: 'const over = await checkSiOverRemaining(sb, [it]);',
    end: 'const row = buildItemRow(id, it, nextLineNo);',
    table: 'delivery_order_items',
  },
  {
    label: 'purchase-invoices POST / — grn_item_id from the create body',
    file: 'src/scm/routes/purchase-invoices.ts',
    start: 'const itemRows = items.map((it) => {',
    end: 'grn_item_id: (it.grnItemId as string | undefined) ?? null,',
    table: 'grn_items',
    before: true,
  },
  {
    label: 'purchase-invoices POST /:id/items — grn_item_id on the add-line',
    file: 'src/scm/routes/purchase-invoices.ts',
    start: "const xl = await assertSourceLinesInCompany(sb, c, 'grn_items', [grnItemId]);",
    end: 'purchase_invoice_id: piId,',
    table: 'grn_items',
  },
  {
    /* This one applies the PURE rule rather than the async helper: the create
       path already reads the PO rows for the receivable-PO guard, so adding
       `item_code` to that select makes the comparison cost no extra round trip
       — the same shape PR #3087 used for POST /purchase-orders. */
    label: 'grns POST / — purchase_order_item_id from the create body',
    file: 'src/scm/routes/grns.ts',
    start: "const xl = await assertSourceLinesInCompany(sb, c, 'purchase_order_items', [...acceptedByPoItem.keys()]);",
    end: 'purchase_order_item_id: (it.purchaseOrderItemId as string | undefined) ?? null,',
    table: 'purchase_order_items',
    inMemory: true,
  },
  {
    label: 'grns POST /:id/items — purchase_order_item_id on the add-line',
    file: 'src/scm/routes/grns.ts',
    start: "const xl = await assertSourceLinesInCompany(sb, c, 'purchase_order_items', [addLinePoItemId]);",
    end: "const pf = await assertAuditWritable(sb, { entityType: 'GRN'",
    table: 'purchase_order_items',
  },
  {
    label: 'purchase-returns POST / — grn_item_id from the create body',
    file: 'src/scm/routes/purchase-returns.ts',
    start: 'grn_item_id: grnItemId,',
    end: 'grn_item_id: grnItemId,',
    table: 'grn_items',
    before: true,
  },
  {
    label: 'purchase-returns POST /:id/items — grn_item_id on the add-line',
    file: 'src/scm/routes/purchase-returns.ts',
    start: "const xl = await assertSourceLinesInCompany(sb, c, 'grn_items', [grnItemId]);",
    end: 'grn_item_id: grnItemId,',
    table: 'grn_items',
  },
  {
    label: 'delivery-returns POST / — do_item_id from the create body',
    file: 'src/scm/routes/delivery-returns.ts',
    start: 'const over = await checkDrOverRemaining(sb, items);',
    end: 'const rows = items.map((it) => buildItemRow(h.id, it, sourceCostByDoItem));',
    table: 'delivery_order_items',
  },
  {
    label: 'delivery-returns POST /:id/items — do_item_id on the add-line',
    file: 'src/scm/routes/delivery-returns.ts',
    start: 'const over = await checkDrOverRemaining(sb, [it]);',
    end: 'const row = buildItemRow(id, it, await sourceUnitCostByItemId(',
    table: 'delivery_order_items',
  },
  {
    /* `lib/do-item-row.ts` is a pure row builder with no `sb` in scope, so the
       guard belongs at its two callers in delivery-orders-mfg.ts. */
    label: 'delivery-orders POST / — so_item_id from the create body',
    file: 'src/scm/routes/delivery-orders-mfg.ts',
    start: 'const additions = new Map<string, number>();',
    end: 'const linePhotos = await loadCarriedSoLinePhotos(',
    table: 'mfg_sales_order_items',
  },
  {
    label: 'delivery-orders POST /:id/items — so_item_id on the add-line',
    file: 'src/scm/routes/delivery-orders-mfg.ts',
    start: 'const addPhotos = await loadCarriedSoLinePhotos(',
    end: 'const row = buildItemRow(id, it, nextLineNo,',
    table: 'mfg_sales_order_items',
    before: true,
  },
];

describe('site 15 — the client-supplied line-to-line binds assert the ITEM, not just the key', () => {
  for (const site of SITE_15) {
    it(`${site.label}: refuses a bind naming a different product`, () => {
      const src = read(site.file);
      expect(src, `${site.label}: the module must be imported`)
        .toMatch(/from '\.\.\/lib\/line-link-item-identity'/);
      const block = site.before
        ? src.slice(Math.max(0, src.indexOf(site.start) - 4000), src.indexOf(site.start))
        : between(src, site.start, site.end, site.label);
      if (site.inMemory) {
        /* The rows are already in hand, so the pure rule is applied directly —
           what is pinned is that the source select carries `item_code` (without
           it the comparison is impossible) AND that the rule runs here. */
        expect(block, `${site.label}: the source select must read item_code`).toMatch(/item_code/);
        expect(block, `${site.label}: no lineLinkItemMismatch at this call site`)
          .toMatch(/lineLinkItemMismatch\(/);
        return;
      }
      /* Substring, not a regex: the call is written across two lines as
         `assertLinkedLineItemsMatch(sb, '<table>',` at every site. */
      expect(block, `${site.label}: no assertLinkedLineItemsMatch against ${site.table} at this call site`)
        .toContain(`assertLinkedLineItemsMatch(sb, '${site.table}'`);
    });
  }
});
