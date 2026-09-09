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
  splitMigratedChainUnpairedBookLine,
  splitUnmigratedOnwardTransfer,
  splitUnmigratedSourceLine,
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

  /* A PARTIALLY keyed document is the normal state since the 2026-09-08 14:22
     backfill: it stamps only where the book FORCES the pairing and leaves the
     rest NULL. Asking the DOCUMENT whether it has keys then answers "yes" for a
     line that was still guessed. Production shape: GR-005334|PO-009887. */
  test('a partially keyed document: the GUESSED line moves and the KEYED line beside it does not', () => {
    const bags = new Map([
      ['part', { book: 'IMMORTAL x1 | ULTIMATE x1', erp: 'IMMORTAL x1 | ULTIMATE x1', keyed: true }],
    ]);
    const guessed = { ...codeRow('part'), erpKeyed: false };
    const read = { ...codeRow('part'), erpKeyed: true };
    const r = splitGuessedItemCodePairing({ rows: [guessed, read], bags });
    expect(r.guessed).toBe(1);
    expect(r.differ).toBe(1);
    expect(r.guessed + r.differ).toBe(2);
  });

  test('erpKeyed never overrides the multiset: an unkeyed line whose bags DIFFER stays a difference', () => {
    const bags = new Map([
      ['bad', { book: 'CELENE (A)-(K) x1', erp: 'CELENE (A)-(SS) x1', keyed: true }],
    ]);
    const r = splitGuessedItemCodePairing({ rows: [{ ...codeRow('bad'), erpKeyed: false }], bags });
    expect(r.guessed).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('DIFFERENT goods');
  });

  test('a caller that carries no per-line fact still gets the document answer', () => {
    const bags = new Map([['a', { book: 'A x1', erp: 'A x1', keyed: false }]]);
    const r = splitGuessedItemCodePairing({ rows: [codeRow('a')], bags });
    expect(r.guessed).toBe(1);
    expect(r.differ).toBe(0);
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

/* ── 5b. THE OTHER FACE OF THE SAME SHAPE ─────────────────────────────────
 *
 * A migrated invoice's lines come from OUR receipt / delivery, so the book can
 * state a row we do not carry for exactly the reason the line COUNT differs.
 * The line-count column was already split on that proof; the unpaired book line
 * was not, so nine sales invoices carried `a book line we do not have` after
 * `line count` had been measured as a shape on the same run and the same facts.
 *
 * THE PROOF IS THE SAME PROOF, and that is the point: one measurement, two
 * axes. A document whose total moves, or whose goods do not reconcile per item
 * code, fails BOTH — it can never be that only one of the two is waved through.
 */

describe('a book line we do not have — the other face of the migrated-chain shape', () => {
  test('no facts: NOTHING moves, and the count is preserved', () => {
    const r = splitMigratedChainUnpairedBookLine({ rows: [codeRow('a')], facts: null });
    expect(r.applied).toBe(false);
    expect(r.lineShape).toBe(0);
    expect(r.differ).toBe(1);
  });

  test('totals identical and every code reconciles: moves', () => {
    const facts = new Map([['I-2410-0082', { totalsEqual: true, perCode: [] }]]);
    const r = splitMigratedChainUnpairedBookLine({ rows: [codeRow('I-2410-0082')], facts });
    expect(r.lineShape).toBe(1);
    expect(r.differ).toBe(0);
  });

  test('THE ONE THAT MATTERS: a document whose TOTAL differs stays counted', () => {
    const facts = new Map([['I-x', { totalsEqual: false, perCode: [] }]]);
    const r = splitMigratedChainUnpairedBookLine({ rows: [codeRow('I-x')], facts });
    expect(r.lineShape).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('money gap');
  });

  test('THE OTHER ONE THAT MATTERS: a PRICED book line we do not carry stays counted', () => {
    const facts = new Map([
      ['I-y', { totalsEqual: true, perCode: [{ code: 'DSL-8050 SOFA', why: 'is in the book at RM 3250.00 and we do not carry it' }] }],
    ]);
    const r = splitMigratedChainUnpairedBookLine({ rows: [codeRow('I-y')], facts });
    expect(r.lineShape).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('the goods do not');
  });

  test('a document with no measurement at all is UNPROVEN, never waved through', () => {
    const facts = new Map([['other', { totalsEqual: true, perCode: [] }]]);
    const r = splitMigratedChainUnpairedBookLine({ rows: [codeRow('I-z')], facts });
    expect(r.lineShape).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('unproven');
  });

  test('a partial cover still reports differ: six of ten move, never ten', () => {
    const facts = new Map<string, { totalsEqual: boolean; perCode: { code: string; why: string }[] }>();
    const list = Array.from({ length: 10 }, (_, i) => codeRow(`d${i}`));
    for (let i = 0; i < 10; i++) facts.set(`d${i}`, { totalsEqual: i < 6, perCode: [] });
    const r = splitMigratedChainUnpairedBookLine({ rows: list, facts });
    expect(r.lineShape).toBe(6);
    expect(r.differ).toBe(4);
    expect(r.lineShape + r.differ).toBe(10);
  });
});

/* ── 6. THE ONWARD TRANSFER NOBODY MIGRATED ────────────────────────────────
 *
 * The account book holds 5,283 purchase invoices and the ERP holds 55, because
 * the purchase-invoice HISTORY was deliberately never migrated. So AutoCount
 * says a goods-receipt line has been fully invoiced and we say nothing has
 * gone on — 283 of 400 receipt pairs, every one of them printing "we record 0".
 *
 * That is a DECISION, not a defect, and a decision belongs in a column of its
 * own with the decision's name on it. It must not become an amnesty: the same
 * sentence would cover a receipt whose invoice we DO hold and forgot to count,
 * which is a real defect. So the proof is per document and it is measured —
 * every onward document the book raised off this one must be ABSENT from ours.
 */
describe('onward transfer — the downstream document type was never migrated', () => {
  const toRow = (
    ac: string,
    bookDocNo: string,
    erpCounter: number,
    verdict = 'erp_low',
    bookTransfered = 10000,
  ) => ({
    key: `k-${ac}`, ac, erpNo: `HC-${ac}`, bookDocNo, verdict, bookTransfered, erpCounter,
    line: `${ac}: book moved ${bookTransfered} and we record ${erpCounter}`, proceeded: true,
  });
  const DECISION = {
    label: 'the purchase-invoice history was never migrated',
    onwardType: 'PI',
    ruling: 'the owner declined importing the purchase-invoice history',
    consequence: 'our receipt can never show an invoiced quantity for a document we do not hold',
  };
  /* the book raised PI-100 off GR-1; we hold no purchase invoice at all */
  const onwardOf = (d: string) => (d === 'GR-1' ? ['PI-100'] : d === 'GR-2' ? ['PI-200'] : []);

  test('no decision declared: nothing moves', () => {
    const r = splitUnmigratedOnwardTransfer({
      rows: [toRow('GR-1', 'GR-1', 0)], decision: null, coverage: new Set<string>(), onwardOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.applied).toBe(false);
  });

  test('no coverage measurement: nothing moves — an unproven decision is not a decision', () => {
    const r = splitUnmigratedOnwardTransfer({
      rows: [toRow('GR-1', 'GR-1', 0)], decision: DECISION, coverage: null, onwardOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.applied).toBe(false);
  });

  test('the book invoiced it, we hold no such invoice, and we record 0: the decision covers it', () => {
    const r = splitUnmigratedOnwardTransfer({
      rows: [toRow('GR-1', 'GR-1', 0)], decision: DECISION, coverage: new Set<string>(), onwardOf,
    });
    expect(r.notMigrated).toBe(1);
    expect(r.differ).toBe(0);
    expect(r.impostors).toHaveLength(0);
  });

  test('WE HOLD THE ONWARD INVOICE: that is a real defect and it stays counted', () => {
    const r = splitUnmigratedOnwardTransfer({
      rows: [toRow('GR-1', 'GR-1', 0)], decision: DECISION, coverage: new Set(['PI-100']), onwardOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('PI-100');
  });

  test('we record SOME of it: not "we record 0", so the decision does not describe it', () => {
    const r = splitUnmigratedOnwardTransfer({
      rows: [toRow('GR-1', 'GR-1', 5000)], decision: DECISION, coverage: new Set<string>(), onwardOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('we record 5000');
  });

  test('we claim a transfer the book does not have: never covered, whatever the coverage says', () => {
    const r = splitUnmigratedOnwardTransfer({
      rows: [toRow('GR-1', 'GR-1', 10000, 'erp_asserts_untransferred', 0)],
      decision: DECISION, coverage: new Set<string>(), onwardOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
  });

  test('the book moved it and NO onward document names it: unexplained, stays counted', () => {
    const r = splitUnmigratedOnwardTransfer({
      rows: [toRow('GR-9', 'GR-9', 0)], decision: DECISION, coverage: new Set<string>(), onwardOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('no PI');
  });

  test('a partial cover still reports differ: two of five move, never five', () => {
    const list = [
      toRow('GR-1', 'GR-1', 0),          // covered
      toRow('GR-2', 'GR-2', 0),          // covered
      toRow('GR-3', 'GR-3', 0),          // no onward doc — unexplained
      toRow('GR-4', 'GR-1', 400),        // we record some
      toRow('GR-5', 'GR-2', 0),          // onward doc IS held
    ];
    const r = splitUnmigratedOnwardTransfer({
      rows: list, decision: DECISION, coverage: new Set(['PI-200']), onwardOf,
    });
    /* GR-2 and GR-5 both point at PI-200, which we DO hold, so neither moves. */
    expect(r.notMigrated).toBe(1);
    expect(r.differ).toBe(4);
    expect(r.notMigrated + r.differ).toBe(5);
  });

  test('THE COUNT IS NEVER LOST, on every path', () => {
    const list = Array.from({ length: 9 }, (_, i) => toRow(`g${i}`, 'GR-1', i === 0 ? 0 : i * 100));
    for (const args of [
      { decision: null, coverage: new Set<string>() },
      { decision: DECISION, coverage: null },
      { decision: DECISION, coverage: new Set<string>() },
      { decision: DECISION, coverage: new Set(['PI-100']) },
    ]) {
      const r = splitUnmigratedOnwardTransfer({ rows: list, onwardOf, ...args } as never);
      expect(r.notMigrated + r.differ).toBe(9);
    }
  });
});

/**
 * SOURCE LINE — the purchase order the book raised this line FROM was never
 * migrated. The mirror of the block above, one level up the chain, and the
 * distinction is the whole reason it could not share that code: the onward
 * split keys on the DOCUMENT, this one keys on the SOURCE of an individual
 * LINE. `GR-000201` carries 12 lines raised from TEN purchase orders, two of
 * which are in scope — so the document is half-covered and only a per-line
 * answer is honest.
 *
 * Measured 2026-09-09: 124 of the 211 in-scope goods receipts carry lines from
 * a purchase order we never imported, 837 such lines against 587 in scope.
 * The book's purchase invoice bills all of them; ours can only carry the ones
 * whose order came in. Not a line we lost — a line we never had.
 *
 * The danger this file exists for applies here exactly: the same sentence
 * would also cover a line raised from a purchase order we DO hold and simply
 * failed to import, which is a real defect. So the proof is per LINE and it is
 * measured — the book must name the source, it must be a purchase order, and
 * that order must be ABSENT from ours.
 */
describe('source line — the purchase order the line was raised from was never migrated', () => {
  /* `key` IS the AutoCount document number, exactly as the reconcile pushes it
     (`key: ac`). The row carries no separate `ac` field, and naming one that
     does not exist is how the first production run printed 78 refusals all
     beginning `undefined:`. */
  const toRow = (ac: string, bookDocNo: string, ...bookDtlKeys: string[]) => ({
    key: ac, erpNo: `HC-${ac}`, bookDocNo, bookDtlKeys,
    line: `${ac}: the book bills ${bookDtlKeys.length} line(s) we do not carry`,
  });
  const DECISION = {
    label: 'the purchase orders outside the outstanding population were never migrated',
    sourceType: 'PO',
    ruling: 'only OUTSTANDING purchase orders were imported',
    consequence: 'our invoice carries only the lines whose purchase order was migrated',
  };
  /* PI-1 line 11 came off PO-OUT (never imported), line 12 off PO-IN (we hold
     it), line 13 off a SALES order, line 14 off nothing the book names. Line 15
     is the AMBIGUOUS hop: the receipt took that item against two orders and the
     book cannot say which, so both are carried. */
  const SOURCES: Record<string, { type: string; docNo: string }[]> = {
    'PI-1|11': [{ type: 'PO', docNo: 'PO-OUT' }],
    'PI-1|12': [{ type: 'PO', docNo: 'PO-IN' }],
    'PI-1|13': [{ type: 'SO', docNo: 'SO-9' }],
    'PI-1|14': [],
    'PI-1|15': [{ type: 'PO', docNo: 'PO-OUT' }, { type: 'PO', docNo: 'PO-OUT2' }],
    'PI-1|16': [{ type: 'PO', docNo: 'PO-OUT' }, { type: 'PO', docNo: 'PO-IN' }],
  };
  const sourceOf = (d: string, k: string) => SOURCES[`${d}|${k}`] ?? [];
  const COVERAGE = new Set(['PO-IN']);

  test('no decision declared: nothing moves', () => {
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-1', 'PI-1', '11')], decision: null, coverage: COVERAGE, sourceOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.applied).toBe(false);
  });

  test('no coverage measurement: nothing moves — an unproven decision is not a decision', () => {
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-1', 'PI-1', '11')], decision: DECISION, coverage: null, sourceOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.applied).toBe(false);
  });

  test('the line came off a purchase order we never imported: the decision covers it', () => {
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-1', 'PI-1', '11')], decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(r.notMigrated).toBe(1);
    expect(r.differ).toBe(0);
    expect(r.impostors).toHaveLength(0);
    expect(r.moved[0].sources[0].docNo).toBe('PO-OUT');
  });

  test('WE HOLD THE SOURCE PURCHASE ORDER: a missing line there is a real defect', () => {
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-1', 'PI-1', '12')], decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('PO-IN');
  });

  test('the source is NOT a purchase order: this decision does not cover it', () => {
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-1', 'PI-1', '13')], decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('SO-9');
  });

  test('the book names NO source for the line: unexplained, stays counted', () => {
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-1', 'PI-1', '14')], decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('names no source document');
  });

  test('a source with a type but no document number is not a source', () => {
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-2', 'PI-2', '21')],
      decision: DECISION,
      coverage: COVERAGE,
      sourceOf: () => [{ type: 'PO', docNo: '' }],
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
  });

  test('the hop is AMBIGUOUS and every candidate is out of scope: still proven', () => {
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-5', 'PI-1', '15')], decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(r.notMigrated).toBe(1);
    expect(r.differ).toBe(0);
    expect(r.moved[0].sources).toHaveLength(2);
  });

  test('the hop is AMBIGUOUS and ONE candidate is a PO we hold: never proven', () => {
    /* The checker cannot say which order the line came from, so it must not
       pick the one that suits the answer — docs/bugs/0690. */
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-6', 'PI-1', '16')], decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('PO-IN');
  });

  test('no line key recorded at all: nothing to attribute, so nothing moves', () => {
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-3', 'PI-3')], decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('no unpaired book line key');
  });

  test('MANY LINES, ALL EXPLAINED: the document moves, and every source is kept', () => {
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-4', 'PI-4', 'a', 'b')],
      decision: DECISION,
      coverage: COVERAGE,
      sourceOf: (_d: string, k: string) => [{ type: 'PO', docNo: k === 'a' ? 'PO-X' : 'PO-Y' }],
    });
    expect(r.notMigrated).toBe(1);
    expect(r.differ).toBe(0);
    expect(r.moved[0].sources.map((s: { docNo: string }) => s.docNo)).toEqual(['PO-X', 'PO-Y']);
  });

  test('ONE DOCUMENT, LINES BOTH WAYS: ONE real line keeps the whole document counted', () => {
    /* `GR-000201`'s shape in miniature, and the property that matters most
       here: a document carrying eleven migration gaps and one line we really
       lost must NOT leave the difference column. That is docs/bugs/0668. */
    const r = splitUnmigratedSourceLine({
      rows: [toRow('PI-1', 'PI-1', '11', '12')],   // PO-OUT covered, PO-IN real
      decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(r.notMigrated).toBe(0);
    expect(r.differ).toBe(1);
    expect(r.impostors[0].why).toContain('PO-IN');
  });

  test('a mixed population: only the wholly-explained documents move', () => {
    const r = splitUnmigratedSourceLine({
      rows: [
        toRow('PI-a', 'PI-1', '11'),         // wholly covered
        toRow('PI-b', 'PI-1', '11', '12'),   // one line we hold the PO for
        toRow('PI-c', 'PI-1', '13'),         // wrong source type
        toRow('PI-d', 'PI-1', '14'),         // no source named
      ],
      decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(r.notMigrated).toBe(1);
    expect(r.differ).toBe(3);
    expect(r.impostors).toHaveLength(3);
  });

  test('EVERY refusal NAMES the document and carries its key', () => {
    /* The first production run printed all 78 refusals as `undefined: ...`
       because the message read a field the reconcile's rows do not carry. A
       sentence that names no document is not a finding anyone can work, and the
       report pairs the two passes' reasons BY KEY. */
    const r = splitUnmigratedSourceLine({
      rows: [
        toRow('PI-a', 'PI-1', '12'),   // a PO we hold
        toRow('PI-b', 'PI-1', '13'),   // wrong source type
        toRow('PI-c', 'PI-1', '14'),   // no source named
        toRow('PI-d', 'PI-1'),         // no line key at all
      ],
      decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(r.impostors).toHaveLength(4);
    for (const i of r.impostors) {
      expect(i.key).toBeTruthy();
      expect(i.why.startsWith(`${i.key}:`)).toBe(true);
      expect(i.why).not.toContain('undefined');
    }
  });

  test('a refusal says whether the held order is CERTAIN or one of several', () => {
    const one = splitUnmigratedSourceLine({
      rows: [toRow('PI-a', 'PI-1', '12')], decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(one.impostors[0].why).toContain('was raised from');
    const many = splitUnmigratedSourceLine({
      rows: [toRow('PI-b', 'PI-1', '16')], decision: DECISION, coverage: COVERAGE, sourceOf,
    });
    expect(many.impostors[0].why).toContain('may have been raised from');
    expect(many.impostors[0].why).toContain('2 orders');
  });

  test('THE COUNT IS NEVER LOST, on every path', () => {
    const list = [['11'], ['12'], ['13'], ['14'], ['11', '12'], [], ['11']].map((k, i) =>
      toRow(`p${i}`, 'PI-1', ...k));
    for (const args of [
      { decision: null, coverage: COVERAGE },
      { decision: DECISION, coverage: null },
      { decision: DECISION, coverage: new Set<string>() },
      { decision: DECISION, coverage: COVERAGE },
    ]) {
      const r = splitUnmigratedSourceLine({ rows: list, sourceOf, ...args } as never);
      expect(r.notMigrated + r.differ).toBe(7);
    }
  });
});
