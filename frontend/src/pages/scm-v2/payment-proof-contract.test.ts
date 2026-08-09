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

/** The `<PaymentsTable …/>` element on the SO detail page. */
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
    // The two gates that freeze LINES must never reach the money.
    expect(element).not.toMatch(/locked=\{[^}]*isLocked/);
    expect(element).not.toMatch(/locked=\{[^}]*!isEditing/);
  });

  test('payments carry their own edit toggle, opt-in and cancelled-only-shut', () => {
    expect(detailSource).toContain('const [payEditing, setPayEditing] = useState(');
    expect(detailSource).toContain('headerAction={canOfferPayEdit ?');
    /* Declared with the page state, ABOVE the isPending / isError early
       returns — a hook below them renders conditionally and React throws
       "Rendered more hooks than during the previous render" the moment the
       detail query resolves. Caught in the browser the first time; pinned here
       so the next person moving it next to its derivation gets a test failure
       instead of a blank page. */
    const firstEarlyReturn = detailSource.search(/\n  if \(detail\.isPending\)/);
    expect(firstEarlyReturn).toBeGreaterThan(-1);
    expect(detailSource.indexOf('const [payEditing, setPayEditing] = useState('))
      .toBeLessThan(firstEarlyReturn);
    /* Only CANCELLED shuts the ledger — same rule as MobileSODetail's
       `paymentLocked`. A DRAFT stays open without the toggle (never confirmed);
       everything else is opt-in, so the no-naked-edits rule survives. */
    expect(detailSource).toContain(
      'const canEditPayments  = isDraftSo || (!isCancelled && (isEditing || payEditing));',
    );
  });
});

