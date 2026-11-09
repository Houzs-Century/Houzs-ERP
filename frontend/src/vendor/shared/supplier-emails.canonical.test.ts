import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkSupplierEmail, resolvePoRecipients, supplierEmailList } from './supplier-emails';

/* A supplier's three emails (owner 2026-11-09) have ONE rule and two copies:
 * backend/src/scm/shared/supplier-emails.ts is what the supplier save refuses on
 * and what the PO send addresses, and this one is what the PO page's confirm
 * names before the send. If they drift, the confirm lists addresses the email
 * does not go to. */
describe('the two copies of supplier-emails are the same file', () => {
  const norm = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

  test('backend/src/scm/shared/supplier-emails.ts is byte-identical to this one', () => {
    expect(norm('../backend/src/scm/shared/supplier-emails.ts')).toBe(norm('src/vendor/shared/supplier-emails.ts'));
  });
});

describe('supplier emails', () => {
  test('To is Email, Cc is Email 2 and Email 3', () => {
    expect(resolvePoRecipients({ email: 'a@x.com', email2: 'b@x.com', email3: 'c@x.com' })).toEqual({ ok: true, to: 'a@x.com', cc: ['b@x.com', 'c@x.com'] });
  });

  test('a repeat in any case goes once; an invalid Email 2/3 is skipped', () => {
    expect(resolvePoRecipients({ email: 'a@x.com', email2: ' A@X.com ', email3: 'not-an-address' })).toEqual({ ok: true, to: 'a@x.com', cc: [] });
  });

  test('Email blank: the first valid of Email 2 / Email 3 becomes To', () => {
    expect(resolvePoRecipients({ email: '  ', email2: 'bad@', email3: 'c@x.com' })).toEqual({ ok: true, to: 'c@x.com', cc: [] });
  });

  test('nothing usable: no address, or the bad one named', () => {
    expect(resolvePoRecipients({ email: null })).toEqual({ ok: false, error: 'no_supplier_email' });
    expect(resolvePoRecipients(null)).toEqual({ ok: false, error: 'no_supplier_email' });
    expect(resolvePoRecipients({ email: 'a@b', email2: 'b@x.com' })).toEqual({ ok: false, error: 'bad_supplier_email', address: 'a@b' });
    expect(resolvePoRecipients({ email2: 'x y@z.com' })).toEqual({ ok: false, error: 'bad_supplier_email', address: 'x y@z.com' });
  });

  test('display list keeps order, drops blanks and repeats', () => {
    expect(supplierEmailList({ email: 'a@x.com', email2: '', email3: 'A@x.com' })).toEqual(['a@x.com']);
    expect(supplierEmailList({ email2: 'b@x.com', email3: 'c@x.com' })).toEqual(['b@x.com', 'c@x.com']);
  });

  test('save check: trimmed, blank clears, one valid address or a refusal naming the field', () => {
    expect(checkSupplierEmail('  b@x.com ', 'Email 2')).toEqual({ ok: true, value: 'b@x.com' });
    expect(checkSupplierEmail('   ', 'Email 2')).toEqual({ ok: true, value: null });
    const bad = checkSupplierEmail('a@x.com, b@x.com', 'Email 3');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('Email 3');
  });
});
