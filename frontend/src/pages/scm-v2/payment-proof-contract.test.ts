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
  /* The ledger lives ONLY on the ?edit=1 editor, and V2's Edit button is
     `disabled={hardLocked}`. Without a second door a DELIVERED SO has no
     reachable Payments section at all — the toggle above would be correct and
     still unusable, which is exactly how this shipped broken the first time. */
  test('a hard-locked order still gets a payments-only entry point', () => {
    expect(readViewSource).toContain('const goPayments =');
    expect(readViewSource).toContain('?payments=1');
    expect(readViewSource).toContain('Collect payment');
    // Offered where Edit is not, and never on an order that takes no money.
    expect(readViewSource).toContain(
      '{hardLocked && salesOrder.status?.toLowerCase() !== "cancelled" && (',
    );
  });

  test('that entry point routes to the editor, and does not open the whole form', () => {
    expect(readViewSource).toContain(
      'if (params.get("edit") === "1" || params.get("payments") === "1") {',
    );
    // `payments=1` must NOT be folded into the `edit` flag: page-edit unlocks
    // every field, and on a locked order only the money may move.
    expect(detailSource).toContain("editSearchParams.get('payments') === '1'");
    expect(detailSource).not.toMatch(/setIsEditing\([^)]*payments/);
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
