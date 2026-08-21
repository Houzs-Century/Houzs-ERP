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
// one. This gate is that stop: it fails when a transaction document's edit
// carries no inherited-field lock, so a hole cannot merge silently.
//
// This is the cheap, zero-runtime-risk foundation of the "one engine" the rules
// are being consolidated into (backend/src/scm/shared/header-inherited-lock.ts):
// the shared decision code is the engine; this gate keeps every document wired
// to it.
//
// WHAT IT GUARDS. Three sibling-drift classes, each its own manifest + self-test:
//
//   1. HEADER inherited-field lock — a transaction document's header PATCH must
//      field-level-lock its inherited columns (the original guard class).
//   2. LINE-edit inherited-line guard — a document whose PATCH /:id/items/:itemId
//      can re-point a line onto the parent's own material must call
//      `unlinkedEditRefusal` (scm/lib/unlinked-line-edit-guard.ts).
//   3. CANCEL child-first guard — a document's PATCH /:id/cancel must consult its
//      `*HasDownstream` guard (scm/lib/downstream-lock.ts and the per-doc
//      equivalents), so a parent cannot be cancelled out from under a live child.
//
// A class flags when a route file in its MANIFEST no longer contains the guard
// symbol. Absence = that document silently lost the guard.
//
// WHAT IT IS NOT. It proves the guard SYMBOL is present and wired, not that the
// chosen guard is semantically complete for that document — that is a judgement
// the owner rules on (which fields a child snapshots, which children count as
// downstream). A green run means "no transaction document silently lost a guard
// its siblings still carry", not "every guard's rule is right". Adding a new
// transaction document REQUIRES adding it to the manifest of every class it
// belongs to, which forces the author to decide its guards rather than forget
// them.
// ----------------------------------------------------------------------------
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(HERE, '..', 'src', 'scm', 'routes');

/* ── CLASS 1: HEADER inherited-field lock ──────────────────────────────────
   Every transaction document whose HEADER edit must carry an inherited-field
   lock, and the symbol that proves it. Each symbol is the doc's field-level
   lock — the shared `changedLockedCols`, a per-doc `changed*IdentityLockCols`,
   or the doc's identity-lock column set. To add a transaction document, add a
   row here; that is the point — it cannot be forgotten. */
const HEADER_MANIFEST = [
  { doc: 'Sales Order',                 file: 'mfg-sales-orders.ts',              symbols: ['changedIdentityLockCols', 'SO_IDENTITY_LOCK_COLS'] },
  { doc: 'Purchase Order',              file: 'mfg-purchase-orders.ts',           symbols: ['changedPoIdentityLockCols'] },
  { doc: 'Goods Received Note',         file: 'grns.ts',                          symbols: ['grnHeaderInheritedChanges'] },
  { doc: 'Delivery Order',              file: 'delivery-orders-mfg.ts',           symbols: ['changedLockedCols', 'DO_IDENTITY_LOCK_COLS'] },
  { doc: 'Consignment Order',           file: 'consignment-orders.ts',            symbols: ['CO_IDENTITY_LOCK_COLS'] },
  { doc: 'Consignment Note',            file: 'consignment-notes.ts',             symbols: ['changedLockedCols', 'CN_IDENTITY_LOCK_COLS'] },
  { doc: 'Purchase-Consignment Order',  file: 'purchase-consignment-orders.ts',   symbols: ['changedLockedCols', 'PCO_IDENTITY_LOCK_COLS'] },
  { doc: 'PC Receive',                  file: 'purchase-consignment-receives.ts', symbols: ['changedLockedCols', 'PCR_IDENTITY_LOCK_COLS'] },
];

/* ── CLASS 2: LINE-edit inherited-line guard ───────────────────────────────
   Documents whose PATCH /:id/items/:itemId can re-point a line onto material
   the parent already carries. Each MUST call `unlinkedEditRefusal` so the edit
   cannot silently create an unlinked line. This set is the EXACT current set of
   callers under scm/routes (grep unlinkedEditRefusal — do not assume it): it
   matches the per-handler wiring test in
   scm/lib/unlinked-line-edit-guard.test.ts one-for-one. A new document with a
   line-edit path belongs here the day it merges. */
