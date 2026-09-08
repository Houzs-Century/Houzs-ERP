// WHAT A SALES ORDER'S HEADER CARRIES ONTO A MIGRATED DELIVERY ORDER — the
// script-side twin of backend/src/scm/lib/so-to-do-fields.ts, which is what the
// interactive POST /delivery-orders-mfg/from-sos writes. THAT FILE IS THE RULE;
// this is a copy only because a .mjs script cannot import TypeScript.
//
// WHY IT EXISTS. lib/migrated-do-writer.mjs wrote the DO header with twelve
// columns — number, SO link, debtor, status, date, currency, company, author,
// note, the migrated flag, the AutoCount number, the ship-from branch — and
// never the customer / delivery snapshot: address, phone, email, salesperson,
// agent, customer type, building type, branding, venue, ref, the emergency
// contact, the customer delivery date. Every AutoCount-mirrored DO therefore
// opened with Phone / Email / Address / Salesperson / Delivery date all "—",
// and printed the same way (HC-DO-011559, 2026-09-08; docs/bugs/0716).
//
// A delivery order is a SNAPSHOT OF THE SALES ORDER AT DISPATCH, so the source
// is the SO header the DO's so_doc_no names — copied, never computed. The
// derivations below are the ones the UI writer applies:
//   · address2 falls back to address3 + address4 (the DO has two lines, the SO four)
//   · `state` mirrors customer_state (the DO carries both)
//   · phones are stored E.164 through the SAME normaliser the API uses
//   · expected_delivery_at falls back to the DO's own date, as /from-sos falls
//     back to "today" at creation
//
// NOT HERE, on purpose: sales_location and warehouse_id. On a migrated DO those
// are the SHIP-FROM BRANCH from the account book (owner 2026-09-07, 「记在单头
// 就好」; lib/ac-do-location.mjs), not the SO's sales branch. Copying the SO's
// would overwrite a ruling with a guess.
//
// Two consumers: the writer (new documents) and backfill-migrated-do-header.mjs
// (the documents already written). One mapping, so they cannot drift.
import { normalizePhone } from "./phone-normalise.mjs";

const str = (v) => { if (v == null) return null; const s = String(v).trim(); return s === "" ? null : s; };
const phone = (v) => { const s = str(v); return s ? (normalizePhone(s) ?? s) : null; };

/** The mfg_sales_orders columns the snapshot reads. Select exactly these. */
export const SO_HEADER_SNAPSHOT_COLS = [
  "doc_no", "debtor_name", "address1", "address2", "address3", "address4", "city", "customer_state",
  "customer_country", "postcode", "phone", "email", "salesperson_id", "agent", "customer_type",
  "building_type", "branding", "venue", "venue_id", "ref", "emergency_contact_name",
  "emergency_contact_phone", "emergency_contact_relationship", "customer_delivery_date",
];

/** DO column -> derivation from the SO header row (and the DO's own date). */
const FIELDS = [
  ["address1", (so) => str(so.address1)],
  ["address2", (so) => str(so.address2) ?? str([so.address3, so.address4].filter(Boolean).join(", "))],
  ["city", (so) => str(so.city)],
  ["state", (so) => str(so.customer_state)],
  ["customer_state", (so) => str(so.customer_state)],
  ["customer_country", (so) => str(so.customer_country)],
  ["postcode", (so) => str(so.postcode)],
  ["phone", (so) => phone(so.phone)],
  ["email", (so) => str(so.email)],
  ["salesperson_id", (so) => str(so.salesperson_id)],
  ["agent", (so) => str(so.agent)],
  ["customer_type", (so) => str(so.customer_type)],
  ["building_type", (so) => str(so.building_type)],
  ["branding", (so) => str(so.branding)],
  ["venue", (so) => str(so.venue)],
  ["venue_id", (so) => str(so.venue_id)],
  ["ref", (so) => str(so.ref)],
  ["emergency_contact_name", (so) => str(so.emergency_contact_name)],
  ["emergency_contact_phone", (so) => phone(so.emergency_contact_phone)],
  ["emergency_contact_relationship", (so) => str(so.emergency_contact_relationship)],
  ["customer_delivery_date", (so) => str(so.customer_delivery_date)],
  ["expected_delivery_at", (so, ctx) => str(so.customer_delivery_date) ?? str(ctx.doDate)],
];

/** The delivery_orders columns the snapshot writes, in FIELDS order. */
export const DO_HEADER_SNAPSHOT_COLS = FIELDS.map(([c]) => c);

/**
 * Map one SO header row to the DO columns it fills. A field the SO does not
 * carry comes back null — NOTHING is defaulted to '' — so a caller can tell
 * "the source is blank" from "the source was never read". `doDate` is the
 * DO's own date (YYYY-MM-DD), the fallback for expected_delivery_at.
 */
export function soHeaderToDoSnapshot(so, { doDate = null } = {}) {
  const out = {};
  for (const [col, derive] of FIELDS) out[col] = so ? derive(so, { doDate }) : null;
  return out;
}

/** SELECT list for the snapshot columns, aliased `<prefix>_<col>` when asked. */
export function soHeaderSelectList(alias = "h", prefix = null) {
  return SO_HEADER_SNAPSHOT_COLS
    .map((c) => (prefix ? `${alias}.${c} AS "${prefix}_${c}"` : `${alias}.${c}`))
    .join(", ");
}
