// Arrow keys on line editors (owner 2026-10-06): Up/Down = same column on the
// next/previous line, Left/Right = next/previous field once the caret is at the
// edge. Pins the table layout, the card layout, and every key the grid must
// leave alone.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { installLineGridNav } from './lineGridNav';

let uninstall: () => void;
beforeEach(() => { uninstall = installLineGridNav(document); });
afterEach(() => { uninstall(); document.body.innerHTML = ''; });

const press = (el: Element, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};
const $ = (sel: string) => document.querySelector(sel) as HTMLInputElement;

const table = () => {
  document.body.innerHTML = `
    <table><thead><tr><th>SKU</th><th>Bucket</th><th>Qty</th><th>Note</th></tr></thead><tbody>
      <tr><td><input id="sku1" list="dl"></td><td><select id="b1"><option>a</option><option>b</option></select></td>
          <td><input id="q1" type="number" value="1"></td><td><input id="n1" value="hello"></td></tr>
      <tr><td colspan="4"><select id="detail1"></select><input id="dq1"></td></tr>
      <tr><td><input id="sku2" list="dl"></td><td><select id="b2"><option>a</option></select></td>
          <td><input id="q2" type="number" value="2"></td><td><input id="n2"></td></tr>
    </tbody></table>`;
};

describe('table line editor', () => {
  test('Down from Qty lands on the next line Qty, skipping a full-width detail row', () => {
    table();
    $('#q1').focus();
    const e = press($('#q1'), 'ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('q2');
    press($('#q2'), 'ArrowUp');
    expect(document.activeElement?.id).toBe('q1');
  });

  test('a select moves rows instead of changing its value', () => {
    table();
    const b1 = document.querySelector('#b1') as HTMLSelectElement;
    b1.focus();
    press(b1, 'ArrowDown');
    expect(document.activeElement?.id).toBe('b2');
    expect(b1.value).toBe('a');
  });

  test('at the last line a number input does not step (key swallowed, focus stays)', () => {
    table();
    $('#q2').focus();
    const e = press($('#q2'), 'ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('q2');
  });

  test('Left/Right move between fields only at the caret edge', () => {
    table();
    const n1 = $('#n1');
    n1.focus();
    n1.setSelectionRange(2, 2);
    expect(press(n1, 'ArrowLeft').defaultPrevented).toBe(false);
    n1.setSelectionRange(0, 0);
    press(n1, 'ArrowLeft');
    expect(document.activeElement?.id).toBe('q1');
    press($('#q1'), 'ArrowRight');
    expect(document.activeElement?.id).toBe('n1');
  });

  test('a datalist input keeps Up/Down for its suggestions', () => {
    table();
    $('#sku1').focus();
    expect(press($('#sku1'), 'ArrowDown').defaultPrevented).toBe(false);
    expect(document.activeElement?.id).toBe('sku1');
  });

  test('modifiers, a handled key and an open combobox are left alone', () => {
    table();
    $('#q1').focus();
    expect(press($('#q1'), 'ArrowDown', { altKey: true }).defaultPrevented).toBe(false);
    expect(press($('#q1'), 'ArrowDown', { shiftKey: true }).defaultPrevented).toBe(false);
    $('#q1').setAttribute('aria-expanded', 'true');
    press($('#q1'), 'ArrowDown');
    expect(document.activeElement?.id).toBe('q1');
    $('#q1').removeAttribute('aria-expanded');
    const handled = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    handled.preventDefault();
    $('#q1').dispatchEvent(handled);
    expect(document.activeElement?.id).toBe('q1');
  });

  test('data-grid-off switches it off; a field outside a table body is untouched', () => {
    document.body.innerHTML = `<div data-grid-off><table><tbody>
      <tr><td><input id="a"></td></tr><tr><td><input id="b"></td></tr></tbody></table></div><input id="loose">`;
    $('#a').focus();
    press($('#a'), 'ArrowDown');
    expect(document.activeElement?.id).toBe('a');
    $('#loose').focus();
    expect(press($('#loose'), 'ArrowDown').defaultPrevented).toBe(false);
  });
});

describe('card line editor', () => {
  test('Down goes to the field with the same label on the next card', () => {
    document.body.innerHTML = `
      <div data-grid-row><label><span>Item</span><input id="i1"></label><label><span>Qty</span><input id="q1"></label></div>
      <div data-grid-row><label><span>Item</span><input id="i2"></label><label><span>Price</span><input id="p2"></label><label><span>Qty</span><input id="q2"></label></div>`;
    $('#q1').focus();
    press($('#q1'), 'ArrowDown');
    expect(document.activeElement?.id).toBe('q2');
  });

  test('aria-label columns ignore the line number ("Line 1 debit" = "Line 2 debit")', () => {
    document.body.innerHTML = `
      <div data-grid-row><input id="d1" aria-label="Line 1 debit"><input id="c1" aria-label="Line 1 credit"></div>
      <div data-grid-row><input id="d2" aria-label="Line 2 debit"><input id="c2" aria-label="Line 2 credit"></div>`;
    $('#c1').focus();
    press($('#c1'), 'ArrowDown');
    expect(document.activeElement?.id).toBe('c2');
  });
});