const LINE_EDIT_MANIFEST = [
  { doc: 'Goods Received Note', file: 'grns.ts',             symbols: ['unlinkedEditRefusal'] },
  { doc: 'Purchase Return',     file: 'purchase-returns.ts', symbols: ['unlinkedEditRefusal'] },
  { doc: 'Delivery Return',     file: 'delivery-returns.ts', symbols: ['unlinkedEditRefusal'] },
  { doc: 'Sales Invoice',       file: 'sales-invoices.ts',   symbols: ['unlinkedEditRefusal'] },
];

/* ── CLASS 3: CANCEL child-first guard ─────────────────────────────────────
   Documents whose PATCH /:id/cancel must refuse while a live child exists.
   Each names the `*HasDownstream` guard its cancel handler must consult — the
   four shared ones in scm/lib/downstream-lock.ts plus the four per-doc helpers
   the consignment family defines in-file. A cancel path that stops calling its
   guard would let a parent be cancelled under a live child; this catches the
   symbol vanishing from the file. */
const CANCEL_MANIFEST = [
  { doc: 'Sales Order',                 file: 'mfg-sales-orders.ts',              symbols: ['soHasDownstream'] },
  { doc: 'Purchase Order',              file: 'mfg-purchase-orders.ts',           symbols: ['poHasDownstream'] },
  { doc: 'Delivery Order',              file: 'delivery-orders-mfg.ts',           symbols: ['doHasDownstream'] },
  { doc: 'Goods Received Note',         file: 'grns.ts',                          symbols: ['grnHasDownstream'] },
  { doc: 'Consignment Order',           file: 'consignment-orders.ts',            symbols: ['coHasDownstream'] },
  { doc: 'Consignment Note',            file: 'consignment-notes.ts',             symbols: ['noteHasDownstream'] },
  { doc: 'Purchase-Consignment Order',  file: 'purchase-consignment-orders.ts',   symbols: ['pcoHasDownstream'] },
  { doc: 'PC Receive',                  file: 'purchase-consignment-receives.ts', symbols: ['pcReceiveHasDownstream'] },
];

/* Each class carries its own allowlist of documents that genuinely have no
   guard of that class, WITH the reason. Empty today; an entry here is a
   deliberate, reviewed exemption, never a silence. */
const HEADER_ALLOWLIST = new Map([
  // e.g. ['some-doc.ts', 'header is terminal / has no downstream child'],
]);
const LINE_EDIT_ALLOWLIST = new Map([
  // e.g. ['some-doc.ts', 'no line-edit path (header-only document)'],
]);
const CANCEL_ALLOWLIST = new Map([
  // e.g. ['some-doc.ts', 'terminal document — nothing downstream can exist'],
]);

