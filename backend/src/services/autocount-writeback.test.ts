// The composer that turns an ERP document into what AcSyncService accepts, and
// the client's read of what AutoCount answered.
//
// The master maps come from PR #1696, built against the live AED_HOUZS book;
// the payload SHAPE is AcSyncService's (Details[] / Desc2 / UDF{}), which is
// the service that exists and was proven against that book on 2026-08-07.
import { describe, expect, test, vi } from 'vitest';
import {
  composeCreateSo,
  composeCreatePo,
  composeSoToPo,
  AcSoToPoAlignmentError,
  composeDetails,
  composeEdit,
  KeylessLineError,
  MissingAgentError,
  MissingLocationError,
  SofaCollapseError,
  resolveAcAgent,
  parseCreatedLines,
  parseAcMismatches,
  composeDescription2,
  ItemCodeError,
  MissingCreditorError,
  MissingSalesLocationError,
  bookSpelling,
  bookSpellingOrOwn,
  soBranding,
  soCustomerRef,
  soInvoiceAddress,
  callAcService,
  acServiceConfig,
  acUdfDate,
  AC_DEBTOR_CODE,
  AC_PURCHASE_AGENT,
  AGENT_MAP,
  BRANDING_MAP,
  LOCATION_MAP,
  VENUE_MAP,
  type ErpSoHeader,
  type ErpPoHeader,
  type ErpLine,
  type ComposeOptions,
} from './autocount-writeback';
import { buildAcItemIndex } from './autocount-item-code';

/* A stand-in cutover map. The real one is 1561 rows compiled from
   autocount-erp-mapping-1561.csv and is exercised against the real corpus in
   autocount-item-code.test.ts; here the point is the COMPOSER, so the map is
   four rows the assertions can quote. Columns: ac, erp, category, supplier. */
const TEST_INDEX = buildAcItemIndex([
  'AC-CODE-1\tSKU-1\tMATTRESS\t400-H004',
  'AC-CODE-2\tSKU-2\tMATTRESS\t400-H004',
  'AC-CODE-B\tB\tMATTRESS\t400-H004',
  'AC-CODE-C\tC\tMATTRESS\t400-H004',
].join('\n'));
const opts: ComposeOptions = { itemIndex: TEST_INDEX };

const header: ErpSoHeader = {
  doc_no: 'HC-SO-1', so_date: '2026-08-10', debtor_name: 'Tan Ah Kow',
  agent: 'kar jiun', sales_location: 'PETALING JAYA', branding: 'akemi',
  venue: 'KSL CITY MALL', address1: 'A1', address2: 'A2', address3: null, address4: null,
  city: null, postcode: null, customer_state: null,
  phone: '0123', emergency_contact_phone: null,
  ref: 'REF', customer_so_no: 'CUST-PO-7',
};

const line = (over: Partial<ErpLine> = {}): ErpLine => ({
  item_code: 'SKU-1', description: 'Mattress', qty: 2, unit_price_sen: 199_900, ...over,
});

/* The name behind mfg_sales_orders.salesperson_id, which composeCreateSo now
   REQUIRES. `header` above carries a mappable `agent`, so these cases are the
   ones where the fallback does not fire; the fallback itself, and the refusal
   when neither source answers, have their own describe block below. */
const SALESPERSON: string | null = null;

/**
 * `composeCreateSo` with NO outstanding balance, for every case that is not
 * about the balance.
 *
 * The real parameter is required and positional, because it decides what a live
 * account book says a customer owes. Threading a number through thirty-eight
 * assertions that are about item codes, venues and addresses would bury it;
 * pinning it to `null` here keeps those payloads exactly as they were (the key
 * is omitted) and leaves the BALANCE UDF with its own describe block, where the
 * value is passed explicitly and asserted.
 */
const createSo = (
  h: ErpSoHeader,
  ls: ErpLine[],
  salespersonName: string | null,
  o: ComposeOptions = {},
) => composeCreateSo(h, ls, salespersonName, null, [], o);
/* The helper passes NO payment references, which is the shape of every order
   whose payments carry neither an account sheet nor an approval code. The
   PAYEMENT round trip has its own file. */

describe('master mapping', () => {
  test('normalises case and spacing before mapping (a salesperson types freely)', () => {
    expect(bookSpelling('kar jiun', AGENT_MAP)).toBe('TAN KAR JIUN');
    expect(bookSpelling('  Mei   Ting ', AGENT_MAP)).toBe('MEI TING');
  });

  test('a value that is already the AutoCount spelling passes through', () => {
    expect(bookSpelling('TAN KAR JIUN', AGENT_MAP)).toBe('TAN KAR JIUN');
    expect(bookSpelling('KL', LOCATION_MAP)).toBe('KL');
  });

  test('an unknown value maps to null rather than being invented', () => {
    expect(bookSpelling('SOMEONE NEW', AGENT_MAP)).toBeNull();
    expect(bookSpelling('', AGENT_MAP)).toBeNull();
    expect(bookSpelling(null, AGENT_MAP)).toBeNull();
  });
});

/* THE ROOT CAUSE OF FOUR AUDIT FINDINGS, IN ONE FUNCTION (2026-08-14). The old
   `mapOrPassthrough` returned null for anything its map had not been told
   about, and null is the fatal value in all three failure modes: "" against a
   foreign key, a dropped key on a UDF, and an overwrite on /edit. Measured
   against the live book's own vocabularies, every target the four maps can
   emit is ALREADY a master there — so the maps never protected against sending
   something unknown, they only deleted what they had not heard of. */
describe('bookSpellingOrOwn — the maps are spelling corrections, not an allow-list', () => {
  test("the book's own spelling still wins where the map has one", () => {
    expect(bookSpellingOrOwn('SUTERA MALL', VENUE_MAP)).toBe('SUTERA MALL SOLO');
    expect(bookSpellingOrOwn('petaling jaya', LOCATION_MAP)).toBe('KL');
  });

  test('a value the map has never heard of is KEPT, for ensure-masters to open', () => {
    expect(bookSpellingOrOwn('MIDVALLEY EXHIBITION CENTRE', VENUE_MAP))
      .toBe('MIDVALLEY EXHIBITION CENTRE');
    expect(bookSpellingOrOwn('SUNWAY', LOCATION_MAP)).toBe('SUNWAY');
    expect(bookSpellingOrOwn('CARRESS', BRANDING_MAP)).toBe('CARRESS');
  });

  /* /ensure-masters opens a master under EXACTLY the string it is given, so two
     spaces would open two of it. Case is preserved: the service compares
     options with OrdinalIgnoreCase, so an existing option is matched, not
     duplicated. */
  test('a kept value is whitespace-collapsed, because two spaces would open two masters', () => {
    /* Deliberately a venue the map does NOT hold: this is about whitespace, and
       a mapped value would exercise the lookup instead. AEON BIG KEPONG used to
       be the example and stopped being one the day it was bound to
       AEON BIG KEPONG SOLO. */
    expect(bookSpellingOrOwn('  AEON  BIG   PUCHONG ', VENUE_MAP)).toBe('AEON BIG PUCHONG');
    expect(Object.keys(VENUE_MAP)).not.toContain('AEON BIG PUCHONG');
  });

  test('null still means null — but ONLY when the ERP has no value at all', () => {
    expect(bookSpellingOrOwn(null, VENUE_MAP)).toBeNull();
    expect(bookSpellingOrOwn('   ', VENUE_MAP)).toBeNull();
  });
});

