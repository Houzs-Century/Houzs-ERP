/* ---------------------------------------------------------------------------
 * do-header-form.ts — the Delivery Order HEADER edit, as data: what a loaded DO
 * seeds into the form, and the PATCH body the form sends.
 *
 * ONE LAYER, TWO SCREENS. Owner 2026-09-12: the phone gets FULL desktop parity
 * with the same permissions. The desktop's edit mode (DeliveryOrderNewV2
 * ?edit=<id>) and the phone's MobileDoHeaderEdit both call seedDoHeaderForm and
 * buildDoHeaderBody, and both send the result through the SAME hook,
 * useUpdateMfgDeliveryOrderHeader — so the phone cannot send a body the desktop
 * would not.
 *
 * THE LOCK. Which fields may not change once a live Sales Invoice / Delivery
 * Return exists (owner ruling 2026-09-14) is vendor/shared/do-header-lock.ts, a
 * byte-identical copy of the module the server's PATCH reads. buildDoHeaderBody
 * drops the locked keys when the DO is locked: the screens disable those
 * fields, so they cannot have changed, and re-sending a stored value in an older
 * format would only invite a false refusal.
 * ------------------------------------------------------------------------- */
import { stripLockedDoHeaderKeys } from '../../shared/do-header-lock';

export interface DoHeaderForm {
  customerName: string;
  debtorCode: string;
  customerSoRef: string;
  phone: string;
  email: string;
  customerType: string;
  salespersonId: string;
  address1: string;
  address2: string;
  state: string;
  city: string;
  postcode: string;
  salesLocation: string;
  ecName: string;
  ecRelationship: string;
  ecPhone: string;
  doDate: string;
  driver: string;
  vehicle: string;
  buildingType: string;
  venue: string;
  branding: string;
  expectedDate: string;
  customerDelDate: string;
  note: string;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const day = (v: unknown): string => str(v).slice(0, 10);

/** The form a loaded DO seeds — `deliveryOrder` is GET /delivery-orders-mfg/:id's
    `deliveryOrder`. `today` fills a DO with no date (the desktop always did). */
export function seedDoHeaderForm(doo: Record<string, unknown>, today: string): DoHeaderForm {
  return {
    customerName: str(doo.debtor_name),
    debtorCode: str(doo.debtor_code),
    customerSoRef: str(doo.customer_so_no ?? doo.po_doc_no ?? doo.ref),
    phone: str(doo.phone),
    email: str(doo.email),
    customerType: str(doo.customer_type),
    salespersonId: str(doo.salesperson_id),
    address1: str(doo.address1),
    address2: str(doo.address2),
    state: str(doo.customer_state),
    city: str(doo.city),
    postcode: str(doo.postcode),
    salesLocation: str(doo.sales_location),
    ecName: str(doo.emergency_contact_name),
    ecRelationship: str(doo.emergency_contact_relationship),
    ecPhone: str(doo.emergency_contact_phone),
    doDate: day(doo.do_date ?? today),
    driver: str(doo.driver_name),
    vehicle: str(doo.vehicle),
    buildingType: str(doo.building_type),
    venue: str(doo.venue),
    branding: str(doo.branding),
    expectedDate: day(doo.expected_delivery_at),
    customerDelDate: day(doo.customer_delivery_date),
    note: str(doo.note ?? doo.notes),
  };
}

/** The header PATCH body (and the header half of the create body). `salesStaff`
    derives the legacy `agent` name from the picked salesperson — never typed. */
export function buildDoHeaderBody(
  f: DoHeaderForm,
  salesStaff: ReadonlyArray<{ id: string; name: string }>,
  opts: { locked: boolean },
): Record<string, unknown> {
  const body = {
    debtorName: f.customerName,
    debtorCode: f.debtorCode || undefined,
    phone: f.phone,
    email: f.email,
    customerType: f.customerType,
    salespersonId: f.salespersonId || undefined,
    agent: salesStaff.find((s) => s.id === f.salespersonId)?.name ?? '',
    address1: f.address1,
    address2: f.address2,
    customerState: f.state,
    city: f.city,
    postcode: f.postcode,
    salesLocation: f.salesLocation,
    emergencyContactName: f.ecName,
    emergencyContactRelationship: f.ecRelationship,
    emergencyContactPhone: f.ecPhone,
    doDate: f.doDate,
    driverName: f.driver,
    vehicle: f.vehicle,
    buildingType: f.buildingType,
    venue: f.venue,
    branding: f.branding,
    expectedDeliveryAt: f.expectedDate,
    customerDeliveryDate: f.customerDelDate,
    note: f.note,
    customerSoNo: f.customerSoRef,
  };
  return stripLockedDoHeaderKeys(body, opts.locked);
}

/** The explanation a locked DO shows above its form. */
export const DO_HEADER_LOCKED_NOTICE =
  'A Sales Invoice or Delivery Return already exists for this delivery order, so the customer, '
  + 'address, contact, dates and notes are locked. Driver, vehicle, expected delivery date and '
  + 'salesperson can still be changed. To change a locked field, cancel the invoice or return first.';
