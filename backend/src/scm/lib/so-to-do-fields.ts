
/** The SO header columns a Delivery Order snapshots. Shared select list. */
export const SO_CONVERT_HEADER =
  'doc_no, company_id, debtor_code, debtor_name, agent, salesperson_id, ' +
  'address1, address2, address3, address4, city, customer_state, postcode, phone, ' +
  'email, customer_type, building_type, branding, venue, venue_id, ref, sales_location, ' +
  'customer_country, customer_delivery_date, amended_delivery_date, customer_so_no, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, currency';

/** The date the goods actually go out: the one set on Delivery Planning
 *  (amended_delivery_date) when there is one, else the customer's date on the SO. */
export function soPlannedDeliveryDate(head: Record<string, unknown>): string | null {
  const v = str(head.amended_delivery_date) ?? str(head.customer_delivery_date);
  return v == null ? null : v.slice(0, 10);
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export interface SoConversionSource {
  soDocNo: string | null;
  companyId: number | null;
  debtorCode: string | null;
  customerName: string | null;
  customerSoRef: string | null;
  phone: string | null;
  email: string | null;
  customerType: string | null;
  salesperson: string | null;
  salespersonId: string | null;
  agent: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  customerState: string | null;
  postcode: string | null;
  customerCountry: string | null;
  salesLocation: string | null;
  buildingType: string | null;
  branding: string | null;
  venue: string | null;
  venueId: string | null;
  customerDeliveryDate: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelationship: string | null;
  currency: string;
}

/**
 * Map a raw `mfg_sales_orders` header row to the DO form's field names.
 *
 * The derivations mirror what POST /from-sos writes onto the DO row, so what the
 * form previews is what the commit would store:
 *   · address2 falls back to address3 + address4 joined (the DO has two address
 *     lines, the SO has four).
 *   · salesperson prefers the human `agent` label and falls back to the id.
 *   · customerSoRef prefers the customer's own SO number over the generic ref.
 * `currency` is the one field with a default, and it is the SAME default the
 * commit applies ('MYR') — not a cover for an unread value.
 */
export function soHeaderToDoSource(head: Record<string, unknown>): SoConversionSource {
  return {
    soDocNo: str(head.doc_no),
    companyId: head.company_id == null ? null : Number(head.company_id),
    debtorCode: str(head.debtor_code),
    customerName: str(head.debtor_name),
    customerSoRef: str(head.customer_so_no) ?? str(head.ref),
    phone: str(head.phone),
    email: str(head.email),
    customerType: str(head.customer_type),
    salesperson: str(head.agent) ?? str(head.salesperson_id),
    salespersonId: str(head.salesperson_id),
    agent: str(head.agent),
    address1: str(head.address1),
    address2: str(head.address2) ?? str([head.address3, head.address4].filter(Boolean).join(', ')),
    city: str(head.city),
    customerState: str(head.customer_state),
    postcode: str(head.postcode),
    customerCountry: str(head.customer_country),
    salesLocation: str(head.sales_location),
    buildingType: str(head.building_type),
    branding: str(head.branding),
    venue: str(head.venue),
    venueId: str(head.venue_id),
    customerDeliveryDate: soPlannedDeliveryDate(head),
    emergencyContactName: str(head.emergency_contact_name),
    emergencyContactPhone: str(head.emergency_contact_phone),
    emergencyContactRelationship: str(head.emergency_contact_relationship),
    currency: str(head.currency) ?? 'MYR',
  };
}

const REPORTED_FIELDS: ReadonlyArray<readonly [keyof SoConversionSource, string]> = [
  ['customerName', 'Customer Name'],
  ['phone', 'Phone'],
  ['email', 'Email'],
  ['customerType', 'Customer Type'],
  ['salesperson', 'Salesperson'],
  ['address1', 'Address Line 1'],
  ['address2', 'Address Line 2'],
  ['customerState', 'State'],
  ['city', 'City'],
  ['postcode', 'Postcode'],
  ['salesLocation', 'Sales Location'],
  /* Seeded into the form since 2026-09-08 (docs/bugs/0723); before that a DO
     raised from the form carried no customer date unless the operator retyped it. */
  ['customerDeliveryDate', 'Delivery Date'],
];

/**
 * Which of the form's fields the SOURCE ORDER genuinely does not carry.
 *
 * This is the difference the owner needs on screen: "we could not read the sales
 * order" and "the sales order has no email address" produce the same blank box
 * otherwise, and only one of them is a bug.
 */
export function missingSourceFields(source: SoConversionSource): string[] {
  return REPORTED_FIELDS.filter(([key]) => source[key] == null).map(([, label]) => label);
}
