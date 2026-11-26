/* Balance-collection proof contract (owner 2026-08-07).

   Two regressions this pins, both of which have already happened once:

   1. The SO detail's Payments card must NOT take its lock from the PAGE's Edit
      mode. Page Edit is gated by `isLocked` (terminal status / downstream
      DO-SI) — the LINE/HEADER lock — and a balance is collected exactly when
      the SO is in that state. The 2026-07-17 fix dropped `isLocked` from the
      `locked` prop but replaced it with `!isEditing`, which reaches the same
      lock through the page Edit button's own `disabled={isLocked}`. The card
      needs its own toggle, as mobile has had since the same date.

   2. The proof uploader on a PERSISTED row must not be gated by the same-day
      window (`rowMutable`). That window guards the money; the proof for a
      balance collected on delivery routinely arrives days later.

   Source-text assertions rather than a render test: the bug is in which gate
   feeds which prop, which is exactly what the text shows and what a mocked
   render would paper over. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const detailSource = readFileSync(
  resolve(process.cwd(), 'src/pages/scm-v2/SalesOrderDetail.tsx'), 'utf8',
);
const tableSource = readFileSync(
  resolve(process.cwd(), 'src/vendor/scm/components/PaymentsTable.tsx'), 'utf8',
);
const readViewSource = readFileSync(
  resolve(process.cwd(), 'src/pages/scm-v2/SalesOrderDetailV2.tsx'), 'utf8',
);

const paymentsTableElement = (): string => {
  const start = detailSource.indexOf('<PaymentsTable');
  expect(start).toBeGreaterThan(-1);
  const end = detailSource.indexOf('/>', start);
  expect(end).toBeGreaterThan(start);
  return detailSource.slice(start, end);
};

describe('SO detail payments lock', () => {
  test('does not inherit the page-level edit / header lock', () => {
    const element = paymentsTableElement();
    expect(element).toContain('locked={!canEditPayments}');
    expect(element).not.toMatch(/locked=\{[^}]*isLocked/);
    expect(element).not.toMatch(/locked=\{[^}]*!isEditing/);
  });

  test('payments carry their own edit toggle, opt-in and cancelled-only-shut', () => {
    expect(detailSource).toContain('const [payEditing, setPayEditing] = useState(');
    expect(detailSource).toContain('headerAction={canOfferPayEdit ?');
    const firstEarlyReturn = detailSource.search(/\n  if \(detail\.isPending\)/);
    expect(firstEarlyReturn).toBeGreaterThan(-1);
    expect(detailSource.indexOf('const [payEditing, setPayEditing] = useState('))
      .toBeLessThan(firstEarlyReturn);
    expect(detailSource).toContain(
      'const canEditPayments  = !migratedLocked && (isDraftSo || (!isCancelled && (isEditing || payEditing)));',
    );
    expect(detailSource).toContain('const canOfferPayEdit  = !migratedLocked && !isDraftSo');
  });
});

describe('the door into the payments ledger', () => {
  test('every order that can take money gets a payments-only entry point', () => {
    expect(readViewSource).toContain('const goPayments =');
    expect(readViewSource).toContain('?payments=1');
    expect(readViewSource).toContain('Collect payment');
    /* Gated on the MONEY, not the lock. The first cut read `hardLocked && …`,
       which is a 2990 delivery-flow assumption: on Houzs every SO sits at
       CONFIRMED with a balance still owing, so the button never appeared where
       it was most needed. Only CANCELLED takes no money (DRAFT is out on the
       standing "no payments on drafts" ruling, and is never locked anyway).

       ONE further term since 2026-09-08, and it is still not a lock: a MIGRATED
       order. Its balance is the one figure the ERP knows is wrong (AutoCount
       payments taken since 2026-08-28 have not reached us), so there is no money
       to collect against it here and the server refuses the write anyway. That
       is a fact about the MONEY, which is exactly what this test says the gate
       must be about — see docs/bugs/0687-*, where the button shipped live on a
       migrated order because nothing pointed at this bar. */
    expect(readViewSource).toContain(
      '{!migratedLocked && !["cancelled", "draft"].includes(salesOrder.status?.toLowerCase() ?? "") && (',
    );
    expect(readViewSource).not.toContain('{hardLocked && salesOrder.status');
  });

  /* A CANCELLED order takes no money, but Finance may take off money that never
     came in on it (owner 2026-09-29: one swipe keyed on two orders). The card
     stays shut and hands the table its remove door — never on a migrated
     order, whose payment writes the server refuses. */
  test('a cancelled order hands Finance the remove door and nothing else', () => {
    expect(readViewSource).toContain('cancelledRemoval={soStatus === "cancelled" && !migratedLocked}');
    expect(readViewSource).toContain('locked={!canEditPayments}');
  });

  test('collecting stays on the read page; only edit=1 swaps to the editor', () => {
    /* 2026-08-09 (owner: "点选 collect payment … 全部 UI 都不一样") — the read
       page now hosts the shared PaymentsTable itself; `?payments=1` merely
       seeds its Edit toggle. Folding payments into `edit=1` would reopen the
       whole form, so the fork must name edit alone. */
    expect(readViewSource).toContain('if (params.get("edit") === "1") {');
    expect(readViewSource).toContain('useState(params.get("payments") === "1")');
    expect(readViewSource).toContain('<PaymentsTable');
    expect(detailSource).toContain("editSearchParams.get('payments') === '1'");
    expect(detailSource).not.toMatch(/setIsEditing\([^)]*payments/);
  });
});

