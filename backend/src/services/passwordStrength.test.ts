// Pins the email half of the password gate. It was reachable only when a
// caller remembered to pass an address (`email?: string`), which is the
// optional-param-noop class: the rule existed, applied to some paths, and
// nothing failed on the ones it did not reach. `email` is now required —
// pass null where a caller genuinely has none.
import { describe, expect, it } from 'vitest';
import { validatePasswordStrength } from './passwordStrength';

const USERNAME_PASSWORD = 'Weisiang329-Strong!';

describe('validatePasswordStrength — the email rule only exists if the email arrives', () => {
  it('refuses a password built from the email local-part', () => {
    const res = validatePasswordStrength(USERNAME_PASSWORD, 'weisiang329@gmail.com');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("Password can't contain your email name");
  });

  it('and the SAME password passes every other rule — which is what made the miss silent', () => {
    // This is the test that fails without the parameter: drop the address and
    // the gate says yes to the exact password the rule exists to refuse.
    expect(validatePasswordStrength(USERNAME_PASSWORD, null).ok).toBe(true);
  });

  it('so omitting the address is a COMPILE error', () => {
    // Never invoked. Make `email` optional again and the directive below goes
    // unused, which `npm run typecheck` reports as TS2578.
    // @ts-expect-error
    const omitted = () => validatePasswordStrength(USERNAME_PASSWORD);
    expect(omitted).toBeInstanceOf(Function);
  });
});