describe('composeCreateSo', () => {
  const payload = createSo(header, [line()], SALESPERSON, opts);

  test('writes the fixed debtor account with the real customer name over it', () => {
    expect(payload.DebtorCode).toBe(AC_DEBTOR_CODE);
    expect(payload.DebtorName).toBe('Tan Ah Kow');
    expect(payload.Attention).toBe('Tan Ah Kow');
  });

  test('maps agent, location, branding and venue to their AutoCount spellings', () => {
    expect(payload.Agent).toBe('TAN KAR JIUN');
    expect(payload.SalesLocation).toBe('KL');
    expect(payload.UDF).toEqual({
      BRANDING: 'AKEMI',
      VENUE: 'KSL CITY MALL JOHOR SOLO',
      ToPONo: 'CUST-PO-7',
    });
  });

  test('money crosses as a decimal — sen is an ERP convention, not AutoCount"s', () => {
    expect(payload.Details[0].UnitPrice).toBe(1999);
    expect(payload.Details[0].Qty).toBe(2);
  });

  test('a blank UDF is dropped, not sent as an empty option', () => {
    const p = createSo(
      { ...header, branding: null, venue: null, customer_so_no: null },
      [line()], SALESPERSON, opts,
    );
    expect(p.UDF).toEqual({});
  });

  /* Owner 2026-08-12: the SO's Processing date (账目日期) must reach AutoCount.
     Its storage is processing_date — one column (0189) under one name (0284),
     so this label has exactly one source. */
  test('the Processing date goes out as the PDate UDF', () => {
    const p = createSo({ ...header, processing_date: '2026-09-01' }, [line()], SALESPERSON, opts);
    expect(p.UDF.PDate).toBe('2026-09-01');
  });

  test('a Processing date that arrives as a timestamp is trimmed to the date', () => {
    const p = createSo({ ...header, processing_date: '2026-09-01T00:00:00' }, [line()], SALESPERSON, opts);
    expect(p.UDF.PDate).toBe('2026-09-01');
  });

  test('no Processing date sends no PDate at all', () => {
    expect(createSo(header, [line()], SALESPERSON, opts).UDF.PDate).toBeUndefined();
    expect(createSo({ ...header, processing_date: null }, [line()], SALESPERSON, opts).UDF.PDate)
      .toBeUndefined();
  });
});

/* THE GO-LIVE FAILURE, 2026-08-13. Two re-queued sales orders retried four
   times each and AED_HOUZS answered `Foreign Key Error (Constraint
   Name=FK_SO_SalesAgent)`. Both carried an empty `agent`, because no SO form
   sends `body.agent` — and an empty Agent reaches AcSyncService as "", which is
   not a row in dbo.SalesAgent. `mastersOf` could not save them either: it only
   asks for an agent when the payload names one. */
describe('the salesperson AutoCount is given (FK_SO_SalesAgent)', () => {
  const noAgent: ErpSoHeader = { ...header, agent: null };

  test('an empty agent falls back to the salesperson behind salesperson_id', () => {
    const p = createSo(noAgent, [line()], 'Chang Shi Ting', opts);
    expect(p.Agent).toBe('Chang Shi Ting');
  });

  /* AGENT_MAP is a record of how the book already spells the reps it has, not
     an allow-list of who may sell. A name it knows goes out in the book's
     spelling so the fallback cannot open a second agent beside an existing
     one. */
  test('a salesperson the book already spells goes out in ITS spelling', () => {
    expect(createSo(noAgent, [line()], 'shi ting', opts).Agent)
      .toBe('Chang Shi Ting');
    expect(createSo(noAgent, [line()], 'zack', opts).Agent).toBe('Zack');
  });

  /* D10's rule, applied to people (owner 2026-08-13): an unmapped value is no
     longer a refusal, it is opened. Whatever string is sent is exactly what
     /ensure-masters creates the agent under, so a rep hired since the map was
     built is writable instead of blocked. */
  test('a salesperson the map has never heard of is sent as themselves', () => {
    expect(createSo(noAgent, [line()], 'Nurul Hidayah', opts).Agent)
      .toBe('Nurul Hidayah');
  });

  test('an agent the ERP does hold still wins over the salesperson link', () => {
    expect(createSo(header, [line()], 'Nurul Hidayah', opts).Agent)
      .toBe('TAN KAR JIUN');
  });

  /* THE BOTH-EMPTY CASE. Sending "" is what produced the go-live failure, and
     the document cannot land either way — the foreign key is deterministic. So
     the create is REFUSED, which costs nothing that sending would have gained
     and turns a 500 in the AutoCount host's log into a `skipped` outbox row an
     operator can read and a re-queue can retry. */
  test('neither source REFUSES the create, naming the remedy', () => {
    let err: unknown;
    try { createSo(noAgent, [line()], null, opts); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MissingAgentError);
    expect((err as Error).message).toContain('FK_SO_SalesAgent');
    expect((err as Error).message).toContain('Assign a salesperson');
  });

  /* The free-text column has no writer that keeps it honest: production rows
     hold bare scm.staff UUIDs (useStaffLookup carries a UUID_RE for exactly
     that) and placeholder text like "Unassigned", the order that produced the
     confirm gate's salesperson rule. /ensure-masters opens an agent under
     EXACTLY the string it is given, so neither may pass through. */
  test('junk in `agent` is never opened as a sales agent', () => {
    const junk = ['c115a11d-5a53-a0c1-020a-c64cc4d9b4fb', 'Unassigned'];
    for (const text of junk) {
      expect(resolveAcAgent(text, null), text).toBeNull();
      /* ...but a real salesperson link rescues the document rather than
         letting the junk decide it. */
      expect(resolveAcAgent(text, 'Nurul Hidayah'), text).toBe('Nurul Hidayah');
    }
  });

  test('the refusal quotes what it saw, so the row says which case this is', () => {
    expect(new MissingAgentError(null).message).toContain('names no salesperson at all');
    expect(new MissingAgentError('Unassigned').message).toContain('"Unassigned"');
  });
});

