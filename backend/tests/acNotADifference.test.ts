/**
 * The reconcile's "not a difference" columns may never swallow a real one.
 *
 * WHY THIS TEST IS THE GUARD, NOT THE COMMENT. `check-ac-erp-reconcile.mjs`
 * now moves three counts out of its difference columns and into columns of
 * their own: unit prices the BOOK does not state, goods receipts carrying
 * RM 0.00 under the owner's 「GR 0 没关系」 ruling, and absences he has already
 * decided about. Every one of those is a bucket a REAL defect could fall into
 * and stop being counted — which is the precise failure
 * `docs/bugs/0668-the-reconcile-printed-real-gaps-as-owner-decisions-for-do-iv`
 * cost 30 documents, in the other direction, on go-live eve.
 *
 * So the properties below are the ones that make the reclassification honest:
 *
 *   1. NO COUNT IS EVER LOST — benign + differ === the original total, on
 *      every split, including the refusal paths.
 *   2. A PARTIAL COVER STILL REPORTS DIFFER — the rule that made
 *      specialsRecordedNeverPriced worth writing. Six qualifying rows in a set
 *      of ten move six, never ten.
 *   3. THE LABEL IS EARNED BY A MEASUREMENT — a document that merely LOOKS
 *      benign (zero total, absent, unpriced) but fails the proof stays counted,
 *      and is returned as an impostor so the run can shout about it.
 *   4. NO PROOF, NO MOVE — an absent probe, an absent decision or a fired
 *      export self-check reclassifies NOTHING.
 *
 * If you are here because this test failed: you have not broken a style rule.
 * You have made it possible for a real gap to read as a decision the owner
 * made, and nobody goes looking at those.
 */
import { describe, expect, test } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ABSENCE_PREDICATES,
  DECIDED_ABSENCES,
  splitBookUnpriced,
  splitDecidedAbsences,
  splitErpZeroMoney,
  splitGuessedItemCodePairing,
  splitMigratedChainLineShape,
} from '../scripts/lib/ac-not-a-difference.mjs';