const CLASSES = [
  {
    key: 'header',
    label: 'header inherited-field lock',
    manifest: HEADER_MANIFEST,
    allowlist: HEADER_ALLOWLIST,
    // A representative symbol, used only to prove the detector is alive.
    sampleSymbol: 'changedLockedCols',
    fixHint:
      'Fix: wire the document to the shared header lock (shared/header-inherited-lock.ts —\n' +
      'changedLockedCols + identityLockedRefusal), the way PO/GRN/DO/CN/PCO/PC-Receive are.\n' +
      'If it genuinely has no downstream child, add it to HEADER_ALLOWLIST here with a reason.',
  },
  {
    key: 'line-edit',
    label: 'line-edit inherited-line guard (unlinkedEditRefusal)',
    manifest: LINE_EDIT_MANIFEST,
    allowlist: LINE_EDIT_ALLOWLIST,
    sampleSymbol: 'unlinkedEditRefusal',
    fixHint:
      'Fix: call unlinkedEditRefusal in the PATCH /:id/items/:itemId handler\n' +
      '(scm/lib/unlinked-line-edit-guard.ts), the way GRN/purchase-return/delivery-return/\n' +
      'sales-invoice do. If the document has no line-edit path, add it to LINE_EDIT_ALLOWLIST\n' +
      'here with a reason.',
  },
  {
    key: 'cancel',
    label: 'cancel child-first guard (*HasDownstream)',
    manifest: CANCEL_MANIFEST,
    allowlist: CANCEL_ALLOWLIST,
    sampleSymbol: 'soHasDownstream',
    fixHint:
      'Fix: consult the document\'s *HasDownstream guard in its PATCH /:id/cancel handler\n' +
      '(scm/lib/downstream-lock.ts, or the per-doc helper), the way SO/PO/DO/GRN and the\n' +
      'consignment family do. If the document is terminal, add it to CANCEL_ALLOWLIST here\n' +
      'with a reason.',
  },
];

/* WHOLE-symbol match, not substring: `body.includes('changedLockedCols')` is
   still true for `changedLockedColsXX`, so a renamed-away guard would read as
   present and the gate would pass a real hole (caught by the self-test below on
   2026-08-20 — the exact "a checker that cannot match reports a clean run" trap
   CLAUDE.md warns about). A word boundary makes the match exact. */
const fileHasSymbol = (body, symbols) =>
  symbols.some((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body));

/* Self-test, run once PER CLASS: the detector must FLAG a body missing the
   guard, PASS a body that has it, and — the case that bit us — NOT be fooled by
   a symbol that is only a SUBSTRING of another identifier. A checker that cannot
   match must never report a clean run, so a broken matcher aborts the gate
   rather than passing it. */
function selfTestClass(label, sampleSymbol) {
  const good = `const x = ${sampleSymbol}(SET, updates, before);`;
  const bad = 'const x = updates.foo; // no guard here';
  const renamed = `const x = ${sampleSymbol}XX(SET, updates, before);`;
  if (!fileHasSymbol(good, [sampleSymbol]))
    throw new Error(`self-test [${label}]: detector missed a present symbol (${sampleSymbol})`);
  if (fileHasSymbol(bad, [sampleSymbol]))
    throw new Error(`self-test [${label}]: detector matched an absent symbol (${sampleSymbol})`);
  if (fileHasSymbol(renamed, [sampleSymbol]))
    throw new Error(`self-test [${label}]: detector fooled by a substring / renamed identifier (${sampleSymbol})`);
}

function checkClass({ label, manifest, allowlist, sampleSymbol }) {
  selfTestClass(label, sampleSymbol);
  const missing = [];
  let checked = 0;
  for (const { doc, file, symbols } of manifest) {
    const path = join(ROUTES, file);
    if (!existsSync(path)) { missing.push({ doc, file, reason: 'route file not found' }); continue; }
    if (allowlist.has(file)) { checked += 1; continue; }
    const body = readFileSync(path, 'utf8');
    checked += 1;
    if (!fileHasSymbol(body, symbols)) {
      missing.push({ doc, file, reason: `guard absent — expected one of: ${symbols.join(', ')}` });
    }
  }
  return { checked, missing };
}

function main() {
  let failed = false;
  for (const klass of CLASSES) {
    const { checked, missing } = checkClass(klass);
    console.log(`workflow-consistency [${klass.label}]: ${checked} transaction document(s) checked.`);
    if (missing.length === 0) {
      console.log(`  All checked documents carry the ${klass.label}. No drift.`);
      continue;
    }
    failed = true;
    console.error(`\nWORKFLOW-CONSISTENCY GATE FAILED — a transaction document is missing the ${klass.label}:\n`);
    for (const m of missing) console.error(`  ${m.doc} (${m.file}): ${m.reason}`);
    console.error(`\n${klass.fixHint}\n`);
  }
  return failed ? 1 : 0;
}

process.exit(main());
