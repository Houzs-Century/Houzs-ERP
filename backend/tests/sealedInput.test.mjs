/**
 * A script input sealed for the public log (sealed-input.mjs): what is sealed
 * opens only with the secret it was sealed for, and only unchanged.
 *
 * NO SHEBANG — a test-imported module must not carry one (CLAUDE.md).
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { seal, sealingKeyOf, unseal } from '../scripts/lib/sealed-input.mjs';

const SECRET = 'postgres://app:not-a-real-password@db.example.test:5432/app';
const LABEL = 'a-script';
const TEXT = 'HC-SO-2610-001:800,HC-SO-2610-002:-250.50';

test('the sealing key is 64 hex characters, the same each time for a secret and a label', () => {
  const key = sealingKeyOf(SECRET, LABEL);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(sealingKeyOf(SECRET, LABEL), key);
  assert.notEqual(sealingKeyOf(SECRET, 'another-script'), key);
  assert.notEqual(sealingKeyOf(`${SECRET}x`, LABEL), key);
  assert.throws(() => sealingKeyOf('', LABEL), /no secret/);
});

test('a text sealed to the key opens with the secret, and reads nowhere in what travels', () => {
  const sealed = seal(sealingKeyOf(SECRET, LABEL), TEXT);
  assert.match(sealed, /^[0-9a-f]+$/);
  assert.equal(unseal(SECRET, LABEL, sealed), TEXT);
  assert.equal(unseal(SECRET, LABEL, `  ${sealed.toUpperCase()}\n`), TEXT);
  assert.equal(Buffer.from(sealed, 'hex').toString('latin1').includes('800'), false);
  /* Sealed twice, it travels as two different texts. */
  assert.notEqual(seal(sealingKeyOf(SECRET, LABEL), TEXT), sealed);
  assert.equal(unseal(SECRET, LABEL, seal(sealingKeyOf(SECRET, LABEL), 'RM 1 — 一')), 'RM 1 — 一');
});

test('it does not open with another secret, for another script, or once changed', () => {
  const sealed = seal(sealingKeyOf(SECRET, LABEL), TEXT);
  assert.throws(() => unseal(`${SECRET}x`, LABEL, sealed), /does not open/);
  assert.throws(() => unseal(SECRET, 'another-script', sealed), /does not open/);
  const last = sealed.slice(-1) === '0' ? '1' : '0';
  assert.throws(() => unseal(SECRET, LABEL, `${sealed.slice(0, -1)}${last}`), /does not open/);
});

test('what is not a sealed input, or not a sealing key, is refused', () => {
  assert.throws(() => unseal(SECRET, LABEL, TEXT), /not a sealed input/);
  assert.throws(() => unseal(SECRET, LABEL, 'abcd'), /not a sealed input/);
  assert.throws(() => unseal(SECRET, LABEL, ''), /not a sealed input/);
  assert.throws(() => seal('abcd', TEXT), /64 hex/);
  assert.throws(() => seal(TEXT, TEXT), /64 hex/);
});
