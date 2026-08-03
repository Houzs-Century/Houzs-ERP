import { describe, expect, it } from 'vitest';
import {
  partyTypeFor, emptySnapshot,
  snapshotFromWarehouse, snapshotFromWorkshop, snapshotFromWorkshopName,
  type DpJobType,
} from './dp-party';

/**
 * dp-party.ts opens with "every mapping is unit-tested without a database" —
 * which was an intention, not a fact: the module shipped with no test file. The
 * two job types mig 0250 adds (owner's 2026-08-03 nine-job-type list) are the
 * first whose party is one of OUR OWN places, so what "party" means is exactly
 * the thing worth pinning down before a UI is built on top of it.
 */

describe('which master a job type draws its party from', () => {
  it('sends the two new job types to their own masters, not to CUSTOMER', () => {
    expect(partyTypeFor('TRANSFER')).toBe('WAREHOUSE');
    expect(partyTypeFor('LORRY_SERVICE')).toBe('WORKSHOP');
  });

  it('leaves the seven existing types exactly where they were', () => {
    expect(partyTypeFor('SUPPLIER_PICKUP')).toBe('SUPPLIER');
    expect(partyTypeFor('SETUP')).toBe('VENUE');
    expect(partyTypeFor('DISMANTLE')).toBe('VENUE');
    for (const t of ['DELIVERY', 'PICKUP', 'SERVICE', 'INSPECTION'] as DpJobType[]) {
      expect(partyTypeFor(t), `${t} is a customer-facing job`).toBe('CUSTOMER');
    }
  });

  it('an empty snapshot still carries the right party type', () => {
    // A manual order with no source document is still a warehouse/workshop job.
    expect(emptySnapshot('TRANSFER').party_type).toBe('WAREHOUSE');
    expect(emptySnapshot('LORRY_SERVICE').party_type).toBe('WORKSHOP');
    expect(emptySnapshot('TRANSFER').party_name).toBeNull();
  });
});

describe('snapshotFromWarehouse — the destination of a transfer', () => {
  const row = {
    code: 'KL WAREHOUSE', name: 'Balakong Main',
    location: 'Lot 12, Jalan Balakong', city: 'Seri Kembangan',
    postcode: '43300', state: 'Selangor',
  };

  it('maps the free-text location to the one street line it has', () => {
    const snap = snapshotFromWarehouse(row);
    expect(snap).toEqual({
      party_type: 'WAREHOUSE',
      party_name: 'Balakong Main',
      contact_name: null,
      contact_phone: null,
      address1: 'Lot 12, Jalan Balakong',
      address2: null, address3: null, address4: null,
      city: 'Seri Kembangan', postcode: '43300', state: 'Selangor',
    });
  });

  it('falls back to the code for a warehouse nobody gave a name', () => {
    expect(snapshotFromWarehouse({ ...row, name: '   ' }).party_name).toBe('KL WAREHOUSE');
  });

  it('does not invent a contact — the master has none', () => {
    const snap = snapshotFromWarehouse({ ...row, contact_name: 'ignored', phone: '0123456789' });
    expect(snap.contact_name).toBeNull();
    expect(snap.contact_phone).toBeNull();
  });
});

describe('snapshotFromWorkshop — where a lorry service goes', () => {
  const row = {
    code: 'WS0001', name: 'T FORCE AUTO SERVICES SDN BHD',
    contact_name: 'Mr Tan', contact_phone: '0122223333', office_phone: '0388889999',
    address: 'No 8, Jalan Perusahaan, Shah Alam',
  };

  it('prefers the named contact over the switchboard', () => {
    const snap = snapshotFromWorkshop(row);
    expect(snap.party_type).toBe('WORKSHOP');
    expect(snap.party_name).toBe('T FORCE AUTO SERVICES SDN BHD');
    expect(snap.contact_phone).toBe('0122223333');
    expect(snap.address1).toBe('No 8, Jalan Perusahaan, Shah Alam');
  });

  it('falls back to the office line when there is no contact phone', () => {
    expect(snapshotFromWorkshop({ ...row, contact_phone: null }).contact_phone).toBe('0388889999');
    expect(snapshotFromWorkshop({ ...row, contact_phone: '' }).contact_phone).toBe('0388889999');
  });

  it('leaves city/postcode/state null — the master has one free-text address', () => {
    const snap = snapshotFromWorkshop(row);
    expect([snap.address2, snap.address3, snap.address4]).toEqual([null, null, null]);
    expect([snap.city, snap.postcode, snap.state]).toEqual([null, null, null]);
  });
});

describe('snapshotFromWorkshopName — a work order whose workshop was never linked', () => {
  it('keeps the name a driver can act on rather than showing a blank party', () => {
    // Mig 0241 deliberately did not backfill workshop_id from the free-text
    // `workshop` column, so older work orders know only the name.
    const snap = snapshotFromWorkshopName('T FORCE AUTO SERVICES');
    expect(snap.party_type).toBe('WORKSHOP');
    expect(snap.party_name).toBe('T FORCE AUTO SERVICES');
    expect(snap.address1).toBeNull();
  });

  it('treats a blank workshop string as no party at all', () => {
    expect(snapshotFromWorkshopName('   ').party_name).toBeNull();
    expect(snapshotFromWorkshopName(null).party_name).toBeNull();
  });
});
