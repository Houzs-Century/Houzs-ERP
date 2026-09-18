/* EVERY ADDRESS FORM PICKS ITS STATE, CITY AND POSTCODE FROM THE SAME LISTS.
 *
 * The owner, 2026-09-14, on the Delivery Order convert screen: the State, City
 * and Postcode boxes were free text while the Sales Order form offers them as
 * dropdowns — 「它应该跟 Sales Order 的方法一样，是 dropdown 的格式」.
 * DeliveryOrderNewV2 was the only document form left that way; nothing noticed,
 * because each form wires the shared cascade by hand.
 *
 * This scans every form that labels both a State and a Postcode field and
 * requires the shared StatePicker. A form that shows those words for another
 * reason is listed in NOT_AN_ADDRESS_FORM with why.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const findSrc = (): string => {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, 'frontend/src');
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`frontend/src not found above ${process.cwd()}`);
};
const SRC = findSrc();
const ROOTS = ['pages/scm-v2', 'mobile', 'vendor/scm/components'];

const NOT_AN_ADDRESS_FORM = new Map<string, string>([
  ['pages/scm-v2/SalesOrderMaintenance.tsx', 'the CRUD screen that EDITS the locality lists themselves'],
  ['vendor/scm/components/NewDpOrderDrawer.tsx', 'shows a carried address read-only; nothing is typed'],
]);

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  if (statSync(p).isDirectory()) return walk(p);
  return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [p] : [];
});

const STATE_LABEL = /(text="State"|>State<)/;
const POSTCODE_LABEL = /(text="Postcode"|>Postcode<|<AddressPostcodeField\b)/;

const forms = ROOTS.flatMap((r) => walk(join(SRC, r)))
  .map((p) => ({ rel: relative(SRC, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }))
  .filter((f) => STATE_LABEL.test(f.text) && POSTCODE_LABEL.test(f.text));

describe('address forms use the shared State picker', () => {
  it('finds the address forms — a scan that matches nothing must not pass', () => {
    expect(forms.map((f) => f.rel)).toContain('pages/scm-v2/DeliveryOrderNewV2.tsx');
    expect(forms.length).toBeGreaterThan(8);
  });

  it('every address form picks State from StatePicker, never a free-text box', () => {
    const missing = forms
      .filter((f) => !NOT_AN_ADDRESS_FORM.has(f.rel))
      .filter((f) => !/<StatePicker\b/.test(f.text))
      .map((f) => f.rel);
    expect(missing).toEqual([]);
  });

  it('the Delivery Order form runs the same State -> City -> Postcode cascade as the Sales Order', () => {
    const doForm = forms.find((f) => f.rel === 'pages/scm-v2/DeliveryOrderNewV2.tsx')!;
    expect(doForm.text).toMatch(/useAddressCascade\(/);
    expect(doForm.text).toMatch(/pickCity\(/);
    expect(doForm.text).toMatch(/pickPostcode\(/);
  });

  it('the Delivery Order address uses the SAME widgets as the Sales Order — searchable City, the shared Postcode field', () => {
    /* Owner 2026-09-14: 「一定要跟 Sales Order 一模一样」. Same functions is not
       enough if the boxes behave differently: the order form's City is typeable
       and its Postcode is the shared field (searchable, with the Singapore lookup). */
    const so = forms.find((f) => f.rel === 'pages/scm-v2/SalesOrderNew.tsx');
    const doForm = forms.find((f) => f.rel === 'pages/scm-v2/DeliveryOrderNewV2.tsx')!;
    for (const widget of ['<StatePicker', '<SearchableSelect', '<AddressPostcodeField']) {
      if (so) expect(so.text, `SalesOrderNew no longer uses ${widget} — update this test`).toContain(widget);
      expect(doForm.text, `DeliveryOrderNewV2 must use ${widget} like the Sales Order`).toContain(widget);
    }
  });

  it('every exemption is still a form the scan finds — the list cannot rot', () => {
    const found = new Set(forms.map((f) => f.rel));
    expect([...NOT_AN_ADDRESS_FORM.keys()].filter((k) => !found.has(k))).toEqual([]);
  });
});