const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}-${i}`);

/* A document-total row in the shape the checker hands over. */
const moneyRow = (erpNo: string, bookSen: number | null, erpSen: number | null) => ({
  key: `GR-${erpNo}`, erpNo, bookSen, erpSen, line: `GR-${erpNo}: book ${bookSen} vs ERP ${erpSen}`,
});
const DECISION = {
  label: 'GR 0 没关系',
  ruling: 'the owner ruled a migrated receipt may carry RM 0.00',
  consequence: 'a purchase invoice cannot be raised off it',
};
const proven = (erpNo: string) => [erpNo, { migratedNoStock: true, movements: 0 }] as const;

describe('unit price — the book states none', () => {
  test('moves only the book-unpriced lines, and keeps the total', () => {
    const P = {
      bookUnpriced: rows(241, 'u'), bothPriced: rows(3, 'b'), erpDropped: rows(2, 'e'), bookDropped: [],
    };
    const r = splitBookUnpriced(P);
    expect(r.trusted).toBe(true);
    expect(r.noPrice).toBe(241);
    expect(r.differ).toBe(5);
    expect(r.noPrice + r.differ).toBe(246);
  });

  test('the export self-check firing reclassifies NOTHING', () => {
    /* One line stating a SubTotal over a zero UnitPrice means the export lost a
       price, and then "the book states none" cannot be told from "we lost it".
       The honest answer is to move nothing at all. */
    const P = {
      bookUnpriced: rows(241, 'u'), bothPriced: rows(3, 'b'), erpDropped: rows(2, 'e'), bookDropped: rows(1, 'd'),
    };
    const r = splitBookUnpriced(P);
    expect(r.trusted).toBe(false);
    expect(r.noPrice).toBe(0);
    expect(r.differ).toBe(247);
    expect(r.why).toMatch(/self-check FIRED/);
  });

  test('an empty set stays empty rather than reading as a pass', () => {
    const r = splitBookUnpriced({ bookUnpriced: [], bothPriced: [], erpDropped: [], bookDropped: [] });
    expect(r.noPrice).toBe(0);
    expect(r.differ).toBe(0);
  });
});

describe('document total — our document carries RM 0.00', () => {
  test('moves the proven migrated receipts and keeps the rest', () => {
    const r = splitErpZeroMoney({
      rows: [moneyRow('A', 164_600, 0), moneyRow('B', 230_000, 0), moneyRow('C', 320_000, 12_000)],
      decision: DECISION,
      proof: new Map([proven('A'), proven('B'), proven('C')]),
    });
    expect(r.erpZero).toBe(2);
    /* C is RM 120.00, not zero: a real money difference, and it stays one even
       though the same document is migrated paperwork. */
    expect(r.differ).toBe(1);
    expect(r.erpZero + r.differ).toBe(3);
  });

  test('A PARTIAL COVER STILL REPORTS DIFFER', () => {
    const zeros = Array.from({ length: 10 }, (_, i) => moneyRow(`Z${i}`, 100_000, 0));
    const proof = new Map(zeros.slice(0, 6).map((z) => proven(z.erpNo)));
    const r = splitErpZeroMoney({ rows: zeros, decision: DECISION, proof });
    expect(r.erpZero).toBe(6);
    expect(r.differ).toBe(4);
    expect(r.impostors).toHaveLength(4);
  });

  test('a receipt that MOVED STOCK is an impostor, never a decision', () => {
    const r = splitErpZeroMoney({
      rows: [moneyRow('A', 164_600, 0)],
      decision: DECISION,
      proof: new Map([['A', { migratedNoStock: true, movements: 3 }]]),
    });
    expect(r.erpZero).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toMatch(/MOVED STOCK/);
  });

  test('a live, non-migrated document with no money is an impostor', () => {
    const r = splitErpZeroMoney({
      rows: [moneyRow('A', 164_600, 0)],
      decision: DECISION,
      proof: new Map([['A', { migratedNoStock: false, movements: 0 }]]),
    });
    expect(r.erpZero).toBe(0);
    expect(r.impostors[0].why).toMatch(/NOT migrated paperwork/);
  });

  test('an unmeasured document is an impostor — an absent proof is not a pass', () => {
    const r = splitErpZeroMoney({ rows: [moneyRow('A', 164_600, 0)], decision: DECISION, proof: new Map() });
    expect(r.erpZero).toBe(0);
    expect(r.impostors[0].why).toMatch(/no migrated-paperwork row/);
  });

  test('no probe at all reclassifies NOTHING and says so', () => {
    const r = splitErpZeroMoney({ rows: [moneyRow('A', 1, 0), moneyRow('B', 2, 0)], decision: DECISION, proof: null });
    expect(r.applied).toBe(false);
    expect(r.erpZero).toBe(0);
    expect(r.differ).toBe(2);
    expect(r.why).toMatch(/an unproven decision is not a decision/);
  });

  test('a type that declares no decision never reclassifies, whatever the shape', () => {
    const r = splitErpZeroMoney({
      rows: [moneyRow('A', 164_600, 0)], decision: null, proof: new Map([proven('A')]),
    });
    expect(r.erpZero).toBe(0);
    expect(r.differ).toBe(1);
  });
});

describe('absence — the owner has already ruled', () => {
  const REG = [{
    type: 'PO', docNo: 'PO-1', decidedOn: '2026-09-08', source: 'test',
    ruling: 'mint the accessory first', pending: 'create it', requires: 'every-line-description-only',
  }];
  const codeless = [{ hasCode: false }];
  const coded = [{ hasCode: true }];

  test('a registered document with its reason still true is DECIDED, the rest stay absent', () => {
    const r = splitDecidedAbsences({
      t: 'PO', missing: ['PO-1', 'PO-2'], linesOf: () => codeless, register: REG,
    });
    expect(r.decided).toBe(1);
    expect(r.absent).toBe(1);
    expect(r.absentDocs).toEqual(['PO-2']);
    expect(r.decided + r.absent).toBe(2);
  });

  test('THE REASON MUST STILL MEASURE TRUE — a coded line refuses the label', () => {
    const r = splitDecidedAbsences({ t: 'PO', missing: ['PO-1'], linesOf: () => coded, register: REG });
    expect(r.decided).toBe(0);
    expect(r.absent).toBe(1);
    expect(r.refused[0].why).toMatch(/no longer measures true/);
  });

  test('a document with no lines in the book cannot claim the label', () => {
    const r = splitDecidedAbsences({ t: 'PO', missing: ['PO-1'], linesOf: () => [], register: REG });
    expect(r.decided).toBe(0);
    expect(r.absent).toBe(1);
  });

  test('an entry naming an unknown predicate is refused, not trusted', () => {
    const r = splitDecidedAbsences({
      t: 'PO', missing: ['PO-1'], linesOf: () => codeless,
      register: [{ ...REG[0], requires: 'whatever-i-felt-like' }],
    });
    expect(r.decided).toBe(0);
    expect(r.refused[0].why).toMatch(/unknown predicate/);
  });

  test('the register never reaches another type', () => {
    const r = splitDecidedAbsences({ t: 'SO', missing: ['PO-1'], linesOf: () => codeless, register: REG });
    expect(r.decided).toBe(0);
    expect(r.absent).toBe(1);
  });

  test('an entry whose document is no longer absent is reported STALE', () => {
    const r = splitDecidedAbsences({ t: 'PO', missing: [], linesOf: () => codeless, register: REG });
    expect(r.stale).toHaveLength(1);
    expect(r.decided).toBe(0);
  });
});

describe('the go-live table, as measured', () => {
  /* A RECORDED FIXTURE, not a claim about production today. These are the
     buckets run 34178538830 printed (dispatched 2026-09-08 10:00 Malaysia time)
     — 241 unit-price findings on purchase orders, every one of them
     `book holds NO price` with a clean export self-check, and 109 goods-receipt
     document totals of which 100 are RM 0.00 in the ERP. The test pins the
     ARITHMETIC those inputs must produce, so a future edit cannot quietly move
     a different number of rows out of the difference columns. */
  test('241 purchase-order price findings are all "the book states no price"', () => {
    const r = splitBookUnpriced({
      bookUnpriced: rows(241, 'u'), bothPriced: [], erpDropped: [], bookDropped: [],
    });
    expect(r.noPrice).toBe(241);
    expect(r.differ).toBe(0);
  });

  test('100 of the 109 goods-receipt totals are the owner\'s RM 0.00, 9 stay differences', () => {
    const zeros = Array.from({ length: 100 }, (_, i) => moneyRow(`G${i}`, 200_000, 0));
    const real = Array.from({ length: 9 }, (_, i) => moneyRow(`R${i}`, 320_000, 12_000));
    const r = splitErpZeroMoney({
      rows: [...zeros, ...real],
      decision: DECISION,
      proof: new Map([...zeros, ...real].map((x) => proven(x.erpNo))),
    });
    expect(r.erpZero).toBe(100);
    expect(r.differ).toBe(9);
  });

  test('the gap total falls by exactly the reclassified counts, and by nothing else', () => {
    /* SO / PO / GR / DO / IV / PI, as the run printed them. */
    const before = [
      { absent: 0, phantom: 0, lineCnt: 19, item: 101, qty: 1, price: 0, money: 6 },
      { absent: 1, phantom: 0, lineCnt: 0, item: 10, qty: 0, price: 241, money: 1 },
      { absent: 0, phantom: 0, lineCnt: 0, item: 103, qty: 0, price: 0, money: 109 },
      { absent: 0, phantom: 0, lineCnt: 4, item: 0, qty: 2, price: 0, money: 1 },
      { absent: 6, phantom: 0, lineCnt: 9, item: 2, qty: 0, price: 0, money: 0 },
      { absent: 5, phantom: 0, lineCnt: 12, item: 1, qty: 0, price: 0, money: 0 },
    ];
    const sum = (xs: typeof before) => xs.reduce((a, r) => a + r.absent + r.phantom + r.lineCnt + r.item + r.qty + r.price + r.money, 0);
    expect(sum(before)).toBe(634);

    const po = splitBookUnpriced({ bookUnpriced: rows(241, 'u'), bothPriced: [], erpDropped: [], bookDropped: [] });
    const zeros = Array.from({ length: 100 }, (_, i) => moneyRow(`G${i}`, 200_000, 0));
    const real = Array.from({ length: 9 }, (_, i) => moneyRow(`R${i}`, 320_000, 12_000));
    const gr = splitErpZeroMoney({
      rows: [...zeros, ...real], decision: DECISION,
      proof: new Map([...zeros, ...real].map((x) => proven(x.erpNo))),
    });
    const abs = splitDecidedAbsences({
      t: 'PO', missing: ['PO-009979'], linesOf: () => [{ hasCode: false }],
    });

    const after = sum(before) - po.noPrice - gr.erpZero - abs.decided;
    expect(po.noPrice + gr.erpZero + abs.decided).toBe(342);
    expect(after).toBe(292);
  });
});

describe('the committed register is honest', () => {
  test('every entry names a predicate this file knows how to measure', () => {
    for (const e of DECIDED_ABSENCES) {
      expect(Object.keys(ABSENCE_PREDICATES)).toContain(e.requires);
      expect(e.ruling.length).toBeGreaterThan(10);
      expect(e.pending.length).toBeGreaterThan(10);
      expect(e.source.length).toBeGreaterThan(10);
    }
  });

  /* THE ONE THAT MATTERS. The register states a REASON, and a reason nobody
     re-measures is a story. This reads the committed AutoCount snapshot — the
     same file the reconcile reads — and requires each entry's reason to still
     be true of the book. When the decision is executed and the document leaves
     the book's outstanding cut, this test says so and the entry is deleted:
     that is the register being maintained, not the test being wrong. */
  test('each entry\'s stated reason still measures true against the committed snapshot', () => {
    const gz = resolve(__dirname, '..', 'scripts', 'data', 'ac-reconcile-truth.json.gz');
    const snap = JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8'));
    const L = Object.fromEntries((snap.line_fields as string[]).map((n, i) => [n, i]));
    const H = Object.fromEntries((snap.header_fields as string[]).map((n, i) => [n, i]));

    for (const e of DECIDED_ABSENCES) {
      const payload = snap.types[e.type];
      expect(payload, `snapshot carries no ${e.type} type`).toBeTruthy();
      const inBook = (payload.headers as string[][]).some((r) => r[H.docNo] === e.docNo);
      expect(
        inBook,
        `the decision register still names ${e.docNo}, which this snapshot's book does not contain. ` +
          'Either the decision is done or the document left scope — delete the entry from DECIDED_ABSENCES.',
      ).toBe(true);
      const lines = (payload.lines as string[][])
        .filter((r) => r[L.docNo] === e.docNo)
        .map((r) => ({ hasCode: r[L.hasCode] === '1' }));
      expect(
        ABSENCE_PREDICATES[e.requires as keyof typeof ABSENCE_PREDICATES].holds(lines),
        `${e.docNo} no longer satisfies "${e.requires}" — the recorded reason has evaporated, so the ` +
          'entry must go and the document must be counted as a gap again.',
      ).toBe(true);
    }
  });
});

