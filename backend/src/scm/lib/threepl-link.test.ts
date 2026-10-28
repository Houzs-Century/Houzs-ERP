import { describe, it, expect } from 'vitest';
import { resolveCarrierLink, carrierLinkForInsert } from './threepl-link';

const CARRIER = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

describe('resolveCarrierLink — attaching a carrier forces outsource', () => {
  it('attaching sets the link and forces the own flag false', () => {
    expect(resolveCarrierLink({ threeplCompanyId: CARRIER }))
      .toEqual({ carrierId: CARRIER, ownFlag: false });
  });

  it('a caller claiming in-house while attaching a carrier is overridden', () => {
    // The form cannot make a 3PL's lorry ours by ticking a box.
    expect(resolveCarrierLink({ threeplCompanyId: CARRIER, ownFlag: true }))
      .toEqual({ carrierId: CARRIER, ownFlag: false });
  });
});

describe('resolveCarrierLink — detaching', () => {
  it('explicit null clears the link and leaves the flag alone when none was sent', () => {
    // A detached row is not automatically ours again — a human decides.
    expect(resolveCarrierLink({ threeplCompanyId: null })).toEqual({ carrierId: null });
  });

  it('explicit null honours an own flag the caller did send', () => {
    expect(resolveCarrierLink({ threeplCompanyId: null, ownFlag: true }))
      .toEqual({ carrierId: null, ownFlag: true });
  });

  it('an empty string is treated as a detach, not as a carrier id', () => {
    expect(resolveCarrierLink({ threeplCompanyId: '' })).toEqual({ carrierId: null });
  });
});

describe('resolveCarrierLink — field absent', () => {
  it('touches neither field when nothing was sent', () => {
    expect(resolveCarrierLink({})).toEqual({});
  });

  it('passes through a lone own-flag change with no link change', () => {
    expect(resolveCarrierLink({ ownFlag: false })).toEqual({ ownFlag: false });
    expect(resolveCarrierLink({ ownFlag: true })).toEqual({ ownFlag: true });
  });
});

describe('carrierLinkForInsert — both fields always resolve', () => {
  it('a carrier on insert lands outsource', () => {
    expect(carrierLinkForInsert({ threeplCompanyId: CARRIER }))
      .toEqual({ carrierId: CARRIER, ownFlag: false });
  });

  it('a carrier on insert beats an in-house claim', () => {
    expect(carrierLinkForInsert({ threeplCompanyId: CARRIER, ownFlag: true }))
      .toEqual({ carrierId: CARRIER, ownFlag: false });
  });

  it('no carrier keeps the table default (ours)', () => {
    expect(carrierLinkForInsert({})).toEqual({ carrierId: null, ownFlag: true });
  });

  it('no carrier but an explicit outsource claim is honoured', () => {
    // The pre-3PL way of marking an outsourced row still works, unlinked.
    expect(carrierLinkForInsert({ ownFlag: false })).toEqual({ carrierId: null, ownFlag: false });
  });

  it('an empty-string carrier is no carrier', () => {
    expect(carrierLinkForInsert({ threeplCompanyId: '' })).toEqual({ carrierId: null, ownFlag: true });
  });
});

/**
 * The Fleet grid's Outsource tick-box.
 *
 * That control posts `{ id, inHouse }` and nothing else, so threeplCompanyId is
 * `undefined` and the old rule simply flipped the flag — leaving a driver with
 * in_house = true while threepl_company_id still pointed at MSJ TRANSPORT. The
 * 3PL screen's own footer promises this cannot happen; the promise was only
 * kept on the paths that also sent the carrier id.
 *
 * Owner, 2026-08-02. Refuse rather than auto-detach: silently clearing the link
 * would drop a driver off a carrier's roster because someone ticked a box in a
 * grid, with nothing on screen saying so.
 */
describe('resolveCarrierLink — marking a linked row as ours', () => {
  it('refuses to mark it ours while a carrier still owns it', () => {
    expect(resolveCarrierLink({ ownFlag: true, currentCarrierId: CARRIER }))
      .toEqual({ conflict: 'own_flag_while_linked' });
  });

  it('the refusal carries NO writable key, so a caller that forgets to check writes nothing', () => {
    const patch = resolveCarrierLink({ ownFlag: true, currentCarrierId: CARRIER });
    expect(patch.carrierId).toBeUndefined();
    expect(patch.ownFlag).toBeUndefined();
  });

  it('marking it OUTSOURCE while linked is fine — that is not a contradiction', () => {
    expect(resolveCarrierLink({ ownFlag: false, currentCarrierId: CARRIER }))
      .toEqual({ ownFlag: false });
  });

  it('detaching and claiming it in the same request is allowed — the link goes first', () => {
    expect(resolveCarrierLink({ threeplCompanyId: null, ownFlag: true, currentCarrierId: CARRIER }))
      .toEqual({ carrierId: null, ownFlag: true });
  });

  it('an unlinked row can still be marked ours', () => {
    expect(resolveCarrierLink({ ownFlag: true, currentCarrierId: null })).toEqual({ ownFlag: true });
    expect(resolveCarrierLink({ ownFlag: true })).toEqual({ ownFlag: true });
  });

  it('moving a linked row to ANOTHER carrier still forces outsource', () => {
    expect(resolveCarrierLink({ threeplCompanyId: OTHER, ownFlag: true, currentCarrierId: CARRIER }))
      .toEqual({ carrierId: OTHER, ownFlag: false });
  });

  it('touching neither field is still a no-op on a linked row', () => {
    expect(resolveCarrierLink({ currentCarrierId: CARRIER })).toEqual({});
  });
});
