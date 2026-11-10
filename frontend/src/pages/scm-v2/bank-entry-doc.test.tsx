// The orders an entry names, one click away from the bank reconciliation (owner
// 2026-11-10, 2990 October, Not on the bank yet: 我希望这里也可以点开so, 点开后也可以返回
// 这里). The entry's document reads as the server names it — "OR · SO" for a customer's
// payment, "SO ← SO" for money moved off a cancelled order — and each order number in
// it opens the whole order in its own tab, the way Merchant Recon's do; the receipt,
// the voucher and a payment key stay text. A plain click notes where the page was, so
// the order's Back lands on the same spot; a Ctrl-click is a browser window and leaves
// this page as it is.

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

const opened = vi.hoisted(() => ({ intents: [] as boolean[] }));
vi.mock('../../lib/workspaceTabs', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  markWorkspaceOpenIntent: (doc: boolean) => { opened.intents.push(doc); },
}));

import { EntryDocument, entryDocText, orderLinkParts } from './bank-entry-doc';
import { RETURN_SCROLL_KEY } from '../../lib/returnScroll';

afterEach(() => {
  sessionStorage.clear();
  opened.intents = [];
});

describe("the orders in an entry's document", () => {
  test('an order number is a door; a receipt, a voucher or a payment key is not', () => {
    expect(orderLinkParts('2990-DraftOR-2610-019 · 2990-SO-2609-016')).toEqual([
      { text: '2990-DraftOR-2610-019', order: false }, { text: ' · ', order: false }, { text: '2990-SO-2609-016', order: true },
    ]);
    expect(orderLinkParts('HC-SO-013512')).toEqual([{ text: 'HC-SO-013512', order: true }]);
    /* Money moved off a cancelled order names both orders. */
    expect(orderLinkParts('2990-SO-2611-019 ← 2990-SO-2609-003').filter((p) => p.order).map((p) => p.text))
      .toEqual(['2990-SO-2611-019', '2990-SO-2609-003']);
    expect(orderLinkParts('2990-HPV-2610-026').some((p) => p.order)).toBe(false);
    expect(orderLinkParts('2990-HOR-2610-057 · 2990-SO-2611-019').map((p) => p.order)).toEqual([false, false, true]);
    expect(orderLinkParts('SOPAY · 0bb232ad-1c2d-4e5f-8a9b-0123456789ab').some((p) => p.order)).toBe(false);
  });

  test("the text is the entry's reference, else its source and document, else a dash", () => {
    expect(entryDocText({ reference: 'OR-1 · 2990-SO-2609-016', sourceType: 'SOPAY', sourceDocNo: 'x' })).toBe('OR-1 · 2990-SO-2609-016');
    expect(entryDocText({ reference: null, sourceType: 'PV', sourceDocNo: '2990-HPV-2610-026' })).toBe('PV · 2990-HPV-2610-026');
    expect(entryDocText({ sourceType: null, sourceDocNo: null })).toBe('—');
  });
});

describe('opening the order', () => {
  test('opens the whole order in its own tab, noting where the page was so its Back lands here', () => {
    render(<MemoryRouter><EntryDocument text="2990-DraftOR-2610-019 · 2990-SO-2609-016" /></MemoryRouter>);
    const link = screen.getByRole('link', { name: '2990-SO-2609-016' });
    expect(link.getAttribute('href')).toBe('/scm/sales-orders/2990-SO-2609-016');
    expect(screen.queryByRole('link', { name: '2990-DraftOR-2610-019' })).toBeNull();
    expect(screen.getByText('2990-DraftOR-2610-019', { exact: false })).toBeTruthy();
    fireEvent.click(link);
    expect(opened.intents).toEqual([true]);
    expect(Object.keys(JSON.parse(sessionStorage.getItem(RETURN_SCROLL_KEY) ?? '{}') as object))
      .toEqual([`${window.location.pathname}${window.location.search}`]);
  });

  test('a Ctrl-click opens a browser window and leaves this page as it is', () => {
    render(<MemoryRouter><EntryDocument text="2990-SO-2609-016" /></MemoryRouter>);
    /* The browser would open the window; jsdom cannot, so its default stops here. */
    document.addEventListener('click', (e) => e.preventDefault(), { once: true, capture: true });
    fireEvent.click(screen.getByRole('link', { name: '2990-SO-2609-016' }), { ctrlKey: true });
    expect(opened.intents).toEqual([]);
    expect(sessionStorage.getItem(RETURN_SCROLL_KEY)).toBeNull();
  });
});
