// ---------------------------------------------------------------------------
// dp-party.ts — resolve a DP Order's PARTY snapshot from the right master.
//
// Owner spec 2026-07-18: each job type auto-fills its party from a DIFFERENT
// master, and the masters DISAGREE on shape (survey 2026-07-18). So the DP Order
// stores its OWN flat snapshot; these pure mappers translate each master row into
// that one shape. No DB here — the route reads the row, these map it — so every
// mapping is unit-tested without a database.
//
//   DELIVERY / PICKUP / SERVICE → CUSTOMER  (SO header, or the service case)
//   SUPPLIER_PICKUP             → SUPPLIER   (scm.suppliers — single-line address)
//   SETUP / DISMANTLE           → VENUE      (public.projects; PIC from public.users)
//   INSPECTION                  → CUSTOMER   (an ASSR leg, like SERVICE/PICKUP)
//   TRANSFER                    → WAREHOUSE  (scm.warehouses — the DESTINATION)
//   LORRY_SERVICE               → WORKSHOP   (scm.workshops, mig 0241)
//
// The last two joined scm.trip_stop_type in mig 0250 (owner 2026-08-03, the
// nine-job-type list). They are the first whose party is one of OUR OWN places
// rather than a counterparty — a transfer ends at a warehouse we own, a lorry
// service at the workshop we send it to — so party_type records that instead of
// filing them under CUSTOMER, which would make "who was this job for" a lie in
// every report that groups by party.
// ---------------------------------------------------------------------------

export type DpJobType =
  | 'DELIVERY' | 'PICKUP' | 'SERVICE' | 'SETUP' | 'DISMANTLE' | 'SUPPLIER_PICKUP'
  | 'INSPECTION' | 'TRANSFER' | 'LORRY_SERVICE';
export type DpPartyType = 'CUSTOMER' | 'SUPPLIER' | 'VENUE' | 'WAREHOUSE' | 'WORKSHOP';

export interface DpPartySnapshot {
  party_type: DpPartyType;
  party_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  city: string | null;
  postcode: string | null;
  state: string | null;
}

/** Which master a job type draws its party from. */
export function partyTypeFor(jobType: DpJobType): DpPartyType {
  switch (jobType) {
    case 'SUPPLIER_PICKUP': return 'SUPPLIER';
    case 'SETUP':
    case 'DISMANTLE': return 'VENUE';
    case 'TRANSFER': return 'WAREHOUSE';
    case 'LORRY_SERVICE': return 'WORKSHOP';
    default: return 'CUSTOMER'; // DELIVERY / PICKUP / SERVICE / INSPECTION
  }
}

const s = (v: unknown): string | null => {
  const t = (v == null ? '' : String(v)).trim();
  return t === '' ? null : t;
};

/** From an scm.mfg_sales_orders header row. The SO has NO contact-person column
 *  (survey), so contact_name is null; the debtor is the party. */
export function snapshotFromSo(row: Record<string, unknown>): DpPartySnapshot {
  return {
    party_type: 'CUSTOMER',
    party_name: s(row.debtor_name),
    contact_name: null,
    contact_phone: s(row.phone),
    address1: s(row.address1), address2: s(row.address2), address3: s(row.address3), address4: s(row.address4),
    city: s(row.city), postcode: s(row.postcode),
    state: s(row.customer_state),
  };
}

/** From an scm.suppliers row. Since mig 0131 the supplier master carries the
 *  SO-style structured address (address1-4 + city); prefer it when ANY structured
 *  line is filled, else fall back to the legacy single `address` → address1 (rows
 *  not yet re-entered in the maintenance form). contact_name prefers
 *  contact_person, then attention; phone prefers phone, then mobile. */
export function snapshotFromSupplier(row: Record<string, unknown>): DpPartySnapshot {
  const structured = [row.address1, row.address2, row.address3, row.address4].some((v) => s(v) != null);
  return {
    party_type: 'SUPPLIER',
    party_name: s(row.name),
    contact_name: s(row.contact_person) ?? s(row.attention),
    contact_phone: s(row.phone) ?? s(row.mobile),
    address1: structured ? s(row.address1) : s(row.address),
    address2: structured ? s(row.address2) : null,
    address3: structured ? s(row.address3) : null,
    address4: structured ? s(row.address4) : null,
    city: s(row.city),
    postcode: s(row.postcode),
    state: s(row.state),
  };
}

