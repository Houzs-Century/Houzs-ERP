import { describe, expect, test } from 'vitest';
import type { AuthUser } from '../../services/auth';
import {
  parseStage, fairReportAccess, isFairManagement,
  tenderLabel, depositByTender, paymentMethodsUsed,
  marginPct, belowDeposit, fairSoMoney, fairBalanceSen, doCostTotal, siCostTotal,
  resolveDateWindow, summarizeSo, summarizeDo, summarizeInvoice,
  type FairStage,
} from './fair-report';

// A minimal AuthUser factory — the gate only reads position_name + permissions_set.
function user(position: string | null, perms: string[] = []): AuthUser {
  return { position_name: position, permissions_set: new Set(perms) } as AuthUser;
}
const OWNER = user(null, ['*']);                 // Owner / IT Admin — `*`
const SUPER_ADMIN = user('Super Admin');
const FINANCE = user('Finance Manager');
const SALES_DIRECTOR = user('Sales Director');
const SALES_EXEC = user('Sales Executive');
const OPS = user('Operation Executive');

const STAGES: FairStage[] = ['so', 'do', 'invoice'];

describe('parseStage', () => {
  test('accepts the three stages, case-insensitively', () => {
    expect(parseStage('so')).toBe('so');
    expect(parseStage('DO')).toBe('do');
    expect(parseStage(' invoice ')).toBe('invoice');
  });
  test('rejects anything else', () => {
    for (const bad of ['', undefined, null, 'sales', 'si', 'x']) expect(parseStage(bad as never)).toBeNull();
  });
});

describe('isFairManagement — {*, Super Admin, Finance Manager}, NOT Sales Director', () => {
  test('owner / Super Admin / Finance are management', () => {
    expect(isFairManagement(OWNER)).toBe(true);
    expect(isFairManagement(SUPER_ADMIN)).toBe(true);
    expect(isFairManagement(FINANCE)).toBe(true);
  });
  test('Sales Director is NOT management (the whole point)', () => {
    expect(isFairManagement(SALES_DIRECTOR)).toBe(false);
  });
  test('ordinary sales / ops / null are NOT management', () => {
    expect(isFairManagement(SALES_EXEC)).toBe(false);
    expect(isFairManagement(OPS)).toBe(false);
    expect(isFairManagement(null)).toBe(false);
  });
});

describe('fairReportAccess — the owner-ruled permission matrix', () => {
  test('ordinary salesperson → 403 on EVERY stage', () => {
    for (const s of STAGES) {
      const r = fairReportAccess(s, SALES_EXEC);
      expect(r.allowed).toBe(false);
      expect(r.tier).toBe('none');
      expect(r.error).toBeTruthy();
    }
  });

  test('Sales Director → 200 on so, 403 on do + invoice', () => {
    const so = fairReportAccess('so', SALES_DIRECTOR);
    expect(so.allowed).toBe(true);
    expect(so.tier).toBe('sales_director');

    for (const s of ['do', 'invoice'] as FairStage[]) {
      const r = fairReportAccess(s, SALES_DIRECTOR);
      expect(r.allowed).toBe(false);
      expect(r.tier).toBe('sales_director');
      expect(r.error).toContain('Sales Order stage');
    }
  });

  test('management (owner / Super Admin / Finance) → 200 on ALL stages', () => {
    for (const m of [OWNER, SUPER_ADMIN, FINANCE]) {
      for (const s of STAGES) {
        const r = fairReportAccess(s, m);
        expect(r.allowed).toBe(true);
        expect(r.tier).toBe('management');
      }
    }
  });

  test('a null / unidentified caller fails closed on every stage', () => {
    for (const s of STAGES) expect(fairReportAccess(s, null).allowed).toBe(false);
  });

  test('an Ops user with no finance role is refused everywhere', () => {
    for (const s of STAGES) expect(fairReportAccess(s, OPS).allowed).toBe(false);
  });
});

describe('tender mapping', () => {
  test('closed enum maps to owner labels', () => {
    expect(tenderLabel('cash')).toBe('Cash');
    expect(tenderLabel('merchant')).toBe('Merchant');
    expect(tenderLabel('installment')).toBe('Installment');
    expect(tenderLabel('transfer')).toBe('Online');
  });
  test('unknown / empty → null (dropped, never mislabelled)', () => {
    expect(tenderLabel('cheque')).toBeNull();
    expect(tenderLabel('')).toBeNull();
    expect(tenderLabel(null)).toBeNull();
  });
  test('depositByTender sums per label, excludes unknown', () => {
    const split = depositByTender([
      { method: 'cash', amount_sen: 1000 },
      { method: 'cash', amount_sen: 500 },
      { method: 'transfer', amount_sen: 2000 },
      { method: 'cheque', amount_sen: 9999 },
    ]);
    expect(split).toEqual({ Cash: 1500, Merchant: 0, Installment: 0, Online: 2000 });
  });
  test('paymentMethodsUsed returns distinct labels in canonical order', () => {
    expect(paymentMethodsUsed([
      { method: 'transfer', amount_sen: 1 },
      { method: 'cash', amount_sen: 1 },
      { method: 'cash', amount_sen: 1 },
    ])).toEqual(['Cash', 'Online']);
  });
});