describe('acUdfDate — what may be handed to a date UDF', () => {
  test('passes a plain date through and trims a timestamp to it', () => {
    expect(acUdfDate('2026-09-01')).toBe('2026-09-01');
    expect(acUdfDate('2026-09-01T13:45:00Z')).toBe('2026-09-01');
    expect(acUdfDate('2026-09-01 13:45:00')).toBe('2026-09-01');
  });

  test('empties are nothing to send', () => {
    expect(acUdfDate(null)).toBeNull();
    expect(acUdfDate(undefined)).toBeNull();
    expect(acUdfDate('')).toBeNull();
  });

  /* NOT passed through, deliberately. AcSyncService writes every UDF inside its
     exception-swallowing Set(), so a value AutoCount rejects fails invisibly —
     no error, no failed outbox row, a date that silently never updates. Only
     what is unambiguously a date is worth sending. */
  test('anything that is not a date is dropped rather than passed through', () => {
    expect(acUdfDate('01/09/2026')).toBeNull();
    expect(acUdfDate('next Tuesday')).toBeNull();
    expect(acUdfDate('2026-9-1')).toBeNull();
  });
});

describe('Description 2 — AutoCount\'s Further Description, which is what the cutover PARSED', () => {
  /* Owner 2026-08-15: the ERP's variants were pulled OUT of Further Description
     at the cutover, so the specification has to go back IN. This block is the
     proof that the write-back now emits the ERP's OWN rendering of that
     specification (buildVariantSummary) rather than a second, poorer one. */

  test('a sofa carries the colour, the seat and the leg — the SO line\'s own summary', () => {
    /* Was 'Col: Beige / Fabric: Linen / Seat: 45 / Leg: 10' from a private
       four-attribute composer. The fabric SERIES ("Linen") is deliberately gone:
       buildVariantSummary shows the series only when the COLOUR is not yet
       chosen (COLOUR KIV), because once it is, the colour code carries it. That
       is the rule every SO / PO / DO line in this system already prints, and the
       account book now reads the same string as the paperwork. */
    expect(composeDescription2(line({
      item_group: 'sofa',
      variants: { fabricColor: 'Beige', fabricLabel: 'Linen', seatHeight: '45', legHeight: '10' },
    }))).toBe('Beige / SEAT 45 / LEG 10');
  });

  /* THE DEFECT THIS BLOCK EXISTS FOR. A bedframe keeps its colour in
     `fabricCode` / `colourLabel` and its build in `gap` / `divanHeight` — none
     of which the old composer read, so an ERP-created bedframe reached the
     account book with an EMPTY Further Description while the book's own text
     carries COL on 6,741 lines, DIVAN on 5,778 and GAP on 2,620, its three
     commonest labels. The same shape as the three faults in section 2 of
     docs/autocount-writeback-golive-coe.md: the fact was in one column and the
     write-back read another. */
  test('a bedframe carries the colour, the divan, the leg and the GAP', () => {
    expect(composeDescription2(line({
      item_group: 'bedframe',
      variants: {
        fabricCode: 'PC151-01', colourLabel: 'Sand',
        divanHeight: '8"', legHeight: '2"', gap: '12"', totalHeight: '22"',
      },
    }))).toBe('PC151-01 Sand / DIVAN 8" + LEG 2" / GAP 12" / T.Heights 22"');
  });

  test('the special order rides along, because it changes the physical item', () => {
    expect(composeDescription2(line({
      item_group: 'bedframe',
      variants: { fabricCode: 'BF-16', gap: '14"', specials: ['Fully Cover'] },
    }))).toContain('Fully Cover');
  });

  /* THE ECHO PATH, and it is load-bearing rather than a nicety: both cutover
     importers wrote the book's ORIGINAL Desc2 onto every migrated line, and D9
     hands this function a collapsed sofa whose description2 is the build text
     the collapse has already decided and gated. Re-deriving either from
     variants would be lossy — see the corpus test in
     autocount-sofa-collapse.test.ts. */
  test('a stored description2 still wins, verbatim, over anything derived', () => {
    expect(composeDescription2(line({
      description2: 'KING 6x7',
      item_group: 'bedframe',
      variants: { fabricCode: 'PC151-01', gap: '12"', divanHeight: '8"' },
    }))).toBe('KING 6x7');
  });

  test('a line with neither carries no Desc2 rather than an empty string', () => {
    expect(composeDescription2(line())).toBeNull();
    expect(composeDescription2(line({ item_group: 'bedframe', variants: {} }))).toBeNull();
  });
});

