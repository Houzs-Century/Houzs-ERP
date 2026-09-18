/* The literal reading of a permission — the wildcard alone is not a holder
   (docs/bugs/0888). Pinned because the access reading beside it (`can`) says
   the opposite on purpose, and a screen that reached for the wrong one would
   either ask the Owner for a reason on every payment or never ask Finance. */
import { describe, expect, it } from 'vitest';
import { holdsPermissionLiterally } from './literalPermission';

describe('holdsPermissionLiterally', () => {
  it('a role that names the key holds it', () => {
    expect(holdsPermissionLiterally({ permissions: ['projects.read', 'scm.so_payment.amend'] }, 'scm.so_payment.amend')).toBe(true);
  });

  it('the wildcard alone does not', () => {
    expect(holdsPermissionLiterally({ permissions: ['*'] }, 'scm.so_payment.amend')).toBe(false);
  });

  it('the wildcard beside the key still holds it — a Super Admin on a role that names it', () => {
    expect(holdsPermissionLiterally({ permissions: ['scm.so_payment.amend', '*'] }, 'scm.so_payment.amend')).toBe(true);
  });

  it('nobody, or a user with no list, holds nothing', () => {
    expect(holdsPermissionLiterally(null, 'scm.so_payment.amend')).toBe(false);
    expect(holdsPermissionLiterally(undefined, 'scm.so_payment.amend')).toBe(false);
    expect(holdsPermissionLiterally({}, 'scm.so_payment.amend')).toBe(false);
    expect(holdsPermissionLiterally({ permissions: null }, 'scm.so_payment.amend')).toBe(false);
  });
});