describe('money helpers', () => {
  test('marginPct = (rev-cost)/rev*100, null on zero revenue', () => {
    expect(marginPct(10000, 6000)).toBeCloseTo(40);
    expect(marginPct(0, 100)).toBeNull();
  });
  test('belowDeposit — balance owing AND paid ≤ deposit', () => {
    expect(belowDeposit({ balanceSen: 5000, depositSen: 2000, paidSen: 2000 })).toBe(true);
    expect(belowDeposit({ balanceSen: 5000, depositSen: 2000, paidSen: 2001 })).toBe(false); // paid beyond deposit
    expect(belowDeposit({ balanceSen: 0, depositSen: 2000, paidSen: 2000 })).toBe(false);    // fully settled
  });
});

describe('fairSoMoney — product/service split + per-category cost + margin', () => {
  test('splits selling (product) from service, keeps category cost', () => {
    const m = fairSoMoney({
      local_total_sen: 100000,
      mattress_sofa_sen: 40000, bedframe_sen: 20000, accessories_sen: 5000, others_sen: 5000,
      service_sen: 30000,
      mattress_sofa_cost_sen: 20000, bedframe_cost_sen: 10000, accessories_cost_sen: 2000,
      others_cost_sen: 3000, service_cost_sen: 15000,
      total_cost_sen: 50000, deposit_sen: 10000,
    });
    expect(m.amount_sen).toBe(100000);       // product 70000 + service 30000
    expect(m.selling_sen).toBe(70000);       // product only, excludes service
    expect(m.service_rev_sen).toBe(30000);
    expect(m.total_so_cost_sen).toBe(50000);
    expect(m.cost_by_category.service_cost_sen).toBe(15000);
    expect(m.margin_pct).toBeCloseTo(50);      // (100000-50000)/100000
    // Balance is no longer a header pass-through: it is amount minus what the
    // LEDGER says was paid. Same 40000, now derived (see fairBalanceSen).
    expect(fairBalanceSen(m.amount_sen, 60000)).toBe(40000);
  });
  test('amount falls back to reconstructed sum when local_total is 0', () => {
    const m = fairSoMoney({
      local_total_sen: 0,
      mattress_sofa_sen: 10000, bedframe_sen: 0, accessories_sen: 0, others_sen: 0,
      service_sen: 5000,
      mattress_sofa_cost_sen: 0, bedframe_cost_sen: 0, accessories_cost_sen: 0, others_cost_sen: 0, service_cost_sen: 0,
      total_cost_sen: 0, deposit_sen: 0,
    });
    expect(m.amount_sen).toBe(15000);
  });
});

describe('doCostTotal — COALESCE(ship_cost, unit_cost) × qty, legacy flag', () => {
  test('uses frozen ship cost when present', () => {
    const r = doCostTotal([{ qty: 2, unit_cost_sen: 500, ship_cost_sen: 400, item_group: 'sofa' }]);
    expect(r.total_do_cost_sen).toBe(800);   // 400 × 2
    expect(r.qty).toBe(2);
    expect(r.is_legacy).toBe(false);
  });
  test('falls back to unit cost and flags legacy when a STOCK line has no ship cost', () => {
    const r = doCostTotal([{ qty: 3, unit_cost_sen: 500, ship_cost_sen: null, item_group: 'mattress' }]);
    expect(r.total_do_cost_sen).toBe(1500);
    expect(r.is_legacy).toBe(true);
  });

  /* 2026-08-31 (owner's Sales Report review): the delivery-fee line NEVER has a
     ship-time frozen cost — it is not stock — yet it flipped the whole DO to
     LEGACY, so 11 of the 14 rows on screen wore the chip and the "pre-FIFO"
     KPI counted service lines. And a stock line the floor shipped BEFORE any
     lot existed freezes at ZERO (the 2990 ship-anyway fingerprint), which the
     report rendered as a naked 100% margin (2990-DO-2607-021). */
  test('a SERVICE line with no ship cost does not make the DO legacy', () => {
    const r = doCostTotal([
      { qty: 1, unit_cost_sen: 98750, ship_cost_sen: 98750, item_group: 'sofa' },
      { qty: 1, unit_cost_sen: 0, ship_cost_sen: null, item_group: 'service' },
    ]);
    expect(r.is_legacy).toBe(false);
    expect(r.has_zero_frozen).toBe(false);
  });
  test('a stock line frozen at ZERO with a real order-time estimate flags ship-anyway (2990-DO-2607-021)', () => {
    const r = doCostTotal([
      { qty: 1, unit_cost_sen: 99514, ship_cost_sen: 0, item_group: 'sofa' },
      { qty: 1, unit_cost_sen: 0, ship_cost_sen: null, item_group: 'service' },
    ]);
    expect(r.total_do_cost_sen).toBe(0);     // the frozen truth stands — no invention
    expect(r.has_zero_frozen).toBe(true);    // ...but the row says WHY it is zero
    expect(r.is_legacy).toBe(false);
  });
  test('a genuinely free line frozen at zero (no estimate either) is NOT ship-anyway', () => {
    const r = doCostTotal([{ qty: 1, unit_cost_sen: 0, ship_cost_sen: 0, item_group: 'accessory' }]);
    expect(r.has_zero_frozen).toBe(false);
  });
});

