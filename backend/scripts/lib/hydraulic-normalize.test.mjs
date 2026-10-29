/**
 * The spelling rules behind normalize-houzs-hydraulic.mjs, pinned.
 *
 * The whole point of the repair is that it touches ONLY the hydraulic token and
 * ONLY its casing — never another special, never a non-hydraulic word in a
 * description, never a bucket-moving change. These tests hold that line:
 *   · a bare hydraulic token (any case) becomes "Hydraulic";
 *   · "Power Hydraulic" and "hydraulics" are left alone;
 *   · a second hydraulic entry collapses, order and other entries survive;
 *   · description2 changes by exactly one word, with a word boundary so a glued
 *     token is skipped.
 *
 * node:test, zero deps, same as the sibling scripts/lib/*.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HYD_TARGET,
  isBareHydraulic,
  normalizeSpecialsArray,
  normalizeVariantsHydraulic,
  properHydraulicText,
} from './hydraulic-normalize.mjs';

test('isBareHydraulic — any case / trimmed is bare; compounds are not', () => {
  assert.equal(isBareHydraulic('hydraulic'), true);
  assert.equal(isBareHydraulic('HYDRAULIC'), true);
  assert.equal(isBareHydraulic('Hydraulic'), true);
  assert.equal(isBareHydraulic('  Hydraulic  '), true);
  assert.equal(isBareHydraulic('Power Hydraulic'), false);
  assert.equal(isBareHydraulic('hydraulics'), false);
  assert.equal(isBareHydraulic(''), false);
  assert.equal(isBareHydraulic(null), false);
  assert.equal(isBareHydraulic(42), false);
});

test('normalizeSpecialsArray — bare token to Hydraulic, order and others kept', () => {
  assert.deepEqual(
    normalizeSpecialsArray(['Nylon Fabric', 'HYDRAULIC', 'Wooden Arm']),
    { next: ['Nylon Fabric', 'Hydraulic', 'Wooden Arm'], changed: true },
  );
  assert.deepEqual(
    normalizeSpecialsArray(['hydraulic']),
    { next: ['Hydraulic'], changed: true },
  );
});

test('normalizeSpecialsArray — already proper is a no-op', () => {
  assert.deepEqual(
    normalizeSpecialsArray(['Hydraulic', 'Nylon Fabric']),
    { next: ['Hydraulic', 'Nylon Fabric'], changed: false },
  );
});

test('normalizeSpecialsArray — a duplicate hydraulic collapses to one', () => {
  assert.deepEqual(
    normalizeSpecialsArray(['hydraulic', 'Hydraulic']),
    { next: ['Hydraulic'], changed: true },
  );
  assert.deepEqual(
    normalizeSpecialsArray(['HYDRAULIC', 'Nylon Fabric', 'hydraulic']),
    { next: ['Hydraulic', 'Nylon Fabric'], changed: true },
  );
});

test('normalizeSpecialsArray — Power Hydraulic is left alone', () => {
  assert.deepEqual(
    normalizeSpecialsArray(['Power Hydraulic']),
    { next: ['Power Hydraulic'], changed: false },
  );
});

test('normalizeSpecialsArray — non-array passes through', () => {
  assert.deepEqual(normalizeSpecialsArray(null), { next: null, changed: false });
  assert.deepEqual(normalizeSpecialsArray('hydraulic'), { next: 'hydraulic', changed: false });
});

test('normalizeVariantsHydraulic — fixes specials, preserves every other key', () => {
  const r = normalizeVariantsHydraulic({
    fabricCode: 'BF-01',
    divanHeight: '12"',
    specials: ['hydraulic'],
  });
  assert.equal(r.changed, true);
  assert.deepEqual(r.next, { fabricCode: 'BF-01', divanHeight: '12"', specials: ['Hydraulic'] });
});

test('normalizeVariantsHydraulic — legacy singular, recorded and labels', () => {
  const r = normalizeVariantsHydraulic({
    special: 'HYDRAULIC',
    specialsRecorded: ['hydraulic'],
    specialLabels: ['HYDRAULIC', 'Nylon Fabric'],
  });
  assert.equal(r.changed, true);
  assert.deepEqual(r.next, {
    special: 'Hydraulic',
    specialsRecorded: ['Hydraulic'],
    specialLabels: ['Hydraulic', 'Nylon Fabric'],
  });
});

test('normalizeVariantsHydraulic — specialChoices key is renamed and merged', () => {
  const r = normalizeVariantsHydraulic({
    specials: ['hydraulic'],
    specialChoices: { HYDRAULIC: ['x'] },
  });
  assert.equal(r.changed, true);
  assert.deepEqual(r.next.specialChoices, { Hydraulic: ['x'] });
});

test('normalizeVariantsHydraulic — nothing to do is a no-op', () => {
  const v = { fabricCode: 'BF-01', specials: ['Hydraulic', 'Nylon Fabric'] };
  const r = normalizeVariantsHydraulic(v);
  assert.equal(r.changed, false);
  assert.deepEqual(r.next, v);
});

test('normalizeVariantsHydraulic — null / array variants pass through', () => {
  assert.deepEqual(normalizeVariantsHydraulic(null), { next: null, changed: false });
  assert.deepEqual(normalizeVariantsHydraulic(['x']), { next: ['x'], changed: false });
});

test('properHydraulicText — whole-word case fix, nothing else moves', () => {
  assert.deepEqual(
    properHydraulicText('DIVAN 12" / SPECIAL: HYDRAULIC'),
    { next: 'DIVAN 12" / SPECIAL: Hydraulic', changed: true },
  );
  assert.deepEqual(
    properHydraulicText('DIV 12" hydraulic'),
    { next: 'DIV 12" Hydraulic', changed: true },
  );
});

test('properHydraulicText — already proper, empty, and a glued token are untouched', () => {
  assert.deepEqual(
    properHydraulicText('SPECIAL: Hydraulic'),
    { next: 'SPECIAL: Hydraulic', changed: false },
  );
  assert.deepEqual(properHydraulicText(''), { next: '', changed: false });
  // No boundary after "hydraulic" -> left as is.
  assert.deepEqual(
    properHydraulicText('Hydraulic2pcs'),
    { next: 'Hydraulic2pcs', changed: false },
  );
});

test('HYD_TARGET is the proper spelling', () => {
  assert.equal(HYD_TARGET, 'Hydraulic');
});
