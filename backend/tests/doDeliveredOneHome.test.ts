import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DO_NOT_DELIVERED_STATES,
  DO_NOT_DELIVERED_IN_LIST,
  DO_PRESHIP_STATES,
  DO_STATUSES,
  DO_STOCK_OUT_STATES,
  doCountsAsDelivered,
} from '../src/scm/shared/do-shipped-states';
// @ts-expect-error - plain .mjs mirror for audit scripts
import {
  DO_NOT_DELIVERED_STATES as jsNotDelivered,
  DO_NOT_DELIVERED_SQL_IN as jsSqlIn,
} from '../scripts/lib/do-shipped-states.mjs';

/* "Has this delivery counted?" had NINE hand-written copies and every one of
   them spelled it {CANCELLED, DRAFT}. LOADED is a PRE-SHIP state — the
   inventory OUT only fires on entry to a shipped state — so all nine counted a
   delivery that is still on the lorry, and the confirm gate then refused a
   LOADED DO against its own lines on any full delivery.
   `unbilled-deliveries.ts` was the tell: the one consumer that had LOADED
   right, and it had it right BY HAND.

   These tests are what stops the tenth copy — and two of the nine were found by
   the scan below rather than by reading. They are cheap and they are the
   only thing standing between this fix and the same drift, because the compiler
   cannot see a string. */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCM = join(HERE, '..', 'src', 'scm');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !name.includes('.test.')) out.push(full);
  }
  return out;
}

/* Scope is decided PER MATCH, not per file. The same two-state pair on a
   SALES-ORDER, PURCHASE-ORDER or INVOICE status is correct — none of those
   vocabularies has a LOADED — and the big routers touch several vocabularies in
   one file, so a whole-file heuristic flags six correct files and reads as
   noise. A checker that cries wolf is a checker nobody reads. So a match counts
   only when the surrounding WINDOW is about delivery orders. */
const READS_DO_STATUS = /from\('delivery_orders'\)|delivery_orders\.status|delivery_orders!inner\(status\)|delivery_order_items|doMeta|DO has NOT|DO hasn't/;
const WINDOW = 700;

/* The hand-typed spellings this rule replaced, in both dialects: the PostgREST
   `.not('status','in', ...)` literal and the JS pair. */
const HAND_TYPED = [
  /\(\s*"CANCELLED"\s*,\s*"DRAFT"\s*\)/,
  /\(\s*"DRAFT"\s*,\s*"CANCELLED"\s*\)/,
  /!==\s*'CANCELLED'\s*&&\s*[^\n]*!==\s*'DRAFT'/,
  /===\s*'CANCELLED'\s*\|\|\s*[^\n]*===\s*'DRAFT'/,
  /!==\s*'DRAFT'\s*&&\s*[^\n]*!==\s*'CANCELLED'/,
];

/* The ONE file allowed to keep the pair, and WHY — read this before "fixing"
   it. `routes/delivery-planning.ts` asks which DO is the LIVE one for an order
   so a board write lands somewhere; it does not ask whether that DO shipped. A
   LOADED delivery IS live (it is on the lorry), so routing the write past it
   would send the update to an older DO or to none at all.

   The reason lives HERE rather than in a comment at the two sites because that
   file is already over its file-size ceiling, and a ceiling may only fall. This
   is also where the next person meets the question: this test is what will
   point at that file. */
const ALLOWED = new Set(['routes/delivery-planning.ts']);

