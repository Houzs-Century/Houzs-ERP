// The sales fields on a MIGRATED delivery order — salesperson, agent, branding,
// customer ref — come from the sales order's header, the way /from-sos copies
// them. The two DELIVERY dates are NOT among them: the book keeps its delivery
// date on the LINE (SODTL/DODTL.DeliveryDate), the inbound pull does not carry
// that column, and both values this backfill could reach for have been measured
// wrong — the SO's date goes stale (HC12445) and d.do_date differs from the
// book's delivery date on 65 of 235 linked delivery orders (0810).
// docs/bugs/0714 carried the customer block (phone / address); the header block
// above it on the same screen was blank for the same cause (docs/bugs/0716).
//
// `insertMigratedDo` writes to a live database and cannot be exercised from
// vitest, so what is pinned is the SOURCE, the same way 0714's cases pin the
// customer block: the writer's UPDATE names every column in DO_SALES_CARRY with
// that list's own expression; the backfill drives its write from the SAME list
// and carries the plan / CONFIRM discipline; and the list stays inside what the
// live converter already carries. Proved RED on the unfixed tree: before this
// change the writer's UPDATE named none of the six.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DO_CARRY, DO_SALES_CARRY } from '../scripts/lib/customer-block.mjs';

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const writer = src('../scripts/lib/migrated-do-writer.mjs');
const backfill = src('../scripts/backfill-migrated-do-sales-fields.mjs');
const route = src('../src/scm/routes/delivery-orders-mfg.ts');
const squash = (s) => s.replace(/\s+/g, ' ');

describe('DO_SALES_CARRY', () => {
  it('is the four header fields, and nothing the customer block already carries', () => {
    expect(DO_SALES_CARRY.map(([c]) => c)).toEqual([
      'salesperson_id', 'agent', 'branding', 'ref',
    ]);
    const block = new Set(DO_CARRY.map(([c]) => c));
    for (const [c] of DO_SALES_CARRY) expect(block.has(c)).toBe(false);
  });

  it('stays out of venue and the ship-from branch', () => {
    for (const [c] of DO_SALES_CARRY) expect(['venue', 'venue_id', 'sales_location', 'warehouse_id']).not.toContain(c);
  });

  it('carries only what /from-sos already writes onto a delivery order', () => {
    const insertAt = route.indexOf("sb.from('delivery_orders').insert({");
    const stmt = route.slice(insertAt, route.indexOf('}).select(', insertAt));
    for (const [c] of DO_SALES_CARRY) expect(stmt).toMatch(new RegExp(`\\b${c}:\\s`));
  });

  it('does NOT carry a delivery date, from either side', () => {
    // Two wrong answers are on record and this list must hold neither:
    // s.customer_delivery_date (2026-09-08) copies a date that goes stale the
    // moment AutoCount's changes, and d.do_date (#3615) substitutes the
    // document date for the book's delivery date - measured wrong on 65 of 235
    // linked delivery orders. The real column arrives via
    // scripts/repair-delivery-dates-from-book.mjs. docs/bugs/0810.
    const cols = DO_SALES_CARRY.map(([c]) => c);
    expect(cols).not.toContain('customer_delivery_date');
    expect(cols).not.toContain('expected_delivery_at');
    for (const [, e] of DO_SALES_CARRY) {
      expect(e).not.toMatch(/do_date/);
      expect(e).not.toMatch(/'[A-Za-z0-9]/);
    }
  });
});

describe('the writer carries the four in the same UPDATE as the customer block', () => {
  const at = writer.indexOf('UPDATE scm.delivery_orders d SET');
  const stmt = squash(writer.slice(at, writer.indexOf('`;', at)));

  it('names every column with the shared expression', () => {
    expect(at).toBeGreaterThan(-1);
    for (const [c, expr] of DO_SALES_CARRY) expect(stmt).toContain(`${c} = ${expr}`);
  });

  it('sets no delivery date of its own - it used to hardcode d.do_date', () => {
    // The writer HARDCODES this UPDATE rather than building it from the shared
    // list, so a change to DO_SALES_CARRY does not reach it. That is how the
    // d.do_date source survived one round of review; pin both halves.
    expect(stmt).not.toMatch(/customer_delivery_date\s*=/);
    expect(stmt).not.toMatch(/expected_delivery_at\s*=/);
  });

  it('reads the parent by so_doc_no within the company', () => {
    expect(stmt).toContain('FROM scm.mfg_sales_orders s');
    expect(stmt).toContain('s.doc_no = d.so_doc_no AND s.company_id = d.company_id');
  });
});

describe('the backfill', () => {
  it('drives its write from DO_SALES_CARRY, not a private copy', () => {
    expect(backfill).toContain('import { DO_SALES_CARRY } from "./lib/customer-block.mjs"');
    expect(backfill).not.toMatch(/salesperson_id\s*=\s*s\./);
  });

  it('never overwrites: every SET re-asserts IS NULL, on an un-aliased target', () => {
    expect(backfill).toContain('UPDATE scm.delivery_orders SET');
    expect(backfill).toContain('IS NULL THEN');
    expect(backfill).not.toMatch(/UPDATE scm\.delivery_orders \w+ SET/);
  });

  it('plans by default and needs the CONFIRM phrase to apply', () => {
    expect(backfill).toContain("(process.env.MODE || \"plan\").toLowerCase() === \"apply\"");
    expect(backfill).toContain('process.env.CONFIRM !== CONFIRM_PHRASE');
    expect(backfill).toMatch(/RE-RUN:/);
  });
});