describe('ItemCode resolution (D10) — no silent fallback to item_code', () => {
  test('a mapped code is replaced by its AutoCount ItemCode', () => {
    expect(createSo(header, [line()], SALESPERSON, opts).Details[0].ItemCode).toBe('AC-CODE-1');
  });

  /* THE DEFECT THIS REPLACED, and the assertion that still guards it. The
     composer once ran with identityResolver and `resolve(...).acItemCode ??
     l.item_code`, so a MAPPED line could silently go out under its ERP code.
     That must never happen: if the book knows this item, we send the book's
     name for it. */
  test('a mapped code is NEVER sent as itself', () => {
    const d = createSo(header, [line()], SALESPERSON, opts).Details[0];
    expect(d.ItemCode).toBe('AC-CODE-1');
    expect(d.ItemCode).not.toBe(line().item_code);
  });

  /* What CHANGED, 2026-08-13. An unmapped code used to refuse the whole
     document, which was right while sending it meant referencing an item the
     licensed book does not hold. /ensure-masters opens the item first now
     (AcSyncService.cs:495-521), and the old rule's cost was total: whole
     product ranges are in no cutover row, so every order containing one was
     blocked with no way forward. */
  test('an unmapped code goes out under its own name instead of sinking the order', () => {
    const d = createSo(header, [line({ item_code: 'SKU-NOT-IN-THE-BOOK' })], SALESPERSON, opts).Details[0];
    expect(d.ItemCode).toBe('SKU-NOT-IN-THE-BOOK');
  });

  test('a document mixing mapped and unmapped lines ships whole, each line its own answer', () => {
    const p = createSo(header, [
      line(),
      line({ item_code: 'SKU-NOT-IN-THE-BOOK' }),
      line({ item_code: 'SKU-2' }),
    ], SALESPERSON, opts);
    expect(p.Details.map((d) => d.ItemCode)).toEqual(['AC-CODE-1', 'SKU-NOT-IN-THE-BOOK', 'AC-CODE-2']);
  });

  /* A blank code is the one input with no answer, so ItemCodeError is still
     reachable and still names every failing line at once — an operator fixing
     one and re-saving into the next is how a divergence outlives everyone who
     remembers it. */
  test('a blank code still refuses, and the refusal names every failing line', () => {
    let msg = '';
    try {
      createSo(header, [line({ item_code: '' }), line({ item_code: '   ' })], SALESPERSON, opts);
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('2 line(s)');
  });
});

/* ── composeSoToPo — the transfer is the create's master, plus the keys ──────
   The whole point of the shape: this function does NOT list the master's
   fields, so a field added to composeCreatePo reaches a transfer without anyone
   editing this function. Two fields reached the live account book wrong because
   it used to list them (CreditorCode 2026-08-17 09:15, DocNo 10:15). */
describe('composeSoToPo', () => {
  const master = () => composeCreatePo({
    po_number: 'HC-PO-1', po_date: '2026-08-10', creditor_code: '400-H004',
    creditor_name: 'Supplier Sdn Bhd', agent: null, ref: 'R', notes: 'N',
    purchase_location: 'KL',
  }, [line({ unit_price_sen: 5000, location: 'KL' })], opts);

  test('every master field survives the transfer, and none is re-listed by hand', () => {
    const m = master();
    const t = composeSoToPo(m, [4242], m.Details);
    for (const key of Object.keys(m)) {
      if (key === 'Details') continue;   // replaced by the DtlKey override shape
      expect(t[key as keyof typeof t], `${key} on the transfer`).toEqual(m[key as keyof typeof m]);
    }
    /* The five that were still missing after the two one-field patches, named
       so a regression says which one came back. */
    expect(t.DocDate).toBe('2026-08-10');
    expect(t.Agent).toBe(AC_PURCHASE_AGENT);
    expect(t.Ref).toBe('R');
    expect(t.Description).toBe('N');
    expect(t.UDF).toEqual({});
    expect(t.PurchaseLocation).toBe('KL');
  });

  test('the Details become the DtlKey override shape and carry no create-only key', () => {
    const m = master();
    const t = composeSoToPo(m, [4242], m.Details);
    expect(t.DtlKeys).toEqual([4242]);
    expect(t.Details).toHaveLength(1);
    expect(t.Details[0].DtlKey).toBe(4242);
    expect(t.Details[0].UnitPrice, 'the supplier COST, over the customer price the transfer brought across').toBe(50);
    /* ItemCode/Description/Desc2 belong to a CREATE. Phase two of SoToPo reads
       four keys and would drop these silently (AcSyncService.cs:2407-2410). */
    for (const k of ['ItemCode', 'Description', 'Desc2']) {
      expect(t.Details[0]).not.toHaveProperty(k);
    }
  });

  test('keys and cost lines that do not line up are REFUSED, not zipped short', () => {
    /* They are matched BY POSITION, and they are built by different code from
       different rows — poTransferShape counts ERP purchase-order lines,
       composeDetails collapses a sofa build into one AutoCount line (D9). Zipped
       short, the tail lines keep the CUSTOMER's price and the purchase order
       pays the wrong number while looking saved. */
    const m = master();
    expect(() => composeSoToPo(m, [4242, 4243], m.Details)).toThrow(AcSoToPoAlignmentError);
    let msg = '';
    try { composeSoToPo(m, [4242, 4243], m.Details); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('HC-PO-1');
    expect(msg, 'the two counts, so the reader knows which side is short').toContain('2 source line(s)');
    expect(msg).toContain('1 cost line(s)');
  });
});

describe('composeCreatePo', () => {
  const po = (over: Partial<ErpPoHeader> = {}) => composeCreatePo({
    po_number: 'HC-PO-1', po_date: '2026-08-10', creditor_code: '400-H004',
    creditor_name: 'Supplier Sdn Bhd', agent: null, ref: 'R', notes: 'N',
    purchase_location: null, ...over,
  }, [line({ unit_price_sen: 5000, location: 'KL' })], opts);

  test('carries the creditor and the lines', () => {
    const p = po();
    expect(p.DocNo).toBe('HC-PO-1');
    expect(p.Details[0].Location).toBe('KL');
    expect(p.CreditorCode).toBe('400-H004');
    expect(p.Description).toBe('N');
    expect(p.Details[0].UnitPrice).toBe(50);
    expect(p.Details[0].ItemCode).toBe('AC-CODE-1');
  });

  /* FK_PO_PurchaseAgent, AcSyncService.cs:552-560. `scm.purchase_orders` has no
     agent column, so readPoHeader sent null for all 60 unpushed purchase orders
     (measured 2026-08-14) — and `CreatePo` assigns po.Agent unconditionally
     while `Str` turns both an absent key and a present-null into "". Omitting
     the key would not have helped; a constant the book holds does. */
  test('every PO names a purchase agent, because "" is FK_PO_PurchaseAgent', () => {
    expect(po().Agent).toBe(AC_PURCHASE_AGENT);
    expect(po({ agent: null }).Agent).toBe('OTHERS');
    expect(po({ agent: '   ' }).Agent).toBe('OTHERS');
  });

  test('a PO that DOES carry an agent keeps it, so the constant is only the floor', () => {
    expect(po({ agent: 'KINGSLEY' }).Agent).toBe('KINGSLEY');
  });

  /* CreditorCode is assigned DIRECTLY by CreatePo — not even wrapped in Set —
     so a supplier with no code sends "" into FK_PO_Creditor and loses the whole
     document. mastersOf opens a creditor only for a non-empty code, so the
     empty case was the one nothing covered. */
  test('a supplier with no code REFUSES the PO rather than failing FK_PO_Creditor', () => {
    for (const blank of [null, '', '  ']) {
      let err: unknown;
      try { po({ creditor_code: blank }); } catch (e) { err = e; }
      expect(err, String(blank)).toBeInstanceOf(MissingCreditorError);
      expect((err as Error).message).toContain('FK_PO_Creditor');
      expect((err as Error).message).toContain('HC-PO-1');
    }
  });
});

/* ── THE FIELD-ALIGNMENT AUDIT, 2026-08-14 ───────────────────────────────────
   One bug class in eight places: a value the ERP holds in one column, the
   composer reads from another, and null is the fatal value in every direction.
   Each test below is one finding, and each number in a comment came from
   `check-autocount-field-alignment.mjs` run against production that day. */

describe('VENUE — the largest silent loss (finding 5)', () => {
  /* 112 of 115 unpushed sales orders carry a venue VENUE_MAP turned into null,
     and `udf()` drops a null: no error, no outbox row, no log line. Venue is
     deliberately free text — "every roadshow hall is a one-off" (mig 0229) —
     so a 7-entry map was never going to cover it. */
  test('a venue the map has never heard of REACHES the book instead of vanishing', () => {
    const p = createSo({ ...header, venue: '2990s PJ' }, [line()], SALESPERSON, opts);
    expect(p.UDF.VENUE).toBe('2990s PJ');
  });

  test("a venue the map DOES know still goes out in the book's spelling", () => {
    expect(createSo(header, [line()], SALESPERSON, opts).UDF.VENUE)
      .toBe('KSL CITY MALL JOHOR SOLO');
  });

  test('no venue is still nothing to send', () => {
    expect(createSo({ ...header, venue: null }, [line()], SALESPERSON, opts).UDF.VENUE)
      .toBeUndefined();
  });
});

describe('BRANDING — the header column is empty on every ERP-created order (finding 6)', () => {
  /* No client sends `body.branding` and the SO form has never had the field, so
     the header column is NULL on all 115 unpushed orders. The value the
     business has is on the LINES, snapshotted from the catalog at line
     creation, and the detail page has been showing it as first_item_branding. */
  test('a blank header takes the brand off the lines', () => {
    const p = createSo({ ...header, branding: null }, [
      line({ branding: null }),
      line({ item_code: 'SKU-2', branding: 'DUNLOPILLO' }),
    ], SALESPERSON, opts);
    expect(p.UDF.BRANDING).toBe('DUNLOPILLO');
  });

  test('the header still wins when it has one', () => {
    expect(createSo(header, [line({ branding: 'ZANOTTI' })], SALESPERSON, opts).UDF.BRANDING)
      .toBe('AKEMI');
  });

  /* CARRESS and DUNLOP are real brands in the live book's own history that the
     map was never told about, so they were ADDED to it — the thing a spelling
     map is for. They are not passed through; see the next test for why. */
  test('the two brands the book holds and the map did not are now mapped', () => {
    expect(createSo({ ...header, branding: 'CARRESS' }, [line()], SALESPERSON, opts).UDF.BRANDING)
      .toBe('CARRESS');
    expect(createSo({ ...header, branding: 'dunlop' }, [line()], SALESPERSON, opts).UDF.BRANDING)
      .toBe('DUNLOP');
  });

  /* BRANDING PASSES THROUGH SINCE 2026-08-15, like the other three maps.
     It was the one allow-list, on the strength of a field-alignment run that
     reported a pass-through would open `2990s Sofa` (44 orders), `Accessories`
     (8), `2990s Mattress` (8), `2990` (3) — all of them COMPANY 2's, counted
     only because that report had no company predicate (#2201). The write-back
     runs for company 1, where the entire pass-through is `BEDFRAME` (1 order)
     and `SERVICE` (0).
     Those two are categories rather than brands and the owner was told so
     before ruling: "bedframe和service的branding也开进去autocount". His book. */
  test('a value the map does not know is PASSED THROUGH, so /ensure-masters opens it', () => {
    for (const own of ['BEDFRAME', 'SERVICE']) {
      const p = createSo({ ...header, branding: own }, [line()], SALESPERSON, opts);
      expect(p.UDF.BRANDING, own).toBe(own);
    }
  });

  test('a mapped value is still corrected to the book spelling, not passed through', () => {
    /* Pass-through must not become "send whatever the ERP holds": where the map
       knows the book's own spelling, that still wins. */
    const [erp, book] = Object.entries(BRANDING_MAP)[0];
    expect(book).toBeTruthy();
    const p = createSo({ ...header, branding: erp }, [line()], SALESPERSON, opts);
    expect(p.UDF.BRANDING).toBe(book);
  });

  /* A CANCELLED line is not on the document AutoCount is being sent, so its
     brand must not name the document either. */
  test('a cancelled line does not decide the brand', () => {
    const p = createSo({ ...header, branding: null }, [
      line({ branding: 'MYLATEX', cancelled: true }),
      line({ item_code: 'SKU-2', branding: 'ERGOTEX' }),
    ], SALESPERSON, opts);
    expect(p.UDF.BRANDING).toBe('ERGOTEX');
  });

  test('neither header nor lines is nothing to send, not an empty option', () => {
    const p = createSo({ ...header, branding: null }, [line({ branding: null })], SALESPERSON, opts);
    expect(p.UDF.BRANDING).toBeUndefined();
  });

  /* so-display-branding.ts falls back to the pseudo-brand "BEDFRAME" for a
     bedframe-only order. That is a CATEGORY, and passing it through here would
     open a category as an option in the account book's brand list. */
  test('soBranding reads line text only — no catalog rule, no BEDFRAME pseudo-brand', () => {
    expect(soBranding(null, [line({ item_group: 'BEDFRAME', branding: null })])).toBeNull();
  });
});

describe('ToPONo — the customer reference now lives only in customer_so_no', () => {
  /* po_doc_no and customer_po held it once; both were 0%-filled and DROPPED from
     scm.mfg_sales_orders by migration 0310. The operator's reference lands in
     customer_so_no, which is the only column SO_HEADER_COLS still selects. */
  test('reads the customer reference from customer_so_no', () => {
    const at = (over: Partial<ErpSoHeader>) =>
      createSo({ ...header, ...over }, [line()], SALESPERSON, opts).UDF.ToPONo;
    expect(at({ customer_so_no: 'CSO-1' })).toBe('CSO-1');
    expect(at({ customer_so_no: null })).toBeUndefined();
  });

  test('soCustomerRef resolves to customer_so_no', () => {
    expect(soCustomerRef({ customer_so_no: 'CSO' })).toBe('CSO');
    expect(soCustomerRef({ customer_so_no: null })).toBeNull();
  });

  /* `ref` goes out as the document's Ref. Sending it here too would put the
     same string in two AutoCount fields. */
  test('the document Ref is NOT reused as the customer reference', () => {
    const p = createSo(
      { ...header, customer_so_no: null, ref: 'REF' },
      [line()], SALESPERSON, opts,
    );
    expect(p.Ref).toBe('REF');
    expect(p.UDF.ToPONo).toBeUndefined();
  });
});

describe('InvAddr3 / InvAddr4 — the town, postcode and state never arrived (finding 8)', () => {
  /* 94 of 115 unpushed orders have address3 AND address4 blank while city /
     postcode / customer_state are populated, and InvAddr1..4 are assigned
     DIRECTLY (not through Set), so the two blanks were written every time — on
     the address a delivery is printed from. */
  test('an ERP-created order packs postcode + city, then the state', () => {
    const p = createSo({
      ...header, city: 'Seri Kembangan', postcode: '43300', customer_state: 'Selangor',
    }, [line()], SALESPERSON, opts);
    expect(p.InvAddr1).toBe('A1');
    expect(p.InvAddr2).toBe('A2');
    expect(p.InvAddr3).toBe('43300 Seri Kembangan');
    expect(p.InvAddr4).toBe('Selangor');
  });

  /* Only the cutover import ever wrote address3 / address4, and that text is
     AutoCount's own. */
  test('a cutover-imported order keeps its own address3 / address4', () => {
    const p = createSo({
      ...header, address3: 'AC LINE 3', address4: 'AC LINE 4',
      city: 'Seri Kembangan', postcode: '43300', customer_state: 'Selangor',
    }, [line()], SALESPERSON, opts);
    expect(p.InvAddr3).toBe('AC LINE 3');
    expect(p.InvAddr4).toBe('AC LINE 4');
  });

  test('a half-filled address packs what there is', () => {
    expect(soInvoiceAddress({
      address1: null, address2: null, address3: null, address4: null,
      city: 'Ipoh', postcode: null, customer_state: null,
    })).toEqual({ InvAddr1: null, InvAddr2: null, InvAddr3: 'Ipoh', InvAddr4: null });
    expect(soInvoiceAddress({
      address1: null, address2: null, address3: null, address4: null,
      city: null, postcode: '30000', customer_state: 'Perak',
    })).toEqual({ InvAddr1: null, InvAddr2: null, InvAddr3: '30000', InvAddr4: 'Perak' });
  });
});

describe('SalesLocation — FK_SO_SalesLocation, and a blank is fatal too (finding 3)', () => {
  /* 21 of 115 unpushed orders have a BLANK sales_location (deriveSalesLocation-
     FromState returns null for an order with no customer state) and none carries
     a value LOCATION_MAP fails to know — so the pass-through alone would have
     fixed nothing. The lines are the answer, and they open no master the
     document was not already opening off the line itself. */
  test('a blank document location falls back to the lines', () => {
    const p = createSo({ ...header, sales_location: null }, [
      line({ location: 'PG WAREHOUSE' }),
    ], SALESPERSON, opts);
    expect(p.SalesLocation).toBe('PG');
    expect(p.Details[0].Location).toBe('PG');
  });

  test('an unmapped document location is KEPT rather than turned into ""', () => {
    const p = createSo({ ...header, sales_location: 'SUNWAY' }, [line()], SALESPERSON, opts);
    expect(p.SalesLocation).toBe('SUNWAY');
  });

  /* Unreachable for any document that has a line, because requireLocation has
     already refused a line with no location. What is left is an order with no
     live line at all, which cannot be written by any route. */
  test('no location anywhere REFUSES, naming FK_SO_SalesLocation', () => {
    let err: unknown;
    try {
      createSo({ ...header, sales_location: null }, [], SALESPERSON, opts);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MissingSalesLocationError);
    expect((err as Error).message).toContain('FK_SO_SalesLocation');
    expect((err as Error).message).toContain('HC-SO-1');
  });
});

/* The DtlKeys a create/convert reports back. Anything not completely usable is
   DROPPED rather than coerced — a key guessed off a malformed row would be
   stored as line identity and used to overwrite a live AutoCount line. */
describe('parseCreatedLines', () => {
  test('reads well-formed entries', () => {
    expect(parseCreatedLines([
      { Seq: 0, DtlKey: 11, ItemCode: 'A', Desc2: 'x' },
      { Seq: 1, DtlKey: 12, ItemCode: 'B' },
    ])).toEqual([
      { Seq: 0, DtlKey: 11, ItemCode: 'A', Desc2: 'x' },
      { Seq: 1, DtlKey: 12, ItemCode: 'B', Desc2: null },
    ]);
  });

  test('an absent or non-array lines field is simply no lines, not an error', () => {
    expect(parseCreatedLines(undefined)).toEqual([]);
    expect(parseCreatedLines(null)).toEqual([]);
    expect(parseCreatedLines('nope')).toEqual([]);
  });

  test('an unusable DtlKey is dropped rather than coerced', () => {
    expect(parseCreatedLines([
      { Seq: 0, DtlKey: 'abc', ItemCode: 'A' },
      { Seq: 1, DtlKey: 0, ItemCode: 'B' },
      { Seq: 2, DtlKey: -5, ItemCode: 'C' },
      { Seq: 3, DtlKey: 13, ItemCode: 'D' },
    ])).toEqual([{ Seq: 3, DtlKey: 13, ItemCode: 'D', Desc2: null }]);
  });
});

/* THE FINDING THE OLD SERVICE THREW AWAY. `/ensure-masters` fetched the creditor
   and kept only `!= null`, so a code resolving to the WRONG company looked
   identical to a code resolving to the right one — which is how HC-PO-2608-001
   ended up on 400-H004, HAO HUA FURNITURE in the book, for a purchase order the
   ERP names HOOKKA INDUSTRIES SDN. BHD. An entry missing any of the three
   strings is dropped: a blank `book` would assert something about the account
   book that nobody measured. */
describe('parseAcMismatches', () => {
  test('reads well-formed entries and trims them', () => {
    expect(parseAcMismatches([
      { master: 'creditor:400-H004', erp: ' HOOKKA INDUSTRIES SDN. BHD. ', book: 'HAO HUA FURNITURE' },
    ])).toEqual([
      { master: 'creditor:400-H004', erp: 'HOOKKA INDUSTRIES SDN. BHD.', book: 'HAO HUA FURNITURE' },
    ]);
  });

  test('an absent field is NOT REPORTED, which is not the same as compared and agreed', () => {
    expect(parseAcMismatches(undefined)).toEqual([]);
    expect(parseAcMismatches(null)).toEqual([]);
    expect(parseAcMismatches('nope')).toEqual([]);
  });

  test('an entry missing any of the three strings is dropped, never coerced', () => {
    expect(parseAcMismatches([
      { master: 'creditor:400-A001', erp: 'A', book: '' },
      { master: '', erp: 'B', book: 'C' },
      { master: 'creditor:400-B002', erp: '', book: 'D' },
      { master: 'creditor:400-C002', erp: 7, book: 'E' },
      null,
      { master: 'creditor:400-D001', erp: 'ERP NAME', book: 'BOOK NAME' },
    ])).toEqual([{ master: 'creditor:400-D001', erp: 'ERP NAME', book: 'BOOK NAME' }]);
  });
});

describe('composeEdit', () => {
  test('a known line is addressed by its AutoCount DtlKey so the edit updates it', () => {
    const p = composeEdit('SO', 'SO-000021', { Ref: 'R2' }, [
      line({ linked_ac_dtlkey: 991 }),
      line({ item_code: 'SKU-2', linked_ac_dtlkey: 992 }),
    ], opts);
    expect(p.DocType).toBe('SO');
    expect(p.DocNo).toBe('SO-000021');
    expect(p.Header).toEqual({ Ref: 'R2' });
    expect(p.Lines[0].DtlKey).toBe(991);
    expect(p.Lines[1].DtlKey).toBe(992);
  });

  /* The defect this refusal exists for. AcSyncService's /edit used to fall
     through to AddDetail() for a keyless line, and on 2026-08-11 EVERY line in
     production was keyless (0 of 13,907 SO, 0 of 864 PO) — so an edit appended
     a second copy of every line into the live account book. On a PO those
     copies are permanent: the SDK gives PurchaseOrder no DeleteDetail and no
     line-level Cancelled. */
  test('a keyless line REFUSES the whole edit rather than appending a duplicate', () => {
    expect(() => composeEdit('SO', 'SO-000021', { Ref: 'R2' }, [
      line({ linked_ac_dtlkey: 991 }),
      line({ item_code: 'SKU-2' }),
    ], opts)).toThrow(KeylessLineError);
  });

  test('the refusal names the document and the offending line, because an operator reads it', () => {
    let msg = '';
    try {
      composeEdit('PO', 'PO-2608-004', {}, [line({ item_code: 'SKU-2' })], opts);
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('PO-2608-004');
    expect(msg).toContain('AC-CODE-2');
    expect(msg).toContain('1 of 1');
  });

  test('one keyless line among many still refuses — a partial edit is not offered', () => {
    expect(() => composeEdit('SO', 'SO-9', {}, [
      line({ linked_ac_dtlkey: 1 }),
      line({ item_code: 'B' }),
      line({ item_code: 'C', linked_ac_dtlkey: 3 }),
    ], opts)).toThrow(/2 \(AC-CODE-B\)/);
  });

  /* A garbage key must never be coerced into a number and shipped: DtlKey is
     how AutoCount finds the row to overwrite, so a wrong one edits somebody
     else's line. It is treated as NO key, which now means the edit is refused. */
  test('a non-numeric key is treated as no key, and therefore refused', () => {
    expect(() => composeEdit('SO', 'SO-1', {}, [line({ linked_ac_dtlkey: 'not-a-key' })], opts))
      .toThrow(KeylessLineError);
  });
});

describe('callAcService', () => {
  const env = { AC_SYNC_URL: 'http://ac.local:8900/', AC_SYNC_KEY: 'secret' } as never;

  test('AC_SYNC_URL is config and its absence is reported, not guessed around', () => {
    expect(acServiceConfig({} as never)).toBeNull();
  });

  test('posts to the route for the operation, with the API key header', async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true, docNo: 'SO-000123' }), { status: 200 });
    }) as never;

    const r = await callAcService(env, 'create_so', { DocNo: 'HC-SO-1' }, fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.docNo).toBe('SO-000123');
    expect(seen.url).toBe('http://ac.local:8900/create-so');
    expect((seen.init?.headers as Record<string, string>)['X-API-KEY']).toBe('secret');
  });

  test('an unreachable host is retryable — the AutoCount box reboots', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as never;
    const r = await callAcService(env, 'cancel', {}, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.retryable).toBe(true);
  });

  test('a 4xx is NOT retryable — a bad payload stays bad', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'DocNo required' }), { status: 400 })) as never;
    const r = await callAcService(env, 'create_so', {}, fetchImpl);
    expect(r.retryable).toBe(false);
    expect(r.error).toBe('DocNo required');
  });

  test("a 500 keeps AutoCount's own words and is retried, because the service turns every exception into one", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: 'AutoCount refused to cancel SO SO-1 (already transferred to a downstream document, or already cancelled)' }),
      { status: 500 },
    )) as never;
    const r = await callAcService(env, 'cancel', {}, fetchImpl);
    expect(r.retryable).toBe(true);
    expect(r.error).toContain('already transferred to a downstream document');
  });

  test('a 200 body that says ok:false is a failure, not a success', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'nope' }), { status: 200 })) as never;
    expect((await callAcService(env, 'edit', {}, fetchImpl)).ok).toBe(false);
  });
});

