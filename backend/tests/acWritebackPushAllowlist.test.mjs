// WHICH SCRIPTS ARE ALLOWED TO WRITE INTO THE LIVE ACCOUNT BOOK.
//
// Every client `pgrestShim` builds is a repair client by default, so a script
// cannot queue an AutoCount write-back unless it says `writeback: "enqueue"`.
// That default is what protects the owner's book from our cutover repairs
// (2026-09-09: 173 sales orders queued from repair work, 316 already sent).
//
// But a default only protects while the opt-out stays rare. Nothing stops a
// future repair from copying the flag out of a neighbouring file — that is
// exactly how `recompute-2990-so-allocation.yml` was wired to secrets that do
// not exist, "by name similarity rather than by evidence the precedent runs".
//
// So the list is PINNED here. Adding a script to it is a deliberate edit to a
// test whose name says what the list means, which is the thing a reviewer can
// see. Removing one is free.
//
// The bar for being on this list: the script's PURPOSE is to send a document to
// AutoCount. A repair that happens to touch a document it has already sent does
// NOT qualify — that is the bug this whole mechanism exists to stop.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/* Every extension node or tsx will run. It read only `.mjs` and `.ts`, and
   enqueue-so-writeback.mts pushed to the book unseen
   (docs/bugs/0888-the-account-book-push-allowlist-could-not-see-a-mts-script.md). */
const runnable = (f) => /\.[cm]?[jt]s$/.test(f);

/** Scripts whose reason for existing is to push a document into AutoCount. */
const MAY_PUSH = [
  // Re-sends ONE named document whose lines landed wrong (docs/bugs/0615).
  'rebuild-ac-document.mjs',
  // Re-queues a document the composer refused, once the cause is fixed.
  'requeue-autocount-skipped.mjs',
  // Rebuilds a conversion the book and the ERP disagree about.
  'recompose-autocount-transfer.mjs',
  // LANES=push carries person-owned SO fields out to the book. Its other lanes
  // are repairs and use a separate, suppressed client.
  'sync-ac-delta.mjs',
  // A one-shot re-raise of a single purchase order.
  'reraise-hc-po-2608-001.mjs',
  // Re-queues the edits approved amendments never queued
  // (docs/bugs/0888-approved-so-and-po-amendments-queued-no-autocount-edit-from.md).
  'requeue-amendment-ac-edits.mjs',
  // Re-sends a DO / GR edit refused for a keyless line once its keys are in
  // (docs/bugs/0900) — its purpose is the send; it writes no ERP value.
  'requeue-keyed-conversion-edits.mjs',
  // Zeroes a DO / GR line the ERP removed but the book still holds
  // (docs/bugs/0902) — the send IS the repair; it writes no ERP value.
  'retire-book-only-conversion-lines.mjs',
  // Sends named documents' current state as a keyed edit (docs/bugs/0903) -
  // its purpose is the send; it writes no ERP value.
  'resend-ac-document-edits.mjs',
  // Re-pushes a sales order's corrected balance after a direct SQL repair left
  // the book stale (docs/bugs/0785, the orphan scan-deposit fix).
  'enqueue-so-writeback.mts',
  // Removes ONE service/charge line from a processing-locked / delivered SO whose
  // in-app delete route refuses it, and enqueues the AutoCount RETIRE so the book
  // does not keep the removed line live and outstanding. The send is HALF the
  // repair: retiredLineOf + enqueueEdit({retire}) let composeSoState build the
  // exact payload the delete route would, so nothing accounting-side is hand-made.
  'remove-so-storage-line.mts',
  // Puts our purchase order numbers back in the book's PO Doc No. where the
  // write-back had written the order's reference (docs/bugs/0926, 0927) - the
  // send IS the repair; it writes no ERP value.
  'repair-ac-po-doc-no.mjs',
];

test('only the deliberate push tools opt out of repair suppression', () => {
  const found = readdirSync(SCRIPTS)
    .filter(runnable)
    .filter((f) => {
      const src = readFileSync(join(SCRIPTS, f), 'utf8');
      // The shim call carrying the opt-in, on one line or wrapped.
      return /pgrestShim\([^)]*writeback:\s*["']enqueue["']/s.test(src);
    })
    .sort();

  assert.deepEqual(
    found,
    [...MAY_PUSH].sort(),
    'A script gained or lost `writeback: "enqueue"`. If it is a NEW repair, it must not have that flag — '
    + 'a repair copies a value OUT of the account book and sending it back overwrites the owner\'s source of truth. '
    + 'If it is genuinely a push tool, add it to MAY_PUSH above with a line saying why.',
  );
});

test('no script under scripts/ imports the enqueue functions without going through the shim', () => {
  /* The shim is the choke point the default lives on. A script that imports
     enqueueEdit and builds its own supabase-shaped client would walk straight
     past it — so the ones that DO import an enqueue function must also be the
     ones that build a client here. */
  const importers = readdirSync(SCRIPTS)
    .filter(runnable)
    .filter((f) => /import\s*\{[^}]*\benqueue(Edit|AcOp|SoCreate|PoCreate|Convert|Cancel)\b/s
      .test(readFileSync(join(SCRIPTS, f), 'utf8')))
    .sort();

  const notShimmed = importers.filter(
    (f) => !/pgrestShim\(/.test(readFileSync(join(SCRIPTS, f), 'utf8')),
  );

  assert.deepEqual(
    notShimmed,
    [],
    'This script imports an enqueue function but does not build its client with pgrestShim, '
    + 'so the repair-suppression default cannot reach it. Use pgrestShim — and only pass '
    + '`writeback: "enqueue"` if pushing to AutoCount is what the script is FOR.',
  );
});
