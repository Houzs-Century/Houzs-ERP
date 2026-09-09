#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-address-line-max.mjs — the sales-order address boxes stop at the width
// the account book actually has.
//
// WHY THIS IS A GATE AND NOT A NOTE. AutoCount's four InvAddr columns are 40
// characters and it refuses the WHOLE document when one is over, so a customer
// whose street line ran past forty could not have a sales order in the accounts
// at all (docs/bugs/0728). The owner's instruction, 2026-09-09: lock our
// address to 40 characters. A limit that lives in prose is a limit the next
// address input will not have.
//
// IT CHECKS TWO THINGS, and the first is the one prose cannot hold:
//
//   1. THE NUMBER IS ONE NUMBER. The frontend cannot import from the backend,
//      so `ADDRESS_LINE_MAX` is a COPY of `AC_ADDRESS_LINE_MAX` — the width
//      measured on AED_HOUZS itself. This reads both files and fails if they
//      disagree, which is the only thing that makes the copy safe.
//
//   2. EVERY SALES-ORDER ADDRESS BOX GOES THROUGH `addressLineProps`. That
//      helper is the cap and the spill as ONE bundle, and they are not
//      separable: `maxLength` alone is the truncating regression — a browser
//      cuts an over-long PASTE to fit and the tail is gone, where the write-back
//      re-flows it and loses no word — and a spill without the cap does not stop
//      typing. Requiring the bundle is why the next address input cannot get
//      half the rule.
//
// WHICH FORMS ARE IN SCOPE — DERIVED, never a hand-list, so a NEW sales-order
// form is covered the day it is written. A file is in scope when it binds an
// input to an address line AND calls the sales-order endpoint, judged on
// comment-stripped source. That deliberately EXCLUDES the consignment,
// delivery-order and invoice forms: measured 2026-09-09, the write-back
// composes a document only from `mfg_sales_orders` (zero consignment references
// in `autocount-outbox.ts`, `autocount-writeback.ts`, `so-edit-header.ts`), so
// those addresses never meet AutoCount's column and capping them would invent a
// constraint their system does not have.
//
// NO DEPENDENCIES, so it runs in a worktree with no node_modules.
//
// Usage: node frontend/scripts/check-address-line-max.mjs
// ----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(frontendRoot, '..');
const FE_CONST = path.join(frontendRoot, 'src', 'lib', 'addressLimit.ts');
const BE_CONST = path.join(repoRoot, 'backend', 'src', 'services', 'autocount-address-fit.ts');

const read = (p) => fs.readFileSync(p, 'utf8');

/* Comments out, so a file that only NAMES the sales-order route in a sentence
   is not dragged into scope. ConsignmentOrderNew.tsx says it mirrors
   /mfg-sales-orders in its header and writes a different table entirely. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const ADDRESS_BINDING = /value=\{\s*(?:form\.)?(?:address[1-4]|addr[1-4])\s*\}/;
/* PATH-ANCHORED, and the anchor is load-bearing. The desktop detail form calls
   `/scm/sales-orders` and the mobile one `/mfg-sales-orders`, so a bare
   `mfg-sales-orders` missed the detail form entirely and a bare `sales-orders`
   would sweep in every form that merely READS a sales order. Requiring the name
   to open a path segment gives exactly the three forms that write one. */
