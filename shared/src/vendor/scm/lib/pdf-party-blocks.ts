
export type PartyBlock = {
  title: string;
  rows: Array<[string, string | null | undefined]>;
};

export type BillToInput = {
  name?: string | null;
  code?: string | null;
  address?: string | null;
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