/* ── item code: the checker had to GUESS which line is which ─────────────── */

/* A document the reconcile handed over as an item-code difference. */
const codeRow = (key: string) => ({ key, erpNo: `HC-${key}`, line: `${key}: book X vs ERP Y` });

describe('item code — a guessed pairing is not a wrong product, and a wrong product is not a guess', () => {
  test('no bags measured: NOTHING moves, and the count is preserved', () => {
    const r = splitGuessedItemCodePairing({ rows: [codeRow('a'), codeRow('b')], bags: null });
    expect(r.applied).toBe(false);
    expect(r.guessed).toBe(0);
    expect(r.differ).toBe(2);
    expect(r.guessed + r.differ).toBe(2);
  });

  test('equal multisets on a KEYLESS document move; the count is preserved', () => {
    const bags = new Map([
      ['a', { book: 'IMMORTAL x1 | ULTIMATE x1', erp: 'IMMORTAL x1 | ULTIMATE x1', keyed: false }],
      ['b', { book: 'IMMORTAL x1 | ULTIMATE x1', erp: 'IMMORTAL x1 | ULTIMATE x1', keyed: false }],
    ]);
    const r = splitGuessedItemCodePairing({ rows: [codeRow('a'), codeRow('b')], bags });
    expect(r.applied).toBe(true);
    expect(r.guessed).toBe(2);
    expect(r.differ).toBe(0);
    expect(r.impostors).toHaveLength(0);
  });

  test('THE ONE THAT MATTERS: multisets that DIFFER stay counted, and are named as impostors', () => {
    const bags = new Map([
      ['ok', { book: 'A x1 | B x1', erp: 'A x1 | B x1', keyed: false }],
      /* the wrong-product shape: we answer a product the book never names */
      ['wrong', { book: 'CELENE (A)-(K) x1', erp: 'CELENE (A)-(SS) x1', keyed: false }],
    ]);
    const r = splitGuessedItemCodePairing({ rows: [codeRow('ok'), codeRow('wrong')], bags });
    expect(r.guessed).toBe(1);
    expect(r.differ).toBe(1);
    expect(r.guessed + r.differ).toBe(2);
    expect(r.impostors).toHaveLength(1);
    expect(r.impostors[0].why).toContain('DIFFERENT goods');
  });

  test('a document that HAS a line key was paired for real, so its difference is real', () => {
    const bags = new Map([['a', { book: 'A x1 | B x1', erp: 'A x1 | B x1', keyed: true }]]);
    const r = splitGuessedItemCodePairing({ rows: [codeRow('a')], bags });
    expect(r.guessed).toBe(0);
    expect(r.differ).toBe(1);
  });

  test('a row with no measurement at all is an impostor, never a pass', () => {
    const r = splitGuessedItemCodePairing({ rows: [codeRow('unmeasured')], bags: new Map() });
    expect(r.guessed).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('unproven');
  });

  test('a quantity change is caught: the multiset carries counts, not just codes', () => {
    const bags = new Map([['q', { book: 'PILLOW x4', erp: 'PILLOW x2', keyed: false }]]);
    const r = splitGuessedItemCodePairing({ rows: [codeRow('q')], bags });
    expect(r.guessed).toBe(0);
    expect(r.differ).toBe(1);
  });
});

