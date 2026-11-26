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
    expect(validatePasswordStrength(USERNAME_PASSWORD, null).ok).toBe(true);
  });

  it('so omitting the address is a COMPILE error', () => {
    // @ts-expect-error
    const omitted = () => validatePasswordStrength(USERNAME_PASSWORD);
    expect(omitted).toBeInstanceOf(Function);
  });
});
