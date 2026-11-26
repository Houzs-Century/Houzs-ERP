import { describe, expect, it, beforeEach } from 'vitest';
import { absorbSessionPass, readAuthPass, AUTH_TOKEN_KEY, AUTH_PASS_KEY } from './authToken';

const res = (pass: string | null) => ({ headers: { get: (n: string) => (n === 'X-Session-Pass' ? pass : null) } });

describe('absorbSessionPass', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('keeps a re-issued pass', () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'tok');
    absorbSessionPass(res('new.pass.value'));
    expect(readAuthPass()).toBe('new.pass.value');
  });

  it('does nothing when the response carries no renewal', () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'tok');
    localStorage.setItem(AUTH_PASS_KEY, 'old.pass.value');
    absorbSessionPass(res(null));
    expect(readAuthPass()).toBe('old.pass.value');
  });

  it('follows a REMEMBERED login into localStorage', () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'tok');
    absorbSessionPass(res('p1'));
    expect(localStorage.getItem(AUTH_PASS_KEY)).toBe('p1');
    expect(sessionStorage.getItem(AUTH_PASS_KEY)).toBeNull();
  });

  it('follows a TAB-ONLY login into sessionStorage, and never persists it', () => {
    sessionStorage.setItem(AUTH_TOKEN_KEY, 'tok');
    absorbSessionPass(res('p2'));
    expect(sessionStorage.getItem(AUTH_PASS_KEY)).toBe('p2');
    expect(localStorage.getItem(AUTH_PASS_KEY)).toBeNull();
  });

  it('never throws when the header cannot be read', () => {
    expect(() => absorbSessionPass({ headers: { get: () => { throw new Error('opaque'); } } })).not.toThrow();
  });
});