const SO_ENDPOINT = /(?:^|[/'"`])(?:mfg-)?sales-orders/m;

/**
 * The `<input .../>` elements in a source file, as text.
 *
 * Brace-aware on purpose: an attribute here holds an arrow function, so the
 * usual `[^>]*` stops dead on the `=>` and every element after it is misread.
 * The element ends at the first `/>` seen while no `{}` is open.
 */
function inputElements(src) {
  const out = [];
  for (let i = src.indexOf('<input'); i !== -1; i = src.indexOf('<input', i + 1)) {
    let depth = 0;
    for (let j = i + 6; j < src.length; j += 1) {
      const c = src[j];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (depth === 0 && c === '/' && src[j + 1] === '>') { out.push(src.slice(i, j + 2)); break; }
      else if (depth === 0 && c === '>') { out.push(src.slice(i, j + 1)); break; }
    }
  }
  return out;
}

/* SELF-TEST FIRST. A checker that cannot match reports a clean run, and this
   repo has shipped three of those (CLAUDE.md). Both directions are asserted:
   the extractor must FIND a bad input and must not invent one. */
function selfTest() {
  const good = [
    '<input className={s.i} value={form.address1}',
    '  {...addressLineProps((v) => set("address1", v), null)}',
    '  onChange={(e) => set("address1", e.target.value)} />',
  ].join('\n');
  const bad = '<input className={s.i} value={addr1} onChange={(e) => setAddr1(e.target.value)} />';
  const decoy = '<input value={customerName} onChange={(e) => setName(e.target.value)} />';
  const els = inputElements([good, bad, decoy].join('\n'));
  const problems = [];
  if (els.length !== 3) problems.push(`element split found ${els.length} inputs, wanted 3`);
  if (!ADDRESS_BINDING.test(els[0] ?? '')) problems.push('the compliant address input was not recognised as one');
  if (!/addressLineProps\(/.test(els[0] ?? '')) problems.push('the bundle was not seen on the compliant input');
  if (/addressLineProps\(/.test(els[1] ?? '')) problems.push('the uncapped input read as capped');
  if (!ADDRESS_BINDING.test(els[1] ?? '')) problems.push('the uncapped address input was not recognised as one');
  if (ADDRESS_BINDING.test(els[2] ?? '')) problems.push('a non-address input read as an address input');
  /* THE SCOPE RULE, both ways. A marker that matched nothing would empty the
     scope and report a clean tree; one that matched a mention would drag in
     forms whose address never meets the account book. */
  if (!SO_ENDPOINT.test("fetch(`/scm/sales-orders/${docNo}`)")) problems.push('the desktop sales-order path was not recognised');
  if (!SO_ENDPOINT.test("fetch(`/mfg-sales-orders/active-venue`)")) problems.push('the mobile sales-order path was not recognised');
  if (SO_ENDPOINT.test('mirrors /scm/consignment-orders 1:1')) problems.push('a consignment path read as a sales-order path');
  return problems;
}

const selfProblems = selfTest();
if (selfProblems.length) {
  console.error('REFUSING TO REPORT — this checker cannot match its own fixtures:');
  for (const p of selfProblems) console.error(`  - ${p}`);
  process.exit(1);
}

const failures = [];

// -- 1. one number, in two files --------------------------------------------
const fe = read(FE_CONST).match(/export const ADDRESS_LINE_MAX = (\d+);/);
const be = read(BE_CONST).match(/export const AC_ADDRESS_LINE_MAX = (\d+);/);
if (!fe) failures.push(`ADDRESS_LINE_MAX not found in ${path.relative(repoRoot, FE_CONST)}`);
if (!be) failures.push(`AC_ADDRESS_LINE_MAX not found in ${path.relative(repoRoot, BE_CONST)}`);
if (fe && be && fe[1] !== be[1]) {
  failures.push(
    `the input limit is ${fe[1]} and the account book's column is ${be[1]}. ` +
    'One of them is wrong; the book is the authority.',
  );
}
if (fe && be && fe[1] === be[1]) console.log(`address line limit: ${fe[1]}, agreed by both sides`);

// -- 2. every sales-order address box carries the cap and the spill ----------
function tsxFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const inScope = [];
for (const file of tsxFiles(path.join(frontendRoot, 'src'))) {
  const code = stripComments(read(file));
  if (!ADDRESS_BINDING.test(code)) continue;
  if (!SO_ENDPOINT.test(code)) continue;
  inScope.push({ file, code });
}

/* A scope that came out EMPTY is a broken checker, not a clean tree. */
if (inScope.length === 0) {
  console.error('REFUSING TO REPORT — no sales-order address form was found at all.');
  process.exit(1);
}

let boxes = 0;
for (const { file, code } of inScope) {
  const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
  for (const el of inputElements(code)) {
    if (!ADDRESS_BINDING.test(el)) continue;
    boxes += 1;
    const field = el.match(ADDRESS_BINDING)[0];
    if (!/addressLineProps\(/.test(el)) {
      failures.push(
        `${rel}: ${field} does not go through addressLineProps — spread ` +
        '{...addressLineProps(setLine, spillOrNull)} onto it, or the box takes an ' +
        'address wider than the account book and a long paste loses its tail',
      );
    }
  }
}
console.log(`sales-order address forms: ${inScope.length}, address boxes checked: ${boxes}`);
for (const { file } of inScope) console.log(`  ${path.relative(repoRoot, file).replace(/\\/g, '/')}`);

if (failures.length) {
  console.error('');
  console.error(`FAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('');
console.log('OK — the boxes stop where the account book stops, and a long paste keeps its tail.');
