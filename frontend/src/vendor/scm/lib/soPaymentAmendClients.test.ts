/* Both payment screens ask the predicate the SAME question the server does.
 *
 * WHY A SOURCE TEST. The rule itself is pinned in so-field-policy.test.ts, and
 * check-shared-mirrors.mjs proves this copy of it matches the server's. What
 * neither can see is whether the two screens still pass the fourth argument —
 * and dropping it is silent: the call still compiles, still type-checks, and
 * simply goes back to hiding the control from Finance on every payment older
 * than today. The desktop table and the mobile sheet have diverged on exactly
 * this predicate before (the delete path vs the edit path, 2026-07-19), which
 * is why both are named here rather than one standing in for the other.
 */
import { describe, expect, test } from 'vitest';

const sources = import.meta.glob(
  ['../components/PaymentsTable.tsx', '../../../mobile/RecordedPayments.tsx'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const fileEnding = (suffix: string): string => {
  const hit = Object.entries(sources).find(([path]) => path.endsWith(suffix));
  expect(hit, `${suffix} did not load — a silent empty glob must not pass`).toBeTruthy();
  const text = hit![1];
  expect(text.length, `${suffix} loaded empty`).toBeGreaterThan(1000);
  return text;
};

const SCREENS: ReadonlyArray<[string, string]> = [
  ['desktop payments table', 'PaymentsTable.tsx'],
  ['mobile recorded payments', 'RecordedPayments.tsx'],
];

describe('the payment screens and the amend right', () => {
  test('both read the permission by its real key', () => {
    for (const [name, suffix] of SCREENS) {
      expect(fileEnding(suffix), `${name} does not read the amend permission`)
        .toMatch(/can\(["']scm\.so_payment\.amend["']\)/);
    }
  });

  test('both hand it to the shared predicate', () => {
    for (const [name, suffix] of SCREENS) {
      /* Not `[^)]*` between the two: the third argument is `todayMyt()`, whose
         own bracket ends that class and made this assertion fail on a call
         that was in fact correct. */
      expect(fileEnding(suffix), `${name} calls the predicate without the amend context`)
        .toMatch(/paymentRowMutable\([\s\S]{0,120}?\{ mayAmend \}\)/);
    }
  });

  /* The client must NOT invent a reconciliation. A settlement match and a bank
     statement live on the server; a screen that passed its own guess would
     either block a payment nobody has reconciled or wave through one somebody
     has. Offering the control and letting the endpoint refuse is the design. */
  test('neither claims to know whether the payment has been reconciled', () => {
    for (const [name, suffix] of SCREENS) {
      expect(fileEnding(suffix), `${name} passes a reconciliation it cannot know`)
        .not.toContain('reconciled:');
    }
  });
});

/* THE REASON (owner 2026-09-10: 靠权限改的来决定). A correction opened by the
   amend right asks for a reason BEFORE the write and sends it; a same-day fix
   asks nothing. Both screens have to read `via` off the predicate for that,
   and both have to hand the answer to the mutation — a screen that asked and
   then dropped the text would make the server refuse every Finance edit. */
describe('the payment screens ask for a reason on the amend right', () => {
  test('both read WHY the row may change, not only whether', () => {
    for (const [name, suffix] of SCREENS) {
      expect(fileEnding(suffix), `${name} never reads via`).toMatch(/\.via;/);
      expect(fileEnding(suffix), `${name} does not branch on the amend right`).toMatch(/=== ['"]amend['"]/);
    }
  });

  test('both ask through the shared prompt, with a REQUIRED input', () => {
    for (const [name, suffix] of SCREENS) {
      const text = fileEnding(suffix);
      expect(text, `${name} does not use the shared prompt`).toContain('usePrompt');
      expect(text, `${name} asks without requiring an answer`).toMatch(/required:\s*true/);
    }
  });

  test('both send the reason with the write, and abandon the write when the ask is dismissed', () => {
    for (const [name, suffix] of SCREENS) {
      const text = fileEnding(suffix);
      expect(text, `${name} drops the reason on the floor`).toMatch(/\{ reason \}/);
      expect(text, `${name} writes even when the ask was cancelled`).toContain('reason === null) return');
    }
  });
});