describe('"has this delivery counted?" has one home', () => {
  test('the matchers still match something — a dead regex must not read as a pass', () => {
    // Guard the guard (CLAUDE.md: a checker that cannot match reports a clean
    // run). Each pattern is proved against the exact text it exists to catch.
    expect(HAND_TYPED[0]!.test(`.not('status', 'in', '("CANCELLED","DRAFT")')`)).toBe(true);
    expect(HAND_TYPED[2]!.test(`if (st !== 'CANCELLED' && st !== 'DRAFT') keep();`)).toBe(true);
    expect(HAND_TYPED[3]!.test(`if (st === 'CANCELLED' || st === 'DRAFT') continue;`)).toBe(true);
    expect(HAND_TYPED[4]!.test(`return s !== 'DRAFT' && s !== 'CANCELLED';`)).toBe(true);
    expect(READS_DO_STATUS.test(`sb.from('delivery_orders').select('id, status')`)).toBe(true);
    // …and does NOT fire on the vocabularies that legitimately keep the pair.
    expect(READS_DO_STATUS.test(`if (p.status === 'CANCELLED' || p.status === 'DRAFT') excluded.add(p.id);`)).toBe(false);
  });

  test('no file that reads delivery-order status hand-types the state pair', () => {
    const offenders: string[] = [];
    for (const file of walk(SCM)) {
      const rel = relative(SCM, file).split('\\').join('/');
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      for (const re of HAND_TYPED) {
        const global = new RegExp(re.source, 'g');
        for (const m of src.matchAll(global)) {
          const at = m.index ?? 0;
          const around = src.slice(Math.max(0, at - WINDOW), at + WINDOW);
          const line = (src.slice(0, at).match(/\n/g) ?? []).length + 1;
          if (READS_DO_STATUS.test(around)) offenders.push(`${rel}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the one allowed file still exists, and still holds what is exempted', () => {
    // An exemption for a file that has moved is an exemption for nothing, and
    // it would read as a pass. If this file is renamed or its two sites are
    // cleaned up, this fails and the ALLOWED entry has to be revisited.
    const src = readFileSync(join(SCM, 'routes', 'delivery-planning.ts'), 'utf8');
    expect(HAND_TYPED.some((re) => re.test(src))).toBe(true);
  });
});

describe('the not-delivered set is the complement of the shipped set', () => {
  test('it is exactly the pre-ship states plus CANCELLED', () => {
    expect([...DO_NOT_DELIVERED_STATES]).toEqual([...DO_PRESHIP_STATES, 'CANCELLED']);
  });

  test('LOADED is in it — the whole point', () => {
    expect(DO_NOT_DELIVERED_STATES).toContain('LOADED');
    expect(doCountsAsDelivered('LOADED')).toBe(false);
    expect(doCountsAsDelivered('loaded')).toBe(false);       // the column is text
  });

  test('together with the stock-out set it partitions the vocabulary, no overlap', () => {
    const union = [...DO_STOCK_OUT_STATES, ...DO_NOT_DELIVERED_STATES].sort();
    expect(union).toEqual([...DO_STATUSES].sort());
    for (const s of DO_STOCK_OUT_STATES) expect(DO_NOT_DELIVERED_STATES).not.toContain(s);
  });

  test('a shipped status counts, a null or unknown one does not blow up', () => {
    for (const s of DO_STOCK_OUT_STATES) expect(doCountsAsDelivered(s)).toBe(true);
    expect(doCountsAsDelivered(null)).toBe(true);   // unknown text is not a pre-ship state
    expect(doCountsAsDelivered('DRAFT')).toBe(false);
    expect(doCountsAsDelivered('CANCELLED')).toBe(false);
  });

  test('the PostgREST literal is BUILT from the array, not typed beside it', () => {
    expect(DO_NOT_DELIVERED_IN_LIST).toBe('("DRAFT","LOADED","CANCELLED")');
    for (const s of DO_NOT_DELIVERED_STATES) expect(DO_NOT_DELIVERED_IN_LIST).toContain(`"${s}"`);
  });
});

describe('the .mjs mirror carries the same set', () => {
  // Same role the shipped/stock-out pins next door play: these sets decide
  // WHICH DELIVERY ORDERS AN AUDIT LOOKS AT, and check-do-integrity.mjs now
  // claims it cannot disagree with the app. This is that claim, executed.
  test('DO_NOT_DELIVERED_STATES is identical', () => {
    expect([...jsNotDelivered]).toEqual([...DO_NOT_DELIVERED_STATES]);
  });

  test('the SQL literal quotes for SQL, the PostgREST one for PostgREST', () => {
    expect(jsSqlIn).toBe(`('DRAFT', 'LOADED', 'CANCELLED')`);
    expect(jsSqlIn).not.toContain('"');
  });
});
