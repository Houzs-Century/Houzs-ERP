import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/* ── pwp_codes is keyed on (company_id, code). Half a key is not a key. ──────
 *
 * Migration 0188_percompany_natural_key_masters.sql re-keyed the table:
 *
 *     ALTER TABLE scm.pwp_codes DROP CONSTRAINT IF EXISTS pwp_codes_pkey;
 *     ALTER TABLE scm.pwp_codes ADD CONSTRAINT pwp_codes_company_pkey
 *       PRIMARY KEY (company_id, code);
 *
 * The client is SERVICE-ROLE and migration 0061 enabled RLS with ZERO policies,
 * so the predicate a statement carries IS the whole tenant boundary. A voucher
 * write keyed on `code` alone therefore reaches whichever company's row the
 * planner returns first — docs/modules/sales-order.md calls this HAZARD 2, and
 * mfg-sales-orders.ts says so at its own correct sites:
 *
 *     // HAZARD 2 (see the guide) — both halves of the key
 *     .eq('code', code).eq('company_id', pwpCompanyId);
 *
 * Six statements in the same file were still carrying one half. The worst two
 * were DELETEs on the sofa- and non-sofa exchange paths, sixty-odd lines below
 * a correctly-keyed RELEASE in the very same function.
 *
 * WHY A SOURCE SCAN. Same reason permissionDivergence.test.ts and
 * soMaintenanceGate.test.ts are source scans: these statements are buried in
 * 10k-line concurrently-edited command handlers, and rendering the handler
 * would couple the test to the SO command lease, PostgREST and the audit
 * writer — failing for reasons that have nothing to do with the key. What must
 * not drift is WHICH PREDICATES each statement carries, and that is exactly
 * what the source says.
 *
 * SCOPE OF THE RULE, stated so a green run is not over-read: it covers
 * `pwp_codes` statements that key on the CODE. Statements keyed on
 * `owner_staff_id` + `cart_line_key` (the caller's own reserved POS-cart rows,
 * so-create ~L5425) are deliberately out — they do not name a code, and their
 * qualifier is the caller's own staff row rather than a shared natural key.
 * They are listed in CODE_KEYED_EXEMPT below with that reason, not silently
 * skipped.
 *
 * LIGHT project on purpose (no cloudflare:test, no env.DB) so it runs inside
 * `npm run test:light`, which backend-typecheck runs — a REQUIRED context. */

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '..', 'src', 'scm', 'routes', 'mfg-sales-orders.ts');
const SRC = readFileSync(FILE, 'utf8');

/** Every `from('pwp_codes')` chain, sliced to its whole STATEMENT — back to the
 *  nearest preceding `;`/`{`/`}` and forward to the `;` that ends it.
 *
 *  The backward half is load-bearing and was the first version's bug: the
 *  scoping helper WRAPS the builder (`scopeToCompany(sb.from('pwp_codes')…, c)`),
 *  so a slice that started at the table name reported two already-correct reads
 *  as offenders. Forward, the slice stops at the first `;` — running further
 *  could only ever sweep in a NEIGHBOUR's predicates, i.e. push the test toward
 *  a false GREEN. */
function pwpStatements(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const marker = /from\('pwp_codes'\)/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(src)) !== null) {
    const start =
      Math.max(
        src.lastIndexOf(';', m.index),
        src.lastIndexOf('{', m.index),
        src.lastIndexOf('}', m.index),
      ) + 1;
    const end = src.indexOf(';', m.index);
    const text = src.slice(start, end === -1 ? src.length : end);
    out.push({ line: src.slice(0, m.index).split('\n').length, text });
  }
  return out;
}

/** A statement carries the company half when it filters on company_id, sets it
 *  on an INSERT, or is wrapped in the scoping helper. */
function carriesCompany(text: string): boolean {
  return (
    /company_id/.test(text) ||
    /scopeToCompany(Id)?\s*\(/.test(text)
  );
}

/** Does the statement key on the CODE (the half that is not unique on its own)? */
function keysOnCode(text: string): boolean {
  return /\.(eq|in)\(\s*'code'/.test(text);
}

const ALL = pwpStatements(SRC);

describe('pwp_codes writes carry BOTH halves of the (company_id, code) key', () => {
  test('the scan actually found the statements (a zero here would be a false green)', () => {
    expect(ALL.length).toBeGreaterThan(10);
  });

  test('every code-keyed pwp_codes statement also filters on company_id', () => {
    const offenders = ALL.filter((s) => keysOnCode(s.text) && !carriesCompany(s.text)).map(
      (s) => `mfg-sales-orders.ts:${s.line}`,
    );
    expect(offenders).toEqual([]);
  });

  test('every pwp_codes INSERT stamps company_id', () => {
    const offenders = ALL.filter((s) => /\.insert\(/.test(s.text) && !carriesCompany(s.text)).map(
      (s) => `mfg-sales-orders.ts:${s.line}`,
    );
    expect(offenders).toEqual([]);
  });

  test('the DELETE paths on both exchange flows are company-keyed', () => {
    // Named separately because these two destroy a customer's voucher — a real
    // discount liability — and were the two worst of the six.
    const deletes = ALL.filter((s) => /\.delete\(/.test(s.text));
    expect(deletes.length).toBeGreaterThanOrEqual(2);
    for (const d of deletes) {
      if (!keysOnCode(d.text)) continue; // the cart-line-key reserve sweep, see header
      expect(carriesCompany(d.text), `mfg-sales-orders.ts:${d.line}`).toBe(true);
    }
  });
});