/* ── line count: the migrated chain builds from OUR document ─────────────── */

describe('line count — a shape difference is not a missing line', () => {
  test('no facts: NOTHING moves', () => {
    const r = splitMigratedChainLineShape({ rows: [codeRow('a')], facts: null });
    expect(r.applied).toBe(false);
    expect(r.lineShape).toBe(0);
    expect(r.differ).toBe(1);
  });

  test('totals identical and every code reconciles: moves, count preserved', () => {
    const facts = new Map([['PI-003477', { totalsEqual: true, perCode: [] }]]);
    const r = splitMigratedChainLineShape({ rows: [codeRow('PI-003477')], facts });
    expect(r.lineShape).toBe(1);
    expect(r.differ).toBe(0);
  });

  test('THE ONE THAT MATTERS: totals that DIFFER stay counted as a money gap', () => {
    const facts = new Map([['PI-x', { totalsEqual: false, perCode: [] }]]);
    const r = splitMigratedChainLineShape({ rows: [codeRow('PI-x')], facts });
    expect(r.lineShape).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('money gap');
  });

  test('totals agree but a PRICED line is missing: stays counted', () => {
    const facts = new Map([
      ['PI-y', { totalsEqual: true, perCode: [{ code: 'AK-ARMOUR MATT (K)', why: 'is in the book at RM 1880.00 and we do not carry it' }] }],
    ]);
    const r = splitMigratedChainLineShape({ rows: [codeRow('PI-y')], facts });
    expect(r.lineShape).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('the goods do not');
  });

  test('a partial cover still reports differ: six of ten move, never ten', () => {
    const facts = new Map<string, { totalsEqual: boolean; perCode: { code: string; why: string }[] }>();
    const list = Array.from({ length: 10 }, (_, i) => codeRow(`d${i}`));
    for (let i = 0; i < 10; i++) facts.set(`d${i}`, { totalsEqual: i < 6, perCode: [] });
    const r = splitMigratedChainLineShape({ rows: list, facts });
    expect(r.lineShape).toBe(6);
    expect(r.differ).toBe(4);
    expect(r.lineShape + r.differ).toBe(10);
  });
});
