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

  it('refuses a bind whose two lines name a different product', () => {
    expect(block).toMatch(/so_link_material_mismatch/);
  });
});
