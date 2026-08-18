#!/usr/bin/env node
/*
 * probe-natural-key-reads — how much route READ surface is addressed by a
 * HUMAN-MEANINGFUL key with no company term anywhere in the statement.
 *
 * WHY THIS EXISTS. `scripts/check-company-scope.mjs` has two passes and this
 * shape falls between them:
 *
 *   · the ROUTES pass screens on ID_PREDICATE — `.eq('id', …)` / `.eq('*_id', …)`
 *     — so a `doc_no` key is invisible to it;
 *   · the NATURAL-KEY pass does understand `.eq('doc_no', …)`, but it walks
 *     LIB_DIRS and screens on LIB_WRITE, so it sees neither routes nor reads.
 *
 * Six such reads in mfg-sales-orders.ts served another company's Sales Order
 * panels (BUG-HISTORY, 2026-08-18). This prints the size of the surface they
 * came from so the number in a PR body is reproducible rather than asserted.
 *
 * READ THE CAVEAT BEFORE QUOTING THE NUMBER. The unscoped count is an UPPER
 * BOUND on exposure, not a defect count. It is a per-STATEMENT test, so it
 * cannot see:
 *   · a guard earlier in the same handler (`selfScopedSalesBlocked` resolves the
 *     document through `scopeToCompany` before the child read runs — every
 *     `/:docNo/payments/:id/*` route is safe for exactly this reason);
 *   · tables that are deliberately global (mig 0089's TEXT-PK masters);
 *   · a key that happens to be globally unique in practice.
 * Triage is per-site. This tells you how big the pile is, not what is in it.
 *
 * Exits 0 always — it reports, it does not gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Same exclusions as check-company-scope.mjs's NOT_IDENTITY, kept verbatim so
// the two passes agree on what "identity" means.
const NOT_IDENTITY =
  /^(id|.*_id|status|state|.*_at|.*_centi|.*_sen|qty|.*_qty|type|kind|active|deleted)$/;
const NATURAL_KEY_EQ = /\.eq\(\s*['"`]([a-z][a-z0-9_]*)['"`]/g;
const SCOPED =
  /scopeToCompany|scopeToCompanyId|scopeToAllowedCompanies|allowedCompaniesSql|company_id|requireActiveCompanyId|selfScopedSalesBlocked|activeCompanyId/;

// SELF-TEST. A regex that cannot match produces a confident, empty, wrong
// report — the exact failure mode check-company-scope.mjs documents at its top.
{
  const keys = (s) =>
    [...s.matchAll(NATURAL_KEY_EQ)].map((m) => m[1]).filter((k) => !NOT_IDENTITY.test(k));
  const ok =
    keys(".eq('doc_no', docNo)").length === 1 &&
    keys(".eq('so_doc_no', docNo)").length === 1 &&
    keys(".eq('id', x)").length === 0 &&
    keys(".eq('so_item_id', x)").length === 0 &&
    keys(".eq('status', 'USED')").length === 0 &&
    SCOPED.test("scopeToCompany(sb.from('x').eq('doc_no', d), c)") &&
    !SCOPED.test("sb.from('x').select('*').eq('doc_no', d)");
  if (!ok) {
    console.error('probe-natural-key-reads: SELF-TEST FAILED — not reporting.');
    process.exit(2);
  }
}

const routesDir = fileURLToPath(new URL('../src/scm/routes/', import.meta.url));
const files = fs
  .readdirSync(routesDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .sort();

let statements = 0;
const unscoped = [];

for (const file of files) {
  const lines = fs
    .readFileSync(path.join(routesDir, file), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (!(lines[i] ?? '').includes('.from(')) continue;
    // The statement window: `.from(` until a line ending in `;`. Bounded at 24
    // lines so one unterminated chain cannot swallow the rest of the file.
    const parts = [];
    for (let j = i; j < Math.min(i + 24, lines.length); j++) {
      parts.push(lines[j]);
      if ((lines[j] ?? '').trim().endsWith(';')) break;
    }
    const stmt = parts.join(' ');
    if (!stmt.includes('.select(')) continue; // reads only
    const keys = [...stmt.matchAll(NATURAL_KEY_EQ)]
      .map((m) => m[1])
      .filter((k) => !NOT_IDENTITY.test(k));
    if (keys.length === 0) continue;
    statements++;
    if (!SCOPED.test(stmt)) unscoped.push({ file, line: i + 1, key: keys[0] });
  }
}

const byFile = new Map();
for (const u of unscoped) byFile.set(u.file, (byFile.get(u.file) ?? 0) + 1);

console.log(`route files scanned            ${files.length}`);
console.log(`natural-key READ statements    ${statements}`);
console.log(`  of those, no company term    ${unscoped.length}  (UPPER BOUND — see header)`);
console.log(`  spread over                  ${byFile.size} file(s)`);
console.log('');
for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`  ${String(n).padStart(3)}  ${file}`);
}