describe('the door into the payments ledger', () => {
  /* The ledger lives ONLY on the ?edit=1 editor, and V2's Edit button answers
     to the LINE/HEADER lock: disabled when hard-locked, relabelled to "Submit
     SO Amendment" when amendment-eligible. Without a second door a DELIVERED SO
     has no reachable Payments section at all — the toggle above would be
     correct and still unusable, which is exactly how this shipped broken the
     first time. */
  test('every order that can take money gets a payments-only entry point', () => {
    expect(readViewSource).toContain('const goPayments =');
    expect(readViewSource).toContain('?payments=1');
    expect(readViewSource).toContain('Collect payment');
    /* Gated on the MONEY, not the lock. The first cut read `hardLocked && …`,
       which is a 2990 delivery-flow assumption: on Houzs every SO sits at
       CONFIRMED with a balance still owing, so the button never appeared where
       it was most needed. Only CANCELLED takes no money (DRAFT is out on the
       standing "no payments on drafts" ruling, and is never locked anyway). */
    expect(readViewSource).toContain(
      '{!["cancelled", "draft"].includes(salesOrder.status?.toLowerCase() ?? "") && (',
    );
    expect(readViewSource).not.toContain('{hardLocked && salesOrder.status');
  });

  test('collecting stays on the read page; only edit=1 swaps to the editor', () => {
    /* 2026-08-09 (owner: "点选 collect payment … 全部 UI 都不一样") — the read
       page now hosts the shared PaymentsTable itself; `?payments=1` merely
       seeds its Edit toggle. Folding payments into `edit=1` would reopen the
       whole form, so the fork must name edit alone. */
    expect(readViewSource).toContain('if (params.get("edit") === "1") {');
    expect(readViewSource).toContain('useState(params.get("payments") === "1")');
    expect(readViewSource).toContain('<PaymentsTable');
    // The legacy editor keeps its own payments-only door for `edit=1` sessions.
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
    expect(tableSource).toContain("{addPayment.isPending ? 'Saving…' : 'Save'}");
  });

  test('the row is marked, and the mark reaches the summary line too', () => {
    expect(tableSource).toContain('paymentsStyles.unsavedPill');
    expect(tableSource).toContain("const unsavedCls = isSaved ? paymentsStyles.unsavedCell : '';");
    expect(tableSource).toContain('{drafts.length} unsaved');
  });

  test('the actions track widens for the labelled button', () => {
    /* 28px only ever fitted icons. If this reverts to a fixed 28px the Save
       label is clipped, which is worse than the glyph it replaced. */
    expect(tableSource).toContain('const hasUnsavedRows = drafts.length > 0;');
    expect(tableSource).toContain("${hasUnsavedRows ? '104px' : '28px'}");
    expect(tableSource).toContain('minWidth: hasUnsavedRows ? 956 : 880,');
  });

  test('the marking is SAVED-mode only', () => {
    /* On New SO / DO / SI every row is unsaved by definition and the page's own
       Save commits them all — a per-row pill there is noise, not information.

       Matched with a whitespace-tolerant regex: the first cut pinned the exact
       newline and indentation, and a reformat broke the test without changing
       a thing about the behaviour it guards. A contract test that fails on
       whitespace teaches people to delete contract tests. */
    expect(tableSource).toMatch(
      /\{isSaved\s*&&\s*\(\s*<span className=\{paymentsStyles\.unsavedPill\}>Unsaved<\/span>/,
    );
    expect(tableSource).toContain(
      "const unsavedCls = isSaved ? paymentsStyles.unsavedCell : '';",
    );
  });
});

describe('leaving with unbooked payment rows', () => {
  /* Marks warn; they do not stop anyone. The loss that started all of this was
     "filled it in and left", so the exits themselves are guarded. */

  test('the browser-owned exits are covered by a beforeunload guard', () => {
    expect(tableSource).toContain("window.addEventListener('beforeunload', warn)");
    expect(tableSource).toContain("window.removeEventListener('beforeunload', warn)");
    /* SAVED mode only — a New SO / DO / SI form is legitimately all-unsaved and
       would prompt on every exit. */
    expect(tableSource).toContain('const unsavedCount = isSaved ? drafts.length : 0;');
  });

  test('the page is told the count, so it can guard the exits it owns', () => {
    expect(tableSource).toContain('onUnsavedChange?.(unsavedCount);');
    // Reported back to zero on unmount, or the page guards work that is gone.
    expect(tableSource).toContain('return () => onUnsavedChange?.(0);');
    expect(detailSource).toContain('onUnsavedChange={setUnsavedPayments}');
  });

  test('back and the payments Done toggle both run the guard', () => {
    expect(detailSource).toContain('<PageHeader back beforeBack={guardUnsavedPayments}');
    expect(detailSource).toContain('if (payEditing && !(await guardUnsavedPayments())) return;');
    /* The guard names the MONEY, not "unsaved changes" — an operator told
       "1 payment row" can decide in one read. */
    expect(detailSource).toMatch(/Leave \$\{unsavedPayments\} payment row/);
  });
});

describe('PaymentsTable persisted-row proof uploader', () => {
  test('is gated by `locked` only, never by the same-day window', () => {
    expect(tableSource).toContain('{isSaved && !locked && (');
    /* rowMutable gates the pencil and the trash (money), and must not appear in
       the same JSX guard as the proof uploader. */
    const guard = tableSource.slice(
      tableSource.indexOf('{isSaved && !locked && ('),
      tableSource.indexOf('onConfirmed={(sid) => attachSlipToPayment('),
    );
    expect(guard).not.toContain('rowMutable');
  });

  test('attaches through the dedicated slip route, not the same-day PATCH', () => {
    expect(tableSource).toContain('useAttachSalesOrderPaymentSlip');
    // commitEdit (the PATCH) still must not carry a slip — that route is locked.
    const commitEdit = tableSource.slice(
      tableSource.indexOf('const commitEdit ='),
      tableSource.indexOf('const commitDraft ='),
    );
    expect(commitEdit).not.toContain('uploadSessionId');
  });
});
