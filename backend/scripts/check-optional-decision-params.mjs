#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-optional-decision-params.mjs — a parameter that DECIDES may not be
// declared with `?:`. Exit 1 on any violation.
//
// THE SHAPE. `param?: T` lets a caller say nothing, and saying nothing is
// spelled exactly the same as "there is nothing to say". When the parameter
// decides which company's books to read, which product a rule exempts, or
// whether a write is idempotent, the default answer is not "unknown" — it is
// "all of them", "no exemption", "not idempotent". tsc is happy either way, so
// the omission is invisible to the compiler AND to review.
//
// It has recurred in this repo at least seven times, and the class was written
// down after the second:
//   2026-07-17 "computeMrp's companyId was OPTIONAL, so silence meant 'plan
//              both companies as one'" — "an optional scoping parameter is a
//              trap whose default is 'wrong'."
//   2026-07-17 the CS Agent promised customers delivery dates backed by the
//              OTHER company's stock — same hole, the one caller #710 missed.
//   2026-07-17 the P&L drill-down listed BOTH companies' orders.
//   2026-07-17 seventeen document creates never sent the idempotency header,
//              so raising an order twice raised it twice.
//   2026-07-29 the DO-create payload never sent `soItemId`, so the batch guard
//              could not link the line to its incoming PO.
//   2026-08-09 DIVAN ONLY lines demanded a mattress Gap — `itemCode?` threaded
//              through "every call site" except two, for four days.
//   2026-08-11 composeCreateSo was called with two arguments, so its third
//              defaulted and the write-back emitted raw ERP item codes.
//
// THE FIX, already proven here. Declare `param: T | null | undefined` instead of
// `param?: T`. The KEY becomes required; `undefined` stays a legal VALUE. From
// the 2026-07-17 entry: "Runtime unchanged for every honest caller ... no caller
// needed editing. Silence is no longer spellable." An absent value now reads as
// a decision the caller typed out, not an oversight nobody can see.
//
// WHY A SCRIPT AND NOT THE EXISTING TEST. src/scm/lib/optional-param-noop.test.ts
// pins this class beautifully with `@ts-expect-error` compile probes — for TWO
// named functions, both of which had already broken. It cannot fail for the
// eighth function added tomorrow. That is the same enumerate-instead-of-scan
// shape as the leak it is guarding, and it is why the class kept recurring
// after it was written down.
//
// PARSED, NOT GREPPED. It uses the TypeScript compiler API (already a devDep,
// already used by generate-route-capability-matrix.mjs) so a row-shape property
// like `{ company_id?: number | null }` describing a database row is not
// confused with a function PARAMETER. A checker that cries wolf gets ignored,
// which is how this repo ended up with a `--check` script that could not fail.
//
// READ-ONLY. Touches no database and no network — it reads files.
//
//   node backend/scripts/check-optional-decision-params.mjs
//   npm --prefix backend run audit:decision-params
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const REPO = resolve(BACKEND, '..');

/** The modules where a decision parameter is load-bearing: the shared rules and
 *  the chokepoint helpers that write stock, money and GL. Route handlers are
 *  deliberately out of scope — they receive the company from the request
 *  context, and every recorded instance of this class was in a helper called
 *  from somewhere that had no request. */
const ROOTS = [join(BACKEND, 'src/scm/shared'), join(BACKEND, 'src/scm/lib')];

/** Parameter names that decide something. Every one of these is on the list
 *  because omitting it produced a real production defect — see the header. */
const DECIDES = new Set([
  'companyId',
  'company_id',
  'itemCode',
  'soItemId',
  'idempotencyKey',
  'asDraft',
  'actorId',
]);

const SKIP = /\.(test|spec)\.ts$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith('.ts') && !SKIP.test(full)) yield full;
  }
}

const findings = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = relative(REPO, file);
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const visit = (node) => {
      // ONLY real parameter declarations. A PropertySignature inside an
      // interface (`{ company_id?: number | null }` — the shape of a row that
      // came back from the database) is not this class and must not be flagged.
      if (ts.isParameter(node) && node.questionToken && ts.isIdentifier(node.name)) {
        const name = node.name.text;
        if (DECIDES.has(name)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const owner = enclosingName(node, sf);
          findings.push({
            file: rel,
            line: line + 1,
            name,
            owner,
            declared: node.getText(sf).replace(/\s+/g, ' ').slice(0, 70),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

/** Best-effort name of the function the parameter belongs to, for the report. */
function enclosingName(node, sf) {
  let p = node.parent;
  while (p) {
    if (p.name && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    p = p.parent;
  }
  return relative(REPO, sf.fileName);
}

if (findings.length === 0) {
  console.log('decision parameters: clean.');
  console.log(`  No parameter in ${DECIDES.size} decision names is declared optional`);
  console.log('  in backend/src/scm/shared or backend/src/scm/lib.');
  process.exit(0);
}

console.error(`\nA PARAMETER THAT DECIDES IS DECLARED OPTIONAL — ${findings.length} site(s).\n`);
console.error('`param?: T` lets a caller say nothing, and saying nothing is spelled');
console.error('the same as "there is nothing to say". For these names the default is');
console.error('not "unknown" — it is "every company", "no exemption", "not idempotent".');
console.error('That default planned both companies as one book and promised a customer');
console.error("a delivery date backed by the other company's stock (2026-07-17).\n");
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.owner}(${f.name})`);
  console.error(`      ${f.declared}`);
}
console.error('\nFIX — make the KEY required and keep the absent VALUE expressible:');
console.error('    -  companyId?: number | null');
console.error('    +  companyId: number | null | undefined');
console.error('\nRuntime is unchanged for every honest caller and no correct call site');
console.error('needs editing; what changes is that silence stops compiling. Verify the');
console.error('same way the 2026-07-17 fix did: add a probe that omits the argument,');
console.error('confirm TS2345, then delete the probe.\n');
process.exit(1);
