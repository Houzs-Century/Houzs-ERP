/* The handoff that makes "add a line" findable from the page you start on.
 *
 * The owner could not find it on a goods receipt: the detail page said nothing
 * about lines, and the affordance only appeared after pressing Edit, under a
 * fourth different name ("Add manual item" / "Add item" / "+ Add Line Item").
 */
import { describe, it, expect } from 'vitest';
import {
  ADD_LINE_HASH, ADD_LINE_LABEL, addLineHref, wantsAddLine, consumedAddLine,
} from './add-line-handoff';

describe('addLineHref', () => {
  it('opens the editor at the add row', () => {
    expect(addLineHref('/scm/grns/abc')).toBe('/scm/grns/abc?edit=1#add-line');
  });

  it('keeps a query the detail page was already carrying', () => {
    /* A detail page can hold a tab or a return-to; dropping it loses the
       operator's place on the way back. */
    expect(addLineHref('/scm/grns/abc?from=list')).toBe('/scm/grns/abc?from=list&edit=1#add-line');
  });

  it('does not stack a second edit flag when one is already there', () => {
    expect(addLineHref('/scm/grns/abc?edit=1')).toBe('/scm/grns/abc?edit=1#add-line');
  });

  it('ignores a fragment the caller happened to pass in', () => {
    expect(addLineHref('/scm/grns/abc#lines')).toBe('/scm/grns/abc?edit=1#add-line');
  });
});

describe('wantsAddLine', () => {
  it('recognises the intent from a full location or from the bare hash', () => {
    expect(wantsAddLine('/scm/grns/abc?edit=1#add-line')).toBe(true);
    expect(wantsAddLine(ADD_LINE_HASH)).toBe(true);
  });

  it('is false for every other fragment, and for none at all', () => {
    expect(wantsAddLine('/scm/grns/abc?edit=1')).toBe(false);
    expect(wantsAddLine('/scm/grns/abc#lines')).toBe(false);
    expect(wantsAddLine('#add-line-item')).toBe(false);
    expect(wantsAddLine('')).toBe(false);
    expect(wantsAddLine(null)).toBe(false);
    expect(wantsAddLine(undefined)).toBe(false);
  });
});

describe('consumedAddLine', () => {
  it('drops the fragment so the intent fires ONCE', () => {
    /* Left on the URL it re-opens the add row on every remount, which on a page
       that remounts after a save is a form that will not stay shut. */
    expect(consumedAddLine('/scm/grns/abc?edit=1#add-line')).toBe('/scm/grns/abc?edit=1');
  });

  it('leaves a location that never carried one alone', () => {
    expect(consumedAddLine('/scm/grns/abc?edit=1')).toBe('/scm/grns/abc?edit=1');
  });
});

describe('one name', () => {
  it('is the word every page uses now', () => {
    expect(ADD_LINE_LABEL).toBe('Add line');
  });
});