describe('unsaved payment rows are legible as unsaved', () => {
  /* Owner 2026-08-07, from a real loss on prod: a balance row was filled in,
     its slip attached, the uploader turned into a green tick, and the operator
     left. The tick meant "the file reached R2" — nothing had been booked. The
     row was visually identical to the payments above it and its only commit
     affordance was a 14px glyph.

     These assertions are about a row SAYING what it is. A future pass that
     re-tidies the actions column back to icons should fail here rather than
     silently reinstate the trap. */

  test('the commit control carries a word, not just a glyph', () => {
    expect(tableSource).toContain('className={paymentsStyles.saveBtn}');
    expect(tableSource).toContain("{addPayment.isPending || raiseBackdate.isPending || rowLock.isLocked(d.uid) ? 'Saving…' : asRequest ? 'Request approval' : 'Save'}");
  });

  test('the row is marked, and the mark reaches the summary line too', () => {
    expect(tableSource).toContain('paymentsStyles.unsavedPill');
    expect(tableSource).toContain("const unsavedCls = isSaved ? paymentsStyles.unsavedCell : '';");
    expect(tableSource).toContain('{drafts.length} unsaved');
  });

  test('the actions track widens for the labelled button', () => {
    expect(tableSource).toContain('const hasUnsavedRows = drafts.length > 0;');
    expect(tableSource).toContain("${hasUnsavedRows ? '104px' : '28px'}");
    expect(tableSource).toContain('minWidth: hasUnsavedRows ? 956 : 880,');
  });

  test('the marking is SAVED-mode only', () => {
    expect(tableSource).toMatch(
      /\{isSaved\s*&&\s*\(\s*<span className=\{paymentsStyles\.unsavedPill\}>Unsaved<\/span>/,
    );
    expect(tableSource).toContain(
      "const unsavedCls = isSaved ? paymentsStyles.unsavedCell : '';",
    );
  });
});

describe('leaving with unbooked payment rows', () => {

  test('the browser-owned exits are covered by a beforeunload guard', () => {
    expect(tableSource).toContain("window.addEventListener('beforeunload', warn)");
    expect(tableSource).toContain("window.removeEventListener('beforeunload', warn)");
    expect(tableSource).toContain('const unsavedCount = isSaved ? drafts.length : 0;');
  });

  test('the page is told the count, so it can guard the exits it owns', () => {
    expect(tableSource).toContain('onUnsavedChange?.(unsavedCount);');
    expect(tableSource).toContain('return () => onUnsavedChange?.(0);');
    expect(detailSource).toContain('onUnsavedChange={setUnsavedPayments}');
  });

  test('back and the payments Done toggle both run the guard', () => {
    expect(detailSource).toContain('<PageHeader back beforeBack={guardUnsavedPayments}');
    expect(detailSource).toContain('if (payEditing && !(await guardUnsavedPayments())) return;');
    expect(detailSource).toMatch(/Leave \$\{unsavedPayments\} payment row/);
  });
});

describe('PaymentsTable persisted-row proof uploader', () => {
  test('is gated by `locked` only, never by the same-day window', () => {
    expect(tableSource).toContain('{isSaved && !locked && (');
    const guard = tableSource.slice(
      tableSource.indexOf('{isSaved && !locked && ('),
      tableSource.indexOf('onConfirmed={(sid) => attachSlipToPayment('),
    );
    expect(guard).not.toContain('rowMutable');
  });

  test('attaches through the dedicated slip route, not the same-day PATCH', () => {
    expect(tableSource).toContain('useAttachSalesOrderPaymentSlip');
    const commitEdit = tableSource.slice(
      tableSource.indexOf('const commitEdit ='),
      tableSource.indexOf('const commitDraftOnce ='),
    );
    expect(commitEdit).not.toContain('uploadSessionId');
  });
});
