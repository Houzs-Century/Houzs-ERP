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
  MissingLocationError,
  SofaCollapseError,
  parseCreatedLines,
  composeDescription2,
  ItemCodeError,
  mapOrPassthrough,
  callAcService,
  acServiceConfig,
  acUdfDate,
  AC_DEBTOR_CODE,
  AGENT_MAP,
  LOCATION_MAP,
  type ErpSoHeader,
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
  phone: '0123', ref: 'REF', po_doc_no: 'CUST-PO-7',
};

const line = (over: Partial<ErpLine> = {}): ErpLine => ({
  item_code: 'SKU-1', description: 'Mattress', qty: 2, unit_price_centi: 199_900, ...over,
});

describe('master mapping', () => {
  test('normalises case and spacing before mapping (a salesperson types freely)', () => {
    expect(mapOrPassthrough('kar jiun', AGENT_MAP)).toBe('TAN KAR JIUN');
    expect(mapOrPassthrough('  Mei   Ting ', AGENT_MAP)).toBe('MEI TING');
  });

  test('a value that is already the AutoCount spelling passes through', () => {
    expect(mapOrPassthrough('TAN KAR JIUN', AGENT_MAP)).toBe('TAN KAR JIUN');
    expect(mapOrPassthrough('KL', LOCATION_MAP)).toBe('KL');
  });

  test('an unknown value maps to null rather than being invented', () => {
    expect(mapOrPassthrough('SOMEONE NEW', AGENT_MAP)).toBeNull();
    expect(mapOrPassthrough('', AGENT_MAP)).toBeNull();
    expect(mapOrPassthrough(null, AGENT_MAP)).toBeNull();
  });
});

describe('composeCreateSo', () => {
  const payload = composeCreateSo(header, [line()], opts);

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
    const p = composeCreateSo({ ...header, branding: null, venue: null, po_doc_no: null }, [line()], opts);
    expect(p.UDF).toEqual({});
  });

  /* Owner 2026-08-12: the SO's Processing date (账目日期) must reach AutoCount.
     Its storage is internal_expected_dd — mig 0189 dropped the legacy
     processing_date column so that this label has exactly one source. */
  test('the Processing date goes out as the PDate UDF', () => {
    const p = composeCreateSo({ ...header, internal_expected_dd: '2026-09-01' }, [line()], opts);
    expect(p.UDF.PDate).toBe('2026-09-01');
  });

  test('a Processing date that arrives as a timestamp is trimmed to the date', () => {
    const p = composeCreateSo({ ...header, internal_expected_dd: '2026-09-01T00:00:00' }, [line()], opts);
    expect(p.UDF.PDate).toBe('2026-09-01');
  });

  test('no Processing date sends no PDate at all', () => {
    expect(composeCreateSo(header, [line()], opts).UDF.PDate).toBeUndefined();
    expect(composeCreateSo({ ...header, internal_expected_dd: null }, [line()], opts).UDF.PDate)
      .toBeUndefined();
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
    expect(composeCreateSo(header, [line()], opts).Details[0].ItemCode).toBe('AC-CODE-1');
  });

  /* THE DEFECT THIS REPLACED, and the assertion that still guards it. The
     composer once ran with identityResolver and `resolve(...).acItemCode ??
     l.item_code`, so a MAPPED line could silently go out under its ERP code.
     That must never happen: if the book knows this item, we send the book's
     name for it. */
  test('a mapped code is NEVER sent as itself', () => {
    const d = composeCreateSo(header, [line()], opts).Details[0];
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
    const d = composeCreateSo(header, [line({ item_code: 'SKU-NOT-IN-THE-BOOK' })], opts).Details[0];
    expect(d.ItemCode).toBe('SKU-NOT-IN-THE-BOOK');
  });

  test('a document mixing mapped and unmapped lines ships whole, each line its own answer', () => {
    const p = composeCreateSo(header, [
      line(),
      line({ item_code: 'SKU-NOT-IN-THE-BOOK' }),
      line({ item_code: 'SKU-2' }),
    ], opts);
    expect(p.Details.map((d) => d.ItemCode)).toEqual(['AC-CODE-1', 'SKU-NOT-IN-THE-BOOK', 'AC-CODE-2']);
  });

  /* A blank code is the one input with no answer, so ItemCodeError is still
     reachable and still names every failing line at once — an operator fixing
     one and re-saving into the next is how a divergence outlives everyone who
     remembers it. */
  test('a blank code still refuses, and the refusal names every failing line', () => {
    let msg = '';
    try {
      composeCreateSo(header, [line({ item_code: '' }), line({ item_code: '   ' })], opts);
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('2 line(s)');
  });
});

describe('composeCreatePo', () => {
  test('carries the creditor and the lines', () => {
    const p = composeCreatePo({
      po_number: 'HC-PO-1', po_date: '2026-08-10', creditor_code: '400-H004',
      creditor_name: 'Supplier Sdn Bhd', agent: null, ref: 'R', notes: 'N',
    }, [line({ unit_price_centi: 5000, location: 'KL' })], opts);
    expect(p.DocNo).toBe('HC-PO-1');
    expect(p.Details[0].Location).toBe('KL');
    expect(p.CreditorCode).toBe('400-H004');
    expect(p.Description).toBe('N');
    expect(p.Details[0].UnitPrice).toBe(50);
    expect(p.Details[0].ItemCode).toBe('AC-CODE-1');
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
    const p = composeCreateSo(soHeader, [line({ location: 'PG WAREHOUSE' })], opts);
    expect(p.Details[0].Location).toBe('PG');
  });

  test('a line with no warehouse inherits the document, because an order sells from somewhere', () => {
    const p = composeCreateSo(soHeader, [line()], opts);
    expect(p.Details[0].Location).toBe('KL');
  });

  test('neither one is REFUSED, naming the line — sending "" would fail FK_SODTL_Location', () => {
    let err: unknown;
    try {
      composeCreateSo({ ...header, sales_location: null }, [line()], opts);
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
