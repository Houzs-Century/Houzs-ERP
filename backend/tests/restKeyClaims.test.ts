/* docs/bugs/0824 — the staging Worker's SUPABASE_SERVICE_ROLE_KEY was not a
   service-role key, and nothing said so for three weeks. /health now reports
   the key's role claim; this pins the decoder. The keys below are hand-built
   JWT shapes with throwaway signatures — nothing real is embedded. */
import { describe, expect, it } from 'vitest';
import { restKeyClaims, restUrlRef } from '../src/db/rest-key-claims';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload: unknown) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;

describe('restKeyClaims', () => {
  it('reads role and ref off a service-role key', () => {
    expect(restKeyClaims(jwt({ iss: 'supabase', ref: 'minnapsemfzjmtvnnvdd', role: 'service_role' })))
      .toEqual({ role: 'service_role', ref: 'minnapsemfzjmtvnnvdd' });
  });

  it('names an anon key as anon — the shape that hid for three weeks', () => {
    expect(restKeyClaims(jwt({ ref: 'minnapsemfzjmtvnnvdd', role: 'anon' })).role).toBe('anon');
  });

  it('answers null for a missing, non-JWT or unreadable key rather than guessing', () => {
    expect(restKeyClaims(undefined)).toEqual({ role: null, ref: null });
    expect(restKeyClaims('not-a-jwt')).toEqual({ role: null, ref: null });
    expect(restKeyClaims('a.%%%.c')).toEqual({ role: null, ref: null });
    expect(restKeyClaims(jwt('just a string'))).toEqual({ role: null, ref: null });
  });

  it('never returns the key itself', () => {
    const k = jwt({ role: 'service_role', ref: 'abc' });
    const out = JSON.stringify(restKeyClaims(k));
    expect(out).not.toContain(k.split('.')[2]);
    expect(out).not.toContain(k.split('.')[1]);
  });
});

describe('restUrlRef', () => {
  it('extracts the project ref from a REST URL', () => {
    expect(restUrlRef('https://anogrigyjbduyzclzjgn.supabase.co')).toBe('anogrigyjbduyzclzjgn');
    expect(restUrlRef('https://minnapsemfzjmtvnnvdd.supabase.co/')).toBe('minnapsemfzjmtvnnvdd');
  });
  it('is null for anything else', () => {
    expect(restUrlRef(undefined)).toBeNull();
    expect(restUrlRef('https://example.com')).toBeNull();
  });
});
