import { describe, it, expect } from 'vitest';
import { resolveCarrierLink, carrierLinkForInsert } from './threepl-link';

const CARRIER = '11111111-2222-3333-4444-555555555555';

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
