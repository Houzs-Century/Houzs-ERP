import { describe, expect, it } from 'vitest';
import {
  companyRequiresStockLocation,
  soLocationProblem,
  soLocationProblemForDoc,
  LOCATION_REQUIRED_COMPANY_CODES,
} from './so-location-gate';

/* ═══════════════════════════════════════════════════════════════════════════
   Owner 2026-08-13, after HC-SO-2608-002 came back from AutoCount "refused,
   nothing sent (MissingLocationError)": "Company 1 (Houzs Century) 开单必须有
   State。Company 2 (2990) 不需要。其他公司也不必填。"
   ═══════════════════════════════════════════════════════════════════════════ */

const facts = (o: Partial<Parameters<typeof soLocationProblem>[0]> = {}) => ({
  companyCode: 'HOUZS',
  salesLocation: null,
  customerState: null,
  ...o,
});

describe('which companies the rule covers', () => {
  it('company 1 (HOUZS) is covered, and it is the only one listed', () => {
    expect(LOCATION_REQUIRED_COMPANY_CODES).toEqual(['HOUZS']);
    expect(companyRequiresStockLocation('HOUZS')).toBe(true);
  });

  it('company 2 (2990) is NOT covered', () => {
    expect(companyRequiresStockLocation('2990')).toBe(false);
  });

  it('any other company is NOT covered — the owner adds them one at a time', () => {
    expect(companyRequiresStockLocation('HOOKKA')).toBe(false);
  });

  it('the code is matched case- and whitespace-insensitively', () => {
    expect(companyRequiresStockLocation(' houzs ')).toBe(true);
  });

  it('an unresolved company is NOT gated — over-gating stops the shop floor', () => {
    expect(companyRequiresStockLocation(undefined)).toBe(false);
    expect(companyRequiresStockLocation(null)).toBe(false);
    expect(companyRequiresStockLocation('')).toBe(false);
  });
});

describe('company 1 — the gate itself', () => {
  it('refuses an order with no State at all, and says whose job it is to fix', () => {
    const p = soLocationProblem(facts());
    expect(p?.code).toBe('so_state_required');
    expect(p?.field).toBe('State');
    expect(p?.message).toContain('State');
  });

  it('refuses a State that maps to NO warehouse — a DIFFERENT message, an admin task', () => {
    const p = soLocationProblem(facts({ customerState: 'Perlis' }));
    expect(p?.code).toBe('so_state_unmapped');
    expect(p?.message).toContain('Perlis');
    expect(p?.message).toContain('administrator');
  });

  it('passes when the State resolved a warehouse', () => {
    expect(soLocationProblem(facts({ customerState: 'Selangor', salesLocation: 'KL' })))
      .toBeNull();
  });

  it('passes on an explicit sales location even with no State (API / import callers)', () => {
    expect(soLocationProblem(facts({ salesLocation: 'KL' }))).toBeNull();
  });

  it('treats a whitespace-only location as no location', () => {
    expect(soLocationProblem(facts({ salesLocation: '   ' }))?.code).toBe('so_state_required');
  });
});

describe('company 2 — untouched', () => {
  it('passes with no State and no location', () => {
    expect(soLocationProblem(facts({ companyCode: '2990' }))).toBeNull();
  });

  it('passes with a State that maps to nothing', () => {
    expect(soLocationProblem(facts({ companyCode: '2990', customerState: 'Perlis' })))
      .toBeNull();
  });
});

/* ── the DRAFT -> live wrapper ───────────────────────────────────────────── */

type Row = { doc_no: string; sales_location: string | null; customer_state: string | null };
const makeSb = (rows: Row[], reads: { n: number }) => ({
  from() {
    let want = '';
    const builder: any = {
      select: () => builder,
      eq: (_col: string, v: unknown) => { want = String(v); return builder; },
      maybeSingle: async () => {
        reads.n += 1;
        return { data: rows.find((r) => r.doc_no === want) ?? null, error: null };
      },
    };
    return builder;
  },
});

describe('soLocationProblemForDoc (the DRAFT -> live transition)', () => {
  const rows: Row[] = [
    { doc_no: 'HC-SO-2608-002', sales_location: null, customer_state: null },
    { doc_no: 'HC-SO-2608-003', sales_location: null, customer_state: 'Perlis' },
    { doc_no: 'HC-SO-2608-004', sales_location: 'KL', customer_state: 'Selangor' },
  ];

  it('refuses a draft that never got a State', async () => {
    const reads = { n: 0 };
    const p = await soLocationProblemForDoc(makeSb(rows, reads), 'HC-SO-2608-002', 'HOUZS');
    expect(p?.code).toBe('so_state_required');
  });

  it('refuses a draft whose State maps to no warehouse', async () => {
    const reads = { n: 0 };
    const p = await soLocationProblemForDoc(makeSb(rows, reads), 'HC-SO-2608-003', 'HOUZS');
    expect(p?.code).toBe('so_state_unmapped');
  });

  it('lets a draft with a resolved location go live', async () => {
    const reads = { n: 0 };
    expect(await soLocationProblemForDoc(makeSb(rows, reads), 'HC-SO-2608-004', 'HOUZS'))
      .toBeNull();
  });

  it('does not even READ the header for a company the rule does not cover', async () => {
    const reads = { n: 0 };
    expect(await soLocationProblemForDoc(makeSb(rows, reads), 'HC-SO-2608-002', '2990'))
      .toBeNull();
    expect(reads.n).toBe(0);
  });
});
