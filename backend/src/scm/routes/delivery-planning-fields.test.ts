// The EM cross-border transport fields (owner 2026-09-23) plumb through the
// /fields route: the camelCase request key -> scm.delivery_orders column map in
// DO_FIELD_COLS, and the zod body schema that accepts them. This pins both — a
// renamed column or a dropped field would silently stop the ESB/BS back-fill
// from writing.
import { describe, expect, it } from 'vitest';

import { DO_FIELD_COLS, fieldsSchema } from './delivery-planning-fields';

const EM_FIELD_COLS: Record<string, string> = {
  emDeliveryStatus: 'em_delivery_status',
  consignmentNo: 'consignment_no',
  vesselVoyage: 'vessel_voyage',
  etdPortKlang: 'etd_port_klang',
  bsDeliveryDate: 'bs_delivery_date',
  esbRemarks: 'esb_remarks',
  bsRemarks: 'bs_remarks',
  ctn: 'ctn',
  emDeliveredDate: 'em_delivered_date',
};

describe('EM transport fields — /fields plumbing (owner 2026-09-23)', () => {
  it('maps every EM key to its scm.delivery_orders column (DO-execution)', () => {
    for (const [key, col] of Object.entries(EM_FIELD_COLS)) {
      expect(DO_FIELD_COLS[key]).toBe(col);
    }
  });

  it('accepts the EM keys in the request body schema', () => {
    const parsed = fieldsSchema.safeParse(
      Object.fromEntries(Object.keys(EM_FIELD_COLS).map((k) => [k, 'x'])),
    );
    expect(parsed.success).toBe(true);
  });
});
