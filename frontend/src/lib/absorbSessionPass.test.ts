/* THE RENEWAL HAS TO SURVIVE THE STORE THE USER CHOSE.
 *
 * A pass lives 8 hours; a session lives 7 days; nothing minted a pass except the
 * four login endpoints. So for most of a session's life the client held an
 * expired pass and every request paid for the server's authorization re-read —
 * the signed-session work was inert without anyone being able to see it. The
 * server now re-issues on the authoritative path and hands the new pass back on
 * a response header; this is the half that keeps it.
 *
 * The trap worth a test is not "does it store the header" — it is WHERE. A
 * "don't remember me" login puts its token in sessionStorage on purpose, and a
 * renewal written to localStorage would quietly outlive the session the user
 * asked to be temporary, on a shared machine. So the destination is decided by
 * where the TOKEN is, every time, not by a default.
 */
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
    /* The whole point of the test file: the user said "do not remember me". */
    sessionStorage.setItem(AUTH_TOKEN_KEY, 'tok');
    absorbSessionPass(res('p2'));
    expect(sessionStorage.getItem(AUTH_PASS_KEY)).toBe('p2');
    expect(localStorage.getItem(AUTH_PASS_KEY)).toBeNull();
  });

  it('never throws when the header cannot be read', () => {
    expect(() => absorbSessionPass({ headers: { get: () => { throw new Error('opaque'); } } })).not.toThrow();
  });
});
