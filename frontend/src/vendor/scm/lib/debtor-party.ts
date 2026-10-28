// ----------------------------------------------------------------------------
// debtor-party — an Other Debtor's own data (owner 2026-09-21: 他要填的资料就和
// supplier 的一样): the identity, contact and structured address the supplier
// master carries, under the same column names, so the printed invoice's
// BILL TO can carry an address. Pure: the form, the page's party card and the
// bill print all read it; the server stores a blank as NULL.
// ----------------------------------------------------------------------------

/** The columns scm.acc_debtors gained (migration 20260921T1600), as the API returns them. */
export type DebtorPartyColumns = {
  tin_number: string | null; business_reg_no: string | null; contact_person: string | null; attention: string | null;
  email: string | null; phone2: string | null; mobile: string | null; whatsapp_number: string | null; fax: string | null;
  address1: string | null; address2: string | null; address3: string | null; address4: string | null;
  city: string | null; postcode: string | null; state: string | null; country: string | null;
};

/** The form's boxes — every one a string; the same keys the registry routes take. */
export type DebtorPartyValues = {
  name: string; phone: string; notes: string;
  tinNumber: string; businessRegNo: string; contactPerson: string; attention: string;
  email: string; phone2: string; mobile: string; whatsappNumber: string; fax: string;
  address1: string; address2: string; address3: string; address4: string;
  city: string; postcode: string; state: string; country: string;
};

export type DebtorPartyField = { key: keyof DebtorPartyValues; label: string; wide?: boolean };

/** The form's groups in the supplier master's order: identity, contact, address, then the note. */
export const DEBTOR_PARTY_GROUPS: ReadonlyArray<{ title: string; fields: ReadonlyArray<DebtorPartyField> }> = [
  { title: 'Identity', fields: [
    { key: 'name', label: 'Name', wide: true },
    { key: 'tinNumber', label: 'TIN Number' },
    { key: 'businessRegNo', label: 'Business Reg No' },
    { key: 'contactPerson', label: 'Contact Person' },
    { key: 'attention', label: 'Attention' },
  ] },
  { title: 'Contact', fields: [
    { key: 'phone', label: 'Phone' },
    { key: 'phone2', label: 'Phone 2' },
    { key: 'mobile', label: 'Mobile' },
    { key: 'whatsappNumber', label: 'WhatsApp' },
    { key: 'fax', label: 'Fax' },
    { key: 'email', label: 'Email' },
  ] },
  { title: 'Address', fields: [
    { key: 'address1', label: 'Address line 1', wide: true },
    { key: 'address2', label: 'Address line 2', wide: true },
    { key: 'address3', label: 'Address line 3', wide: true },
    { key: 'address4', label: 'Address line 4', wide: true },
    { key: 'city', label: 'City' },
    { key: 'postcode', label: 'Postcode' },
    { key: 'state', label: 'State' },
    { key: 'country', label: 'Country' },
  ] },
  { title: 'Notes', fields: [{ key: 'notes', label: 'Notes', wide: true }] },
];

const text = (v: string | null | undefined): string => (v ?? '').trim();

/** A fresh form: every box blank, the country Malaysia. */
export const emptyDebtorParty = (): DebtorPartyValues => ({
  name: '', phone: '', notes: '',
  tinNumber: '', businessRegNo: '', contactPerson: '', attention: '',
  email: '', phone2: '', mobile: '', whatsappNumber: '', fax: '',
  address1: '', address2: '', address3: '', address4: '',
  city: '', postcode: '', state: '', country: 'Malaysia',
});

/** The form's values from a stored debtor — the columns into the boxes. */
export const debtorPartyFrom = (d: Partial<DebtorPartyColumns> & { name: string; phone: string | null; notes: string | null }): DebtorPartyValues => ({
  name: text(d.name), phone: text(d.phone), notes: text(d.notes),
  tinNumber: text(d.tin_number), businessRegNo: text(d.business_reg_no), contactPerson: text(d.contact_person), attention: text(d.attention),
  email: text(d.email), phone2: text(d.phone2), mobile: text(d.mobile), whatsappNumber: text(d.whatsapp_number), fax: text(d.fax),
  address1: text(d.address1), address2: text(d.address2), address3: text(d.address3), address4: text(d.address4),
  city: text(d.city), postcode: text(d.postcode), state: text(d.state), country: text(d.country),
});

/** What the registry routes are sent: every box, trimmed. A blank on Edit clears the field (the server stores NULL). */
export const debtorPartyBody = (v: DebtorPartyValues): DebtorPartyValues =>
  Object.fromEntries(Object.entries(v).map(([k, s]) => [k, text(s)])) as DebtorPartyValues;

/** The address as the paper prints it: the filled lines, then postcode and city, then state and country. */
export const partyAddressLines = (d: Partial<DebtorPartyColumns>): string[] => {
  const lines = [d.address1, d.address2, d.address3, d.address4].map(text).filter(Boolean);
  const town = [text(d.postcode), text(d.city)].filter(Boolean).join(' ');
  if (town) lines.push(town);
  const region = [text(d.state), text(d.country)].filter(Boolean).join(', ');
  if (region) lines.push(region);
  return lines;
};
