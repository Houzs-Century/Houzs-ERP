// ----------------------------------------------------------------------------
// A line marked RM 0 on a NEW sales order was silently re-priced to full retail.
//
// `erpLineTrust` is the one helper that decides whether a 0 is believed. It was
// wired into the two LINE writes — `POST /:docNo/items` and
// `PATCH /:docNo/items/:itemId` — and NOT into SO CREATE, which computed a
// single per-REQUEST boolean (`!(await isPosTabletCaller(c))`) and passed the
// same value for every line. `zeroPriceIntended` was therefore never consulted
// on the create path at all, so:
//
//     desktop  new SO line at RM 0  -> reverted to catalogue
//     mobile   new SO line at RM 0  -> reverted to catalogue
//     desktop  existing line -> RM 0 -> stuck (the PATCH was wired)
//
// Staff marked a line free, the order was created, and the customer was
// invoiced for it. Editing the line afterwards fixed it only at the desk.
//
// This pins the WIRING, in the same idiom as operatorZeroPriceWiring: the
// failure mode is not a wrong verdict from the engine (that is covered in
// src/scm/lib/operator-zero-price.test.ts) — it is a code path that never asks.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import soRoutes from '../src/scm/routes/mfg-sales-orders.ts?raw';
import { erpLineTrust } from '../src/scm/lib/mfg-pricing-recompute';

/** Source with comments stripped — comments quote the shapes this forbids. */
const SO = soRoutes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('SO CREATE decides trust PER LINE, through the shared helper', () => {
  test('create no longer computes one boolean for the whole request', () => {
    // The exact shape of the defect: one value, computed once, handed to every
    // line's recompute — which cannot express "THIS line is deliberately free".
    expect(SO).not.toMatch(/const trustOperatorSelling = !\(await isPosTabletCaller\(c\)\)/);
  });

  test('create passes erpLineTrust with THIS line price and THIS line claim', () => {
    expect(SO).toMatch(
      /erpLineTrust\(createPosTablet, Number\(it\.unitPriceSen \?\? 0\), it\.zeroPriceIntended, false\)/,
    );
  });

  test('all THREE line-pricing paths now ask the same helper', () => {
    // create, add-line, line PATCH. A fourth path appearing without a call here
    // is the next instance of this bug, which is why the count is exact.
    expect(SO.match(/erpLineTrust\(/g) ?? []).toHaveLength(3);
  });

  test('the POS is still resolved ONCE for the create request, not once per line', () => {
    // isPosTabletCaller does I/O; moving it inside the per-line map would put a
    // lookup on every line of every order for a value that cannot vary within
    // one request. The binding is what the per-line call reads, so pin that it
    // is assigned exactly once and outside the map.
    expect(SO.match(/const createPosTablet = await isPosTabletCaller\(c\)/g) ?? []).toHaveLength(1);
    // ...and the per-line call READS that binding rather than re-awaiting.
    expect(SO).not.toMatch(/erpLineTrust\(\s*await/);
  });
});

describe('what the helper answers on the create path', () => {
  // The distinction the whole change exists to preserve. Asserted against the
  // real helper so this cannot drift from the engine's own reading.
  test('a claimed zero is believed; a bare zero is still "not provided"', () => {
    expect(erpLineTrust(false, 0, true)).toBe('operator-zero');
    expect(erpLineTrust(false, 0, undefined)).toBe(true);
    expect(erpLineTrust(false, 0, 'true')).toBe(true); // strict === true, no truthiness
  });

  test('a POS session can never reach the claimed-zero mode', () => {
    expect(erpLineTrust(true, 0, true)).toBe(false);
  });

  test('a real price needs no claim', () => {
    expect(erpLineTrust(false, 12345, undefined)).toBe(true);
  });
});