/** From a public.projects row + the PIC's public.users row. The project's PIC is
 *  a users(id) FK (survey), so the contact NAME/PHONE come from the user, not the
 *  project. The venue address is a single free-text line → address1. */
export function snapshotFromProject(
  proj: Record<string, unknown>,
  picUser: Record<string, unknown> | null,
): DpPartySnapshot {
  return {
    party_type: 'VENUE',
    party_name: s(proj.venue) ?? s(proj.organizer),
    contact_name: picUser ? s(picUser.name) : null,
    contact_phone: picUser ? s(picUser.phone) : null,
    address1: s(proj.venue_address), address2: null, address3: null, address4: null,
    city: null, postcode: null,
    state: s(proj.state),
  };
}

/** From a public.assr_cases row (a service case → SERVICE / PICKUP). No postcode
 *  or dedicated state column (survey); `location` doubles as the region/state. */
export function snapshotFromAssr(row: Record<string, unknown>): DpPartySnapshot {
  return {
    party_type: 'CUSTOMER',
    party_name: s(row.customer_name),
    contact_name: null,
    contact_phone: s(row.phone),
    address1: s(row.addr1), address2: s(row.addr2), address3: s(row.addr3), address4: s(row.addr4),
    city: null, postcode: null,
    state: s(row.location),
  };
}

/** From an scm.warehouses row — the DESTINATION of a TRANSFER job.
 *
 *  The warehouse master keeps its original free-text `location` ("Address /
 *  area") alongside the canonical city / postcode / state columns mig 0180
 *  added; location is the only street line there is, so it maps to address1.
 *  party_name prefers the human `name` and falls back to `code`, because some
 *  rows are only ever referred to by code (KL WAREHOUSE). The master carries no
 *  contact person or phone — leaving those null is the honest answer; the
 *  operator can type one on the order. */
export function snapshotFromWarehouse(row: Record<string, unknown>): DpPartySnapshot {
  return {
    party_type: 'WAREHOUSE',
    party_name: s(row.name) ?? s(row.code),
    contact_name: null,
    contact_phone: null,
    address1: s(row.location), address2: null, address3: null, address4: null,
    city: s(row.city), postcode: s(row.postcode),
    state: s(row.state),
  };
}

/** From an scm.workshops row (mig 0241) — where a LORRY_SERVICE job is going.
 *
 *  The workshop master has ONE free-text `address` (like scm.suppliers before
 *  0131 structured it), so it maps to address1 with nothing to split into 2-4.
 *  contact_phone prefers the named contact's phone, then the office line — the
 *  same "person first, switchboard second" precedence snapshotFromSupplier uses
 *  for phone/mobile. */
export function snapshotFromWorkshop(row: Record<string, unknown>): DpPartySnapshot {
  return {
    party_type: 'WORKSHOP',
    party_name: s(row.name) ?? s(row.code),
    contact_name: s(row.contact_name),
    contact_phone: s(row.contact_phone) ?? s(row.office_phone),
    address1: s(row.address), address2: null, address3: null, address4: null,
    city: null, postcode: null, state: null,
  };
}

/** From a work order whose workshop was never linked to the master.
 *
 *  scm.lorry_work_orders carries a free-text `workshop` string, and mig 0241
 *  deliberately did NOT backfill workshop_id from it ("inventing the mapping
 *  would fabricate spend attribution"). So a DP order raised off an older work
 *  order can know the workshop's NAME and nothing else — which is still worth
 *  putting on the job rather than showing the driver a blank party. */
export function snapshotFromWorkshopName(name: unknown): DpPartySnapshot {
  return { ...emptySnapshot('LORRY_SERVICE'), party_name: s(name) };
}

/** An empty snapshot of the right party type — for a manual DP order with no
 *  source document, where the operator types the fields. */
export function emptySnapshot(jobType: DpJobType): DpPartySnapshot {
  return {
    party_type: partyTypeFor(jobType),
    party_name: null, contact_name: null, contact_phone: null,
    address1: null, address2: null, address3: null, address4: null,
    city: null, postcode: null, state: null,
  };
}