/* A sofa build is ONE AutoCount line standing for several ERP compartment rows.
   Retirement therefore has to be a property of the whole build, and the only
   two honest answers are "all of it" and "refuse" — there is no line in the
   account book that could carry half of it. */
describe('a HALF-cancelled sofa build is refused, never half-retired', () => {
  const SOFA_INDEX = buildAcItemIndex(
    ['AC-SOFA-9028', '9028-1S', 'SOFA', '400-H004'].join('\t'),
  );
  const sofaOpts: ComposeOptions = { itemIndex: SOFA_INDEX };

  const compartment = (code: string, over: Partial<ErpLine> = {}): ErpLine => ({
    item_code: code,
    item_group: 'sofa',
    description: `SOFA 9028 ${code}`,
    description2: '1EL + 1ER (28") / COL: BEIGE',
    qty: 1,
    unit_price_sen: 0,
    variants: { seatHeight: '28', colourLabel: 'BEIGE', specials: [] },
    linked_ac_dtlkey: 8801,
    ...over,
  });

  test('every compartment cancelled retires the one AutoCount line', () => {
    const p = composeEdit('SO', 'SO-000021', {}, [
      compartment('9028-1A(LHF)', { unit_price_sen: 500_000, cancelled: true }),
      compartment('9028-1A(RHF)', { cancelled: true }),
    ], sofaOpts);
    expect(p.Lines).toHaveLength(1);
    expect(p.Lines[0]).toMatchObject({ DtlKey: 8801, Retire: true });
  });

  test('some cancelled and some not is REFUSED — AutoCount has no shape for half a build', () => {
    let err: unknown;
    try {
      composeEdit('SO', 'SO-000021', {}, [
        compartment('9028-1A(LHF)', { unit_price_sen: 500_000, cancelled: true }),
        compartment('9028-1A(RHF)'),
      ], sofaOpts);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SofaCollapseError);
    const msg = (err as Error).message;
    expect(msg).toContain('some compartments');
    expect(msg).toContain('no shape for a partial retirement');
  });

  test('none cancelled is an ordinary keyed edit', () => {
    const p = composeEdit('SO', 'SO-000021', {}, [
      compartment('9028-1A(LHF)', { unit_price_sen: 500_000 }),
      compartment('9028-1A(RHF)'),
    ], sofaOpts);
    expect(p.Lines).toHaveLength(1);
    expect(p.Lines[0]).toMatchObject({ DtlKey: 8801 });
    /* The item is AutoCount's on a line it already holds — see the edit rule in
       composeEdit. The key is how the line is addressed; the item is not resent. */
    expect(Object.prototype.hasOwnProperty.call(p.Lines[0], 'ItemCode')).toBe(false);
    expect((p.Lines[0] as { Retire?: boolean }).Retire).toBeUndefined();
  });
});

