// ----------------------------------------------------------------------------
// Shared LEFT-column ("party") builders for every doc PDF (SO, SI, DO, DR, PO,
// PI, GRN, PR). ONE canonical row order per direction — bill-to (customer we
// bill / sell to), ship-to (party we deliver to), supplier (their side) — so
// every document reads the same rows in the same order when the data is there.
// Blank rows fall out naturally: drawInfoColumns skips a row whose value is
// empty (pdf-common.ts drawInfoColumns), so a PDF that has no e-mail today is
// byte-identical to before this refactor.
//
// The helpers return the { title, rows } shape drawInfoColumns's LEFT column
// takes, so callers slot them directly in without touching positioning or
// pixel-sensitive layout in pdf-common. The optional `title` override keeps
// per-PDF headings unchanged ("BILL TO" / "DELIVER TO" / "FROM CUSTOMER" /
// "SUPPLIER") — an owner-facing label change is not part of this refactor.
//
// Callers pre-format phone numbers (via shared formatPhone) and pre-compose
// addresses (comma-joined lines) — the row-value handling here stays a plain
// string pass-through so drawInfoColumns's wrap width is the only source of
// truth for that math.
// ----------------------------------------------------------------------------

/* The exact row shape drawInfoColumns takes for its left column, mirrored here
   so a caller can spread the helper's return straight into the drawInfoColumns
   call site without an extra adaptor. */
export type PartyBlock = {
  title: string;
  rows: Array<[string, string | null | undefined]>;
};

/* Party we're billing / selling TO — the "customer receiving" side (SO, SI,
   and DR's "FROM CUSTOMER" reuse this shape per the audit). All fields
   optional so a PDF with a thin record still renders; drawInfoColumns drops
   any row whose value trims to empty. `extras` slot in BEFORE Note so a
   per-doc extra (SO's Family contact, DR's return Reason) sits with the
   party lines, not after the tail comment. */
export type BillToInput = {
  name?: string | null;
  code?: string | null;
  /** Pre-composed address (typically the caller's own address1/address2/
      postcode-city-state comma-join). One field, one row — the helper does
      not compose; that varies per doc's data shape. */
  address?: string | null;
  /** Pre-formatted phone number (caller pipes header.phone through the
      shared formatPhone so every doc renders the same canonical shape). */
  phone?: string | null;
  email?: string | null;
  note?: string | null;
  extras?: Array<[string, string | null | undefined]>;
};

/** Default title matches the SO / SI convention; overridable for DR's
 *  "FROM CUSTOMER" heading (same row shape, a returning customer is still
 *  the party being billed on refund). */
export function billToBlock(input: BillToInput, opts?: { title?: string }): PartyBlock {
  return {
    title: opts?.title ?? 'BILL TO',
    rows: [
      ['Company', input.name ?? null],
      ['Code', input.code ?? null],
      ['Address', input.address ?? null],
      ['Tel', input.phone ?? null],
      ['Email', input.email ?? null],
      ...(input.extras ?? []),
      ['Note', input.note ?? null],
    ],
  };
}

/* Party we're SHIPPING TO — the delivery-address side (DO's "DELIVER TO";
   also fits future SHIP TO callers if the SO or PO ever prints a distinct
   ship-to alongside its bill-to). Contact = the receiver's contact person
   (someone the driver rings on arrival), distinct from the supplier-side
   "Attn". */
export type ShipToInput = {
  name?: string | null;
  code?: string | null;
  address?: string | null;
  phone?: string | null;
  contact?: string | null;
  note?: string | null;
  extras?: Array<[string, string | null | undefined]>;
};

export function shipToBlock(input: ShipToInput, opts?: { title?: string }): PartyBlock {
  return {
    title: opts?.title ?? 'SHIP TO',
    rows: [
      ['Company', input.name ?? null],
      ['Code', input.code ?? null],
      ['Address', input.address ?? null],
      ['Tel', input.phone ?? null],
      ['Contact', input.contact ?? null],
      ...(input.extras ?? []),
      ['Note', input.note ?? null],
    ],
  };
}

/* Party that IS our supplier (PO, PI, GRN, PR). Same canonical order across
   all four purchasing docs. `attention` is the person we address the PO to
   (their AR / dispatch clerk); `paymentTerms` is the negotiated credit
   window ("NET 30") — printing it in the supplier block keeps every
   purchasing doc self-contained (a supplier reading a PI knows the terms
   without the PO in hand). `fax` prints separately so it sits next to Tel
   as a contact channel, not lost in a free-text address. */
export type SupplierInput = {
  name?: string | null;
  code?: string | null;
  address?: string | null;
  phone?: string | null;
  fax?: string | null;
  email?: string | null;
  attention?: string | null;
  paymentTerms?: string | null;
  note?: string | null;
  extras?: Array<[string, string | null | undefined]>;
};

export function supplierBlock(input: SupplierInput, opts?: { title?: string }): PartyBlock {
  return {
    title: opts?.title ?? 'SUPPLIER',
    rows: [
      ['Company', input.name ?? null],
      ['Code', input.code ?? null],
      ['Address', input.address ?? null],
      ['Tel', input.phone ?? null],
      ['Fax', input.fax ?? null],
      ['Email', input.email ?? null],
      ['Attn', input.attention ?? null],
      ['Terms', input.paymentTerms ?? null],
      ...(input.extras ?? []),
      ['Note', input.note ?? null],
    ],
  };
}
