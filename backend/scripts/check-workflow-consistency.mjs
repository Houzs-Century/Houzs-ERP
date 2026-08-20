#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-workflow-consistency.mjs — the transaction-workflow drift tripwire.
//
// WHY. The single most repeated defect in the transaction workflow is "one
// document grew a rule and its sibling did not". The GRN and PC-Receive HEADER
// edits shipped with NO downstream-lock at all while PO/DO/CO already had one —
// two live holes (supplier/currency changeable after the invoice was billed
// against them), found only by reading eight route files by hand. Every
// field-level header lock is now in place, but nothing STOPS the next
// transaction document — or the next header field — from being added without
// one. This gate is that stop: it fails when a transaction document's header
// edit carries no inherited-field lock, so a hole cannot merge silently.
//
// This is the cheap, zero-runtime-risk foundation of the "one engine" the rules
// are being consolidated into (backend/src/scm/shared/header-inherited-lock.ts):
// the shared decision code is the engine; this gate keeps every document wired
// to it.
//
// WHAT IT FLAGS. A transaction-document route file in the MANIFEST below whose
// header-edit lock symbol is absent from the file. Absence = that document's
// header PATCH no longer field-level-locks its inherited columns.
//
// WHAT IT IS NOT. It proves the lock SYMBOL is present and wired, not that the
// chosen lock COLUMN SET is correct for that document — that is a judgement the
// owner rules on (which fields a child snapshots). A green run means "no
// transaction document silently lost its header lock", not "every column choice
// is right". Adding a new transaction document REQUIRES adding it here, which
// forces the author to decide its lock rather than forget it.
// ----------------------------------------------------------------------------
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(HERE, '..', 'src', 'scm', 'routes');

/* Every transaction document whose HEADER edit must carry an inherited-field
   lock, and the symbol that proves it. Each symbol is the doc's field-level
   lock — the shared `changedLockedCols`, a per-doc `changed*IdentityLockCols`,
   or the doc's identity-lock column set. To add a transaction document, add a
   row here; that is the point — it cannot be forgotten. */
const MANIFEST = [
  { doc: 'Sales Order',                 file: 'mfg-sales-orders.ts',              symbols: ['changedIdentityLockCols', 'SO_IDENTITY_LOCK_COLS'] },
  { doc: 'Purchase Order',              file: 'mfg-purchase-orders.ts',           symbols: ['changedPoIdentityLockCols'] },
  { doc: 'Goods Received Note',         file: 'grns.ts',                          symbols: ['grnHeaderInheritedChanges'] },
  { doc: 'Delivery Order',              file: 'delivery-orders-mfg.ts',           symbols: ['changedLockedCols', 'DO_IDENTITY_LOCK_COLS'] },
  { doc: 'Consignment Order',           file: 'consignment-orders.ts',            symbols: ['CO_IDENTITY_LOCK_COLS'] },
  { doc: 'Consignment Note',            file: 'consignment-notes.ts',             symbols: ['changedLockedCols', 'CN_IDENTITY_LOCK_COLS'] },
  { doc: 'Purchase-Consignment Order',  file: 'purchase-consignment-orders.ts',   symbols: ['changedLockedCols', 'PCO_IDENTITY_LOCK_COLS'] },
  { doc: 'PC Receive',                  file: 'purchase-consignment-receives.ts', symbols: ['changedLockedCols', 'PCR_IDENTITY_LOCK_COLS'] },
];

/* Documents whose HEADER genuinely has no inherited-field lock, WITH the reason.
   Empty today; an entry here is a deliberate, reviewed exemption, never a
   silence. */
const ALLOWLIST = new Map([
  // e.g. ['some-doc.ts', 'header is terminal / has no downstream child'],
]);

/* WHOLE-symbol match, not substring: `body.includes('changedLockedCols')` is
   still true for `changedLockedColsXX`, so a renamed-away lock would read as
   present and the gate would pass a real hole (caught by the self-test below on
   2026-08-20 — the exact "a checker that cannot match reports a clean run" trap
   CLAUDE.md warns about). A word boundary makes the match exact. */
const fileHasSymbol = (body, symbols) =>
  symbols.some((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body));

/* Self-test: the detector must FLAG a body missing every symbol, PASS a body
   that has one, and — the case that bit us — NOT be fooled by a symbol that is
   only a SUBSTRING of another identifier. A checker that cannot match must never
   report a clean run. */
function selfTest() {
  const good = 'const x = changedLockedCols(SET, updates, before);';
  const bad = 'const x = updates.foo; // no lock here';
  const renamed = 'const x = changedLockedColsXX(SET, updates, before);';
  if (!fileHasSymbol(good, ['changedLockedCols'])) throw new Error('self-test: detector missed a present symbol');
  if (fileHasSymbol(bad, ['changedLockedCols'])) throw new Error('self-test: detector matched an absent symbol');
  if (fileHasSymbol(renamed, ['changedLockedCols'])) throw new Error('self-test: detector fooled by a substring (renamed identifier)');
}

function main() {
  selfTest();
  const missing = [];
  let checked = 0;
  for (const { doc, file, symbols } of MANIFEST) {
    const path = join(ROUTES, file);
    if (!existsSync(path)) { missing.push({ doc, file, reason: 'route file not found' }); continue; }
    if (ALLOWLIST.has(file)) { checked += 1; continue; }
    const body = readFileSync(path, 'utf8');
    checked += 1;
    if (!fileHasSymbol(body, symbols)) {
      missing.push({ doc, file, reason: `no inherited-field lock — expected one of: ${symbols.join(', ')}` });
    }
  }

  console.log(`workflow-consistency: ${checked} transaction document(s) checked for a header inherited-field lock.`);
  if (missing.length === 0) {
    console.log('All transaction documents field-level-lock their header. No drift.');
    return 0;
  }
  console.error('\nWORKFLOW-CONSISTENCY GATE FAILED — a transaction document has no header inherited-field lock:\n');
  for (const m of missing) console.error(`  ${m.doc} (${m.file}): ${m.reason}`);
  console.error('\nFix: wire the document to the shared header lock (shared/header-inherited-lock.ts —');
  console.error('changedLockedCols + identityLockedRefusal), the way PO/GRN/DO/CN/PCO/PC-Receive are.');
  console.error('If it genuinely has no downstream child, add it to ALLOWLIST here with a reason.');
  return 1;
}

process.exit(main());