/* The live book, 2026-08-11 11:54:59: a create with no Location came back
   FK_SODTL_Location; the same document at 11:57:43 with Location "KL" saved.
   AcSyncService's create applies the key unconditionally and an absent key
   reaches it as "", which is not a row in dbo.Location. So a CREATE must carry
   one and an EDIT must not invent one. */
describe('a stock location is mandatory on a CREATE and untouched on an EDIT', () => {
  const soHeader: ErpSoHeader = { ...header, sales_location: 'PETALING JAYA' };

  test("the line's own warehouse wins, mapped to the code AutoCount knows", () => {
    const p = createSo(soHeader, [line({ location: 'PG WAREHOUSE' })], SALESPERSON, opts);
    expect(p.Details[0].Location).toBe('PG');
  });

  test('a line with no warehouse inherits the document, because an order sells from somewhere', () => {
    const p = createSo(soHeader, [line()], SALESPERSON, opts);
    expect(p.Details[0].Location).toBe('KL');
  });

  test('neither one is REFUSED, naming the line — sending "" would fail FK_SODTL_Location', () => {
    let err: unknown;
    try {
      createSo({ ...header, sales_location: null }, [line()], SALESPERSON, opts);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MissingLocationError);
    expect((err as Error).message).toContain('AC-CODE-1');
    expect((err as Error).message).toContain('FK_SODTL_Location');
  });

  /* THE CLAIM THIS TEST USED TO MAKE WAS WRONG, and it is the second half of
     what the owner reported on 2026-08-19 (「它的 Purchase Location 也不对」). It
     read "a PO has no document location to inherit" — but the ERP's purchase
     order carries `purchase_location_id` (PR #77) and /submit refuses one that
     has neither it nor a warehouse on every line
     (mfg-purchase-orders.ts:4019), and AutoCount's purchase header carries
     `PurchaseLocation`, assigned by `CreatePo` for /create-po
     (AcSyncService.cs:934-935) and by `PurchaseHeader` for /so-to-po
     (:2456-2457). So there IS something to inherit, and the ERP's own
     precedence is line-then-header (outstanding-po-lines.ts:382).
     What survives is the genuine refusal: neither side named a warehouse. */
  test('a warehouse-less line on a warehouse-less PO is still refused — nobody said where the goods go', () => {
    expect(() => composeCreatePo({
      po_number: 'HC-PO-1', po_date: null, creditor_code: '400-H004',
      creditor_name: 'S', agent: null, ref: null, notes: null, purchase_location: null,
    }, [line()], opts)).toThrow(MissingLocationError);
  });

  test('a warehouse-less line INHERITS the PO header\'s purchase location', () => {
    const p = composeCreatePo({
      po_number: 'HC-PO-1', po_date: null, creditor_code: '400-H004',
      creditor_name: 'S', agent: null, ref: null, notes: null, purchase_location: 'KL',
    }, [line()], opts);
    expect(p.PurchaseLocation, 'the header field AutoCount defaults when we send none').toBe('KL');
    expect(p.Details[0].Location, 'the ERP default fans out to the line').toBe('KL');
  });

  test('a line\'s OWN warehouse beats the header\'s, which is the ERP\'s own precedence', () => {
    const p = composeCreatePo({
      po_number: 'HC-PO-1', po_date: null, creditor_code: '400-H004',
      creditor_name: 'S', agent: null, ref: null, notes: null, purchase_location: 'KL',
    }, [line({ location: 'PG' })], opts);
    expect(p.PurchaseLocation).toBe('KL');
    expect(p.Details[0].Location).toBe('PG');
  });

  test('a PO with no purchase location OMITS the key rather than sending a blank', () => {
    /* The service's guard on this key — in both copies — is ContainsKey AND
       non-empty (AcSyncService.cs:934 and :2456) because "" is its own foreign
       key error. A
       present-null would reach it through Str() as exactly that blank. */
    const p = composeCreatePo({
      po_number: 'HC-PO-1', po_date: null, creditor_code: '400-H004',
      creditor_name: 'S', agent: null, ref: null, notes: null, purchase_location: null,
    }, [line({ location: 'KL' })], opts);
    expect(p).not.toHaveProperty('PurchaseLocation');
  });

  test('an EDIT omits the key entirely rather than blanking the book, and never refuses', () => {
    const p = composeEdit('SO', 'SO-000021', {}, [line({ linked_ac_dtlkey: 991 })], opts);
    expect(p.Lines[0]).not.toHaveProperty('Location');
  });
});

