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
  composeDetails,
  composeEdit,
  KeylessLineError,
  MissingAgentError,
  MissingLocationError,
  SofaCollapseError,
  resolveAcAgent,
  parseCreatedLines,
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
  phone: '0123', ref: 'REF', po_doc_no: 'CUST-PO-7', customer_po: null, customer_so_no: null,
};

const line = (over: Partial<ErpLine> = {}): ErpLine => ({
  item_code: 'SKU-1', description: 'Mattress', qty: 2, unit_price_centi: 199_900, ...over,
});

/* The name behind mfg_sales_orders.salesperson_id, which composeCreateSo now
   REQUIRES. `header` above carries a mappable `agent`, so these cases are the
   ones where the fallback does not fire; the fallback itself, and the refusal
   when neither source answers, have their own describe block below. */
const SALESPERSON: string | null = null;

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
    expect(bookSpellingOrOwn('  AEON  BIG   KEPONG ', VENUE_MAP)).toBe('AEON BIG KEPONG');
  });

  test('null still means null — but ONLY when the ERP has no value at all', () => {
    expect(bookSpellingOrOwn(null, VENUE_MAP)).toBeNull();
    expect(bookSpellingOrOwn('   ', VENUE_MAP)).toBeNull();
  });
});

describe('composeCreateSo', () => {
  const payload = composeCreateSo(header, [line()], SALESPERSON, opts);

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
    const p = composeCreateSo(
      { ...header, branding: null, venue: null, po_doc_no: null, customer_po: null, customer_so_no: null },
      [line()], SALESPERSON, opts,
    );
    expect(p.UDF).toEqual({});
  });

  /* Owner 2026-08-12: the SO's Processing date (账目日期) must reach AutoCount.
     Its storage is processing_date — one column (0189) under one name (0284),
     so this label has exactly one source. */
  test('the Processing date goes out as the PDate UDF', () => {
    const p = composeCreateSo({ ...header, processing_date: '2026-09-01' }, [line()], SALESPERSON, opts);
    expect(p.UDF.PDate).toBe('2026-09-01');
  });

  test('a Processing date that arrives as a timestamp is trimmed to the date', () => {
    const p = composeCreateSo({ ...header, processing_date: '2026-09-01T00:00:00' }, [line()], SALESPERSON, opts);
    expect(p.UDF.PDate).toBe('2026-09-01');
  });

  test('no Processing date sends no PDate at all', () => {
    expect(composeCreateSo(header, [line()], SALESPERSON, opts).UDF.PDate).toBeUndefined();
    expect(composeCreateSo({ ...header, processing_date: null }, [line()], SALESPERSON, opts).UDF.PDate)
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
    const p = composeCreateSo(noAgent, [line()], 'Chang Shi Ting', opts);
    expect(p.Agent).toBe('Chang Shi Ting');
  });

  /* AGENT_MAP is a record of how the book already spells the reps it has, not
     an allow-list of who may sell. A name it knows goes out in the book's
     spelling so the fallback cannot open a second agent beside an existing
     one. */
  test('a salesperson the book already spells goes out in ITS spelling', () => {
    expect(composeCreateSo(noAgent, [line()], 'shi ting', opts).Agent)
      .toBe('Chang Shi Ting');
    expect(composeCreateSo(noAgent, [line()], 'zack', opts).Agent).toBe('Zack');
  });

  /* D10's rule, applied to people (owner 2026-08-13): an unmapped value is no
     longer a refusal, it is opened. Whatever string is sent is exactly what
     /ensure-masters creates the agent under, so a rep hired since the map was
     built is writable instead of blocked. */
  test('a salesperson the map has never heard of is sent as themselves', () => {
    expect(composeCreateSo(noAgent, [line()], 'Nurul Hidayah', opts).Agent)
      .toBe('Nurul Hidayah');
  });

  test('an agent the ERP does hold still wins over the salesperson link', () => {
    expect(composeCreateSo(header, [line()], 'Nurul Hidayah', opts).Agent)
      .toBe('TAN KAR JIUN');
  });

  /* THE BOTH-EMPTY CASE. Sending "" is what produced the go-live failure, and
     the document cannot land either way — the foreign key is deterministic. So
     the create is REFUSED, which costs nothing that sending would have gained
     and turns a 500 in the AutoCount host's log into a `skipped` outbox row an
     operator can read and a re-queue can retry. */
  test('neither source REFUSES the create, naming the remedy', () => {
    let err: unknown;
    try { composeCreateSo(noAgent, [line()], null, opts); } catch (e) { err = e; }
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

describe('Description 2 — where a variant goes, because AutoCount has no variant fields', () => {
  test('sofa variants collapse into one blob', () => {
    expect(composeDescription2(line({
      variants: { fabricColor: 'Beige', fabricLabel: 'Linen', seatHeight: '45', legHeight: '10' },
    }))).toBe('Col: Beige / Fabric: Linen / Seat: 45 / Leg: 10');
  });

  test('an explicit description2 wins over the variants', () => {
    expect(composeDescription2(line({ description2: 'KING 6x7', variants: { fabricColor: 'Beige' } })))
      .toBe('KING 6x7');
  });

  test('a line with neither carries no Desc2 rather than an empty string', () => {
    expect(composeDescription2(line())).toBeNull();
  });
});

describe('ItemCode resolution (D10) — no silent fallback to material_code', () => {
  test('a mapped code is replaced by its AutoCount ItemCode', () => {
    expect(composeCreateSo(header, [line()], SALESPERSON, opts).Details[0].ItemCode).toBe('AC-CODE-1');
  });

  /* THE DEFECT THIS REPLACED, and the assertion that still guards it. The
     composer once ran with identityResolver and `resolve(...).acItemCode ??
     l.item_code`, so a MAPPED line could silently go out under its ERP code.
     That must never happen: if the book knows this item, we send the book's
     name for it. */
  test('a mapped code is NEVER sent as itself', () => {
    const d = composeCreateSo(header, [line()], SALESPERSON, opts).Details[0];
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
    const d = composeCreateSo(header, [line({ item_code: 'SKU-NOT-IN-THE-BOOK' })], SALESPERSON, opts).Details[0];
    expect(d.ItemCode).toBe('SKU-NOT-IN-THE-BOOK');
  });

  test('a document mixing mapped and unmapped lines ships whole, each line its own answer', () => {
    const p = composeCreateSo(header, [
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
      composeCreateSo(header, [line({ item_code: '' }), line({ item_code: '   ' })], SALESPERSON, opts);
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('2 line(s)');
  });
});

describe('composeCreatePo', () => {
  const po = (over: Partial<ErpPoHeader> = {}) => composeCreatePo({
    po_number: 'HC-PO-1', po_date: '2026-08-10', creditor_code: '400-H004',
    creditor_name: 'Supplier Sdn Bhd', agent: null, ref: 'R', notes: 'N', ...over,
  }, [line({ unit_price_centi: 5000, location: 'KL' })], opts);

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
    const p = composeCreateSo({ ...header, venue: '2990s PJ' }, [line()], SALESPERSON, opts);
    expect(p.UDF.VENUE).toBe('2990s PJ');
  });

  test("a venue the map DOES know still goes out in the book's spelling", () => {
    expect(composeCreateSo(header, [line()], SALESPERSON, opts).UDF.VENUE)
      .toBe('KSL CITY MALL JOHOR SOLO');
  });

  test('no venue is still nothing to send', () => {
    expect(composeCreateSo({ ...header, venue: null }, [line()], SALESPERSON, opts).UDF.VENUE)
      .toBeUndefined();
  });
});

describe('BRANDING — the header column is empty on every ERP-created order (finding 6)', () => {
  /* No client sends `body.branding` and the SO form has never had the field, so
     the header column is NULL on all 115 unpushed orders. The value the
     business has is on the LINES, snapshotted from the catalog at line
     creation, and the detail page has been showing it as first_item_branding. */
  test('a blank header takes the brand off the lines', () => {
    const p = composeCreateSo({ ...header, branding: null }, [
      line({ branding: null }),
      line({ item_code: 'SKU-2', branding: 'DUNLOPILLO' }),
    ], SALESPERSON, opts);
    expect(p.UDF.BRANDING).toBe('DUNLOPILLO');
  });

  test('the header still wins when it has one', () => {
    expect(composeCreateSo(header, [line({ branding: 'ZANOTTI' })], SALESPERSON, opts).UDF.BRANDING)
      .toBe('AKEMI');
  });

  test('a brand the map has never heard of reaches the book (CARRESS, DUNLOP)', () => {
    expect(composeCreateSo({ ...header, branding: 'CARRESS' }, [line()], SALESPERSON, opts).UDF.BRANDING)
      .toBe('CARRESS');
  });

  /* A CANCELLED line is not on the document AutoCount is being sent, so its
     brand must not name the document either. */
  test('a cancelled line does not decide the brand', () => {
    const p = composeCreateSo({ ...header, branding: null }, [
      line({ branding: 'MYLATEX', cancelled: true }),
      line({ item_code: 'SKU-2', branding: 'ERGOTEX' }),
    ], SALESPERSON, opts);
    expect(p.UDF.BRANDING).toBe('ERGOTEX');
  });

  test('neither header nor lines is nothing to send, not an empty option', () => {
    const p = composeCreateSo({ ...header, branding: null }, [line({ branding: null })], SALESPERSON, opts);
    expect(p.UDF.BRANDING).toBeUndefined();
  });

  /* so-display-branding.ts falls back to the pseudo-brand "BEDFRAME" for a
     bedframe-only order. That is a CATEGORY, and passing it through here would
     open a category as an option in the account book's brand list. */
  test('soBranding reads line text only — no catalog rule, no BEDFRAME pseudo-brand', () => {
    expect(soBranding(null, [line({ item_group: 'BEDFRAME', branding: null })])).toBeNull();
  });
});

describe('ToPONo — the composer read a column PR #140 stopped writing (finding 7)', () => {
  /* No Houzs surface writes po_doc_no or customer_po since PR #140 dropped the
     Customer PO card; the operator's reference lands in customer_so_no, which
     SO_HEADER_COLS did not even select. */
  test('falls through to customer_po and then to customer_so_no', () => {
    const at = (over: Partial<ErpSoHeader>) =>
      composeCreateSo({ ...header, po_doc_no: null, ...over }, [line()], SALESPERSON, opts).UDF.ToPONo;
    expect(at({ customer_po: 'CP-1', customer_so_no: 'CSO-1' })).toBe('CP-1');
    expect(at({ customer_po: null, customer_so_no: 'CSO-1' })).toBe('CSO-1');
    expect(at({ customer_po: null, customer_so_no: null })).toBeUndefined();
  });

  test('a cutover-imported order keeps AutoCount"s own text', () => {
    expect(soCustomerRef({ po_doc_no: 'PO-OLD', customer_po: 'CP', customer_so_no: 'CSO' }))
      .toBe('PO-OLD');
  });

  /* `ref` goes out as the document's Ref. Sending it here too would put the
     same string in two AutoCount fields. */
  test('the document Ref is NOT reused as the customer reference', () => {
    const p = composeCreateSo(
      { ...header, po_doc_no: null, customer_po: null, customer_so_no: null, ref: 'REF' },
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
    const p = composeCreateSo({
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
    const p = composeCreateSo({
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
    const p = composeCreateSo({ ...header, sales_location: null }, [
      line({ location: 'PG WAREHOUSE' }),
    ], SALESPERSON, opts);
    expect(p.SalesLocation).toBe('PG');
    expect(p.Details[0].Location).toBe('PG');
  });

  test('an unmapped document location is KEPT rather than turned into ""', () => {
    const p = composeCreateSo({ ...header, sales_location: 'SUNWAY' }, [line()], SALESPERSON, opts);
    expect(p.SalesLocation).toBe('SUNWAY');
  });

  /* Unreachable for any document that has a line, because requireLocation has
     already refused a line with no location. What is left is an order with no
     live line at all, which cannot be written by any route. */
  test('no location anywhere REFUSES, naming FK_SO_SalesLocation', () => {
    let err: unknown;
    try {
      composeCreateSo({ ...header, sales_location: null }, [], SALESPERSON, opts);
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
    unit_price_centi: 0,
    variants: { seatHeight: '28', colourLabel: 'BEIGE', specials: [] },
    linked_ac_dtlkey: 8801,
    ...over,
  });

  test('every compartment cancelled retires the one AutoCount line', () => {
    const p = composeEdit('SO', 'SO-000021', {}, [
      compartment('9028-1A(LHF)', { unit_price_centi: 500_000, cancelled: true }),
      compartment('9028-1A(RHF)', { cancelled: true }),
    ], sofaOpts);
    expect(p.Lines).toHaveLength(1);
    expect(p.Lines[0]).toMatchObject({ DtlKey: 8801, Retire: true });
  });

  test('some cancelled and some not is REFUSED — AutoCount has no shape for half a build', () => {
    let err: unknown;
    try {
      composeEdit('SO', 'SO-000021', {}, [
        compartment('9028-1A(LHF)', { unit_price_centi: 500_000, cancelled: true }),
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
      compartment('9028-1A(LHF)', { unit_price_centi: 500_000 }),
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
    const p = composeCreateSo(soHeader, [line({ location: 'PG WAREHOUSE' })], SALESPERSON, opts);
    expect(p.Details[0].Location).toBe('PG');
  });

  test('a line with no warehouse inherits the document, because an order sells from somewhere', () => {
    const p = composeCreateSo(soHeader, [line()], SALESPERSON, opts);
    expect(p.Details[0].Location).toBe('KL');
  });

  test('neither one is REFUSED, naming the line — sending "" would fail FK_SODTL_Location', () => {
    let err: unknown;
    try {
      composeCreateSo({ ...header, sales_location: null }, [line()], SALESPERSON, opts);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MissingLocationError);
    expect((err as Error).message).toContain('AC-CODE-1');
    expect((err as Error).message).toContain('FK_SODTL_Location');
  });

  test('a PO has no document location to inherit, so a warehouse-less line is refused', () => {
    expect(() => composeCreatePo({
      po_number: 'HC-PO-1', po_date: null, creditor_code: '400-H004',
      creditor_name: 'S', agent: null, ref: null, notes: null,
    }, [line()], opts)).toThrow(MissingLocationError);
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
    unit_price_centi: 0,
    ...over,
  });

  test('a policy-chosen ItemCode is OMITTED, so the book keeps its own', () => {
    const p = composeEdit('SO', 'SO-000021', { Ref: 'R2' }, [
      compartment('1A(LHF)', { linked_ac_dtlkey: 991, unit_price_centi: 399_000 }),
      compartment('2A(RHF)', { linked_ac_dtlkey: 991 }),
    ], real);
    /* D9 folds the build into one line, addressed by its key. */
    expect(p.Lines).toHaveLength(1);
    expect(p.Lines[0].DtlKey).toBe(991);
    expect(Object.prototype.hasOwnProperty.call(p.Lines[0], 'ItemCode')).toBe(false);
  });

  test('a CREATE carries it — one line per compartment, each its own code', () => {
    const { details } = composeDetails([
      compartment('1A(LHF)', { unit_price_centi: 399_000 }),
      compartment('2A(RHF)'),
    ], real);
    expect(details).toHaveLength(2);
    expect(details.map((d) => d.ItemCode)).toEqual(['9028-1A(LHF)', '9028-2A(RHF)']);
  });

  test('an ordinary line the book owns keeps its item too — not just the sofas', () => {
    const p = composeEdit('SO', 'SO-000021', {}, [
      { item_code: 'AKEMI APEX MATT (SP)', description: 'M', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: 55 },
    ], real);
    expect(p.Lines[0].DtlKey).toBe(55);
    expect(Object.prototype.hasOwnProperty.call(p.Lines[0], 'ItemCode')).toBe(false);
  });

  test('a swap still propagates, because a swap is a DELETE plus an ADD', () => {
    /* The removed row arrives in `retired` and is zeroed; the added row has no
       DtlKey, so it keeps its ItemCode and is appended. This is the path that
       makes dropping the in-place item safe. */
    const p = composeEdit('SO', 'SO-000021', {}, [
      { id: 'new-1', item_code: 'AKEMI ARISTOI MATT (SP)', description: 'M2', qty: 1, unit_price_centi: 100 },
    ], { ...real, newLineIds: new Set(['new-1']) }, [{ DtlKey: 55, ItemCode: 'AK-APEX MATT (SP)' }]);
    const added = p.Lines.find((l) => l.DtlKey == null);
    expect(added?.ItemCode).toBe('AK-ARISTOI MATT (SP)');
    expect((added as { IsNewLine?: true }).IsNewLine).toBe(true);
    const gone = p.Lines.find((l) => l.DtlKey === 55);
    expect((gone as { Retire?: true }).Retire).toBe(true);
  });
});