describe('siCostTotal — landed cost from SI lines', () => {
  test('prefers line_cost, falls back to unit×qty', () => {
    expect(siCostTotal([
      { qty: 2, unit_cost_sen: 500, line_cost_sen: 900 },
      { qty: 3, unit_cost_sen: 100, line_cost_sen: null },
    ])).toBe(1200); // 900 + 300
  });
});

describe('resolveDateWindow — month + from/to AND-ing', () => {
  test('month expands to the calendar month', () => {
    expect(resolveDateWindow({ month: '2026-07' })).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(resolveDateWindow({ month: '2026-02' })).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
  test('explicit from/to pass through', () => {
    expect(resolveDateWindow({ dateFrom: '2026-07-05', dateTo: '2026-07-10' })).toEqual({ from: '2026-07-05', to: '2026-07-10' });
  });
  test('month AND from/to → tighter bound each side', () => {
    expect(resolveDateWindow({ month: '2026-07', dateFrom: '2026-07-05', dateTo: '2026-08-20' }))
      .toEqual({ from: '2026-07-05', to: '2026-07-31' });
  });
  test('unconstrained → nulls', () => {
    expect(resolveDateWindow({})).toEqual({ from: null, to: null });
  });
});

describe('summaries', () => {
  test('summarizeSo aggregates money + tender + below-deposit', () => {
    const s = summarizeSo([
      { amount_sen: 100000, selling_sen: 70000, service_rev_sen: 30000, total_so_cost_sen: 50000, balance_sen: 40000, below_deposit: true, deposit_by_tender: { Cash: 10000, Merchant: 0, Installment: 0, Online: 0 } },
      { amount_sen: 50000, selling_sen: 50000, service_rev_sen: 0, total_so_cost_sen: 20000, balance_sen: 0, below_deposit: false, deposit_by_tender: { Cash: 0, Merchant: 5000, Installment: 0, Online: 0 } },
    ]);
    expect(s.orders).toBe(2);
    expect(s.total_amount_sen).toBe(150000);
    expect(s.total_selling_sen).toBe(120000);
    expect(s.total_service_rev_sen).toBe(30000);
    expect(s.total_so_cost_sen).toBe(70000);
    expect(s.total_margin_sen).toBe(80000);
    expect(s.margin_pct).toBeCloseTo((80000 / 150000) * 100);
    expect(s.below_deposit_count).toBe(1);
    expect(s.tender_totals).toEqual({ Cash: 10000, Merchant: 5000, Installment: 0, Online: 0 });
  });
  test('summarizeDo computes cost delta', () => {
    const s = summarizeDo([
      { total_so_cost_sen: 1000, total_do_cost_sen: 1200, do_cost_is_legacy: false },
      { total_so_cost_sen: 500, total_do_cost_sen: 500, do_cost_is_legacy: true },
    ]);
    expect(s.deliveries).toBe(2);
    expect(s.cost_delta_sen).toBe(200); // 1700 - 1500
    expect(s.legacy_count).toBe(1);
  });
  test('summarizeInvoice computes landed margin', () => {
    const s = summarizeInvoice([
      { invoiced_sen: 10000, so_cost_sen: 4000, do_cost_sen: 4200, si_cost_sen: 4500 },
    ]);
    expect(s.total_invoiced_sen).toBe(10000);
    expect(s.total_si_cost_sen).toBe(4500);
    expect(s.margin_pct).toBeCloseTo(55); // (10000-4500)/10000
  });
});
