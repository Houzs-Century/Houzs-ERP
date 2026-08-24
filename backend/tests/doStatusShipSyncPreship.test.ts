// The ship-time SO sync fires for EVERY pre-ship → shipped hop, not only DRAFT.
//
// The stock OUT on the status PATCH fires on entry to any SHIPPED state, from
// either pre-ship status (DRAFT or LOADED). The SO coverage sync next to it was
// gated `prevStatus === 'DRAFT'`, so a LOADED→DISPATCHED hop shipped the goods
// and never advanced the SO — it sat at CONFIRMED/READY_TO_SHIP while MRP kept
// planning purchases for goods already on the road (the 2026-08-17 incident
// class, docs/bugs/ ledger). The gate now reads DO_PRESHIP_STATUSES, the same
// set the transition guard and the deduction logic key on.
//
// Structural, not behavioural: the handler needs a live DB to run, so this pins
// the SOURCE — the sync call inside the shipped-entry branch is gated on the
// shared pre-ship set, and no DRAFT-literal gate guards it. The slice is
// bounded at both ends so a different handler cannot satisfy it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '../src/scm/routes/delivery-orders-mfg.ts'),
  'utf8',
);

/* The shipped-entry branch: from the deduction call to the customer-email
   comment that follows the sync. Both anchors are unique in the file. */
function shipEntryBranch(): string {
  const start = SRC.indexOf('movementErrors = await deductInventoryForDo(sb, id, user.id);');
  const end = SRC.indexOf('Customer DO email (owner trigger "A"', start);
  expect(start, 'deduction call not found — did the status PATCH move?').toBeGreaterThan(-1);
  expect(end, 'email comment anchor not found after the deduction').toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('status PATCH — ship-time SO sync covers both pre-ship origins', () => {
  it('gates the sync on DO_PRESHIP_STATUSES, so LOADED→shipped syncs like DRAFT→shipped', () => {
    const branch = shipEntryBranch();
    expect(branch).toContain('DO_PRESHIP_STATUSES.has(prevStatus)');
    expect(branch).toContain('syncSoDeliveredFromDo');
  });

  it('carries no DRAFT-literal gate in that branch — the shape that skipped LOADED', () => {
    expect(shipEntryBranch()).not.toMatch(/prevStatus\s*===\s*'DRAFT'/);
  });

  it('DO_PRESHIP_STATUSES is built from the shared set, not hand-typed', () => {
    expect(SRC).toMatch(/DO_PRESHIP_STATUSES = new Set<string>\(DO_PRESHIP_STATES\)/);
  });
});
