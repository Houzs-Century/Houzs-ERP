import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedBuildAxes, fillFromBuild } from './sofa-build-axes.mjs';

/* The rows HC-SO-013346 held after the 2026-09-14 apply (trace run 34844739166). */
const LEAD = { variants: { colourId: 'CH141-11', fabricId: 'CH141', specials: [], legHeight: 'Default',
  fabricCode: 'CH141-11', seatHeight: '35', colourLabel: 'CH141-11 SILVER', fabricLabel: 'CH141' } };
const ADDED = { variants: { seatHeight: '35' } };

test('an added piece takes its build\'s fabric and leg, and never its specials', () => {
  const shared = sharedBuildAxes([LEAD, ADDED]);
  const { variants, filled } = fillFromBuild(ADDED.variants, shared);
  assert.equal(variants.fabricCode, 'CH141-11');
  assert.equal(variants.colourLabel, 'CH141-11 SILVER');
  assert.equal(variants.fabricId, 'CH141');
  assert.equal(variants.colourId, 'CH141-11');
  assert.equal(variants.fabricLabel, 'CH141');
  assert.equal(variants.legHeight, 'Default');
  assert.equal(variants.seatHeight, '35');
  assert.equal('specials' in variants, false);
  assert.deepEqual(filled.sort(), ['colourId', 'colourLabel', 'fabricCode', 'fabricId', 'fabricLabel', 'legHeight']);
});

test('a piece with no row at all (an insert) is filled the same way', () => {
  const { variants } = fillFromBuild(undefined, sharedBuildAxes([LEAD]));
  assert.equal(variants.fabricCode, 'CH141-11');
});

test('a value a row already carries is never replaced', () => {
  const own = { fabricCode: 'X-1', colourLabel: 'X-1 RED', legHeight: '4"' };
  const { variants, filled } = fillFromBuild(own, sharedBuildAxes([LEAD, { variants: own }]));
  assert.equal(variants.fabricCode, 'X-1');
  assert.equal(variants.legHeight, '4"');
  assert.deepEqual(filled, []);
});

test('a two-tone build is left alone', () => {
  const other = { variants: { fabricCode: 'HR805-31', colourLabel: 'HR805-31' } };
  const shared = sharedBuildAxes([LEAD, other, ADDED]);
  assert.equal(shared.twoTone, true);
  assert.equal(shared.fabric, null);
  assert.equal(fillFromBuild(ADDED.variants, shared).variants.fabricCode, undefined);
});

test('two different legs are not chosen between', () => {
  const shared = sharedBuildAxes([LEAD, { variants: { legHeight: '6"' } }, ADDED]);
  assert.equal(shared.legHeight, null);
});

test('a build with no fabric anywhere fills nothing', () => {
  const { filled } = fillFromBuild(ADDED.variants, sharedBuildAxes([ADDED, { variants: {} }]));
  assert.deepEqual(filled, []);
});
