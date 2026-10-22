import { describe, expect, test } from 'vitest';
import {
  afterDoAddFields, afterDoCopyProblem, afterDoEditFields, afterDoEditableLine, afterDoHeaderFields, soAfterDoMode,
  type AfterDoSave,
} from './so-after-do-client';

const DO = { id: 'do-1', do_number: 'HC-DO-2610-011', status: 'LOADED', locked: false };
const INVOICED = { ...DO, id: 'do-2', do_number: 'HC-DO-2610-020', locked: true };
const canAll = () => true;

describe('when the Edit-after-DO mode is on', () => {
  test('a DELIVERED order needs Override first', () => {
    const header = { status: 'DELIVERED', after_do_targets: [DO] };
    expect(soAfterDoMode(header, { can: canAll, override: false, migrated: false }).on).toBe(false);
    expect(soAfterDoMode(header, { can: canAll, override: true, migrated: false })).toMatchObject({ on: true, headerOpen: true });
  });

  test('a partly delivered order (not SHIPPED+) opens without Override', () => {
    expect(soAfterDoMode({ status: 'READY_TO_SHIP', after_do_targets: [DO] }, { can: canAll, override: false, migrated: false }).on).toBe(true);
  });

  test('never without the permission, on a migrated order, or with no open DO', () => {
    const header = { status: 'DELIVERED', after_do_targets: [DO] };
    expect(soAfterDoMode(header, { can: () => false, override: true, migrated: false }).on).toBe(false);
    expect(soAfterDoMode(header, { can: canAll, override: true, migrated: true }).on).toBe(false);
    expect(soAfterDoMode({ status: 'DELIVERED', after_do_targets: [INVOICED] }, { can: canAll, override: true, migrated: false }).on).toBe(false);
    expect(soAfterDoMode({ status: 'DELIVERED', after_do_targets: null }, { can: canAll, override: true, migrated: false }).on).toBe(false);
  });

  test('one invoiced DO keeps the customer details shut but leaves charge lines open', () => {
    const m = soAfterDoMode({ status: 'DELIVERED', after_do_targets: [DO, INVOICED] }, { can: canAll, override: true, migrated: false });
    expect(m).toMatchObject({ on: true, headerOpen: false });
    expect(m.openTargets.map((t) => t.id)).toEqual(['do-1']);
  });
});

describe('what each save carries', () => {
  const mode = soAfterDoMode({ status: 'DELIVERED', after_do_targets: [DO] }, { can: canAll, override: true, migrated: false });
  const save: AfterDoSave = { mode, lineIds: new Set(['line-svc']), chargeAdds: true, targetId: 'do-1' };

  test('only a frozen charge line reopens', () => {
    expect(afterDoEditableLine(mode, { downstream_frozen: true, item_code: 'SVC-TRANSPORT', item_group: 'service' })).toBe(true);
    expect(afterDoEditableLine(mode, { downstream_frozen: true, item_code: 'BF-QUEEN', item_group: 'bedframe' })).toBe(false);
    expect(afterDoEditableLine(mode, { downstream_frozen: false, item_code: 'SVC-TRANSPORT', item_group: 'service' })).toBe(false);
  });

  test('the flags ride only the requests that need them', () => {
    expect(afterDoHeaderFields(save, { phone: '1' })).toEqual({ afterDo: true });
    expect(afterDoHeaderFields(save, {})).toEqual({});
    expect(afterDoEditFields(save, 'line-svc')).toEqual({ afterDo: true });
    expect(afterDoEditFields(save, 'line-bed')).toEqual({});
    expect(afterDoAddFields(save)).toEqual({ afterDo: true, targetDoId: 'do-1' });
    expect(afterDoAddFields({ ...save, chargeAdds: false })).toEqual({});
    expect(afterDoAddFields(null)).toEqual({});
  });

  test('a DO the server could not update is named to the operator', () => {
    expect(afterDoCopyProblem({ ok: true, doCopyFailed: ['HC-DO-2610-011'] })).toContain('HC-DO-2610-011');
    expect(afterDoCopyProblem({ ok: true, doCopyFailed: [] })).toBeNull();
    expect(afterDoCopyProblem({ ok: true })).toBeNull();
  });
});