/* Owner 2026-08-13. Each of four sofa models was opened in AutoCount as TWO
   brand items, which a sales order can never choose between — it does not know
   the brand until purchasing does. The answer is one canonical item per model,
   named as the ERP names it. That is right for a NEW order and WRONG for the
   194 real lines the book already holds under a brand item: an edit that sent
   the canonical code would move them, silently, in a licensed ledger. */
describe('an edit never rewrites the item on a line AutoCount already owns', () => {
  /* The real cutover map, not the synthetic TEST_INDEX — the whole behaviour
     turns on 9028-1S being genuinely ambiguous there. */
  const real = {};
  const compartment = (comp: string, over: Partial<ErpLine> = {}): ErpLine => ({
    item_code: `9028-${comp}`,
    description: `SOFA 9028 ${comp}`,
    description2: '1A(LHF) + 2A(RHF) (28")',
    qty: 1,
    unit_price_sen: 0,
    ...over,
  });

  test('a policy-chosen ItemCode is OMITTED, so the book keeps its own', () => {
    const p = composeEdit('SO', 'SO-000021', { Ref: 'R2' }, [
      compartment('1A(LHF)', { linked_ac_dtlkey: 991, unit_price_sen: 399_000 }),
      compartment('2A(RHF)', { linked_ac_dtlkey: 991 }),
    ], real);
    /* D9 folds the build into one line, addressed by its key. */
    expect(p.Lines).toHaveLength(1);
    expect(p.Lines[0].DtlKey).toBe(991);
    expect(Object.prototype.hasOwnProperty.call(p.Lines[0], 'ItemCode')).toBe(false);
  });

  test('a CREATE carries it — one line per compartment, each its own code', () => {
    const { details } = composeDetails([
      compartment('1A(LHF)', { unit_price_sen: 399_000 }),
      compartment('2A(RHF)'),
    ], real);
    expect(details).toHaveLength(2);
    expect(details.map((d) => d.ItemCode)).toEqual(['9028-1A(LHF)', '9028-2A(RHF)']);
  });

  test('an ordinary line the book owns keeps its item too — not just the sofas', () => {
    const p = composeEdit('SO', 'SO-000021', {}, [
      { item_code: 'AKEMI APEX MATT (SP)', description: 'M', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 55 },
    ], real);
    expect(p.Lines[0].DtlKey).toBe(55);
    expect(Object.prototype.hasOwnProperty.call(p.Lines[0], 'ItemCode')).toBe(false);
  });

  test('a swap still propagates, because a swap is a DELETE plus an ADD', () => {
    /* The removed row arrives in `retired` and is zeroed; the added row has no
       DtlKey, so it keeps its ItemCode and is appended. This is the path that
       makes dropping the in-place item safe. */
    const p = composeEdit('SO', 'SO-000021', {}, [
      { id: 'new-1', item_code: 'AKEMI ARISTOI MATT (SP)', description: 'M2', qty: 1, unit_price_sen: 100 },
    ], { ...real, newLineIds: new Set(['new-1']) }, [{ DtlKey: 55, ItemCode: 'AK-APEX MATT (SP)' }]);
    const added = p.Lines.find((l) => l.DtlKey == null);
    expect(added?.ItemCode).toBe('AK-ARISTOI MATT (SP)');
    expect((added as { IsNewLine?: true }).IsNewLine).toBe(true);
    const gone = p.Lines.find((l) => l.DtlKey === 55);
    expect((gone as { Retire?: true }).Retire).toBe(true);
  });
});
