// The grid's layout key is company-scoped, and the company is not known at
// first paint. This pins the re-read that makes that survivable.
//
// THE DEFECT (owner 2026-08-19: "Delivery Planning 一直会自动 reset layout").
// `storedLayout` is seeded by `useState(() => readDataGridLayout(scopedStorageKey…))`,
// whose initialiser runs ONCE, at mount. `scopedStorageKey` is
// `dg-<key>::c<company>` — and the active company is resolved AFTER mount:
// `adoptActiveCompanyForUser` runs when /auth/me returns and, on a tab with no
// `?company=` seed, flips it from null to the user's durable pick and emits.
//
// So the grid READ the unscoped `dg-<key>` (usually empty → default columns)
// while every later WRITE went to `dg-<key>::c<company>`. The arrangement was
// saved correctly the whole time, under a key nothing ever read back — which
// looks exactly like "it resets itself every time I open the page".
//
// It shows worst on Delivery Planning because that page lists both tenants, but
// the bug is in DataGrid and therefore on every grid in the app.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DataGrid, type DataGridColumn } from './DataGrid';
import { setActiveCompanyId } from '../../../lib/activeCompany';

vi.mock('../../../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

type Row = { id: number; name: string };
const rows: Row[] = [{ id: 1, name: 'r1' }];
const columns: DataGridColumn<Row>[] = [
  { key: 'a', label: 'Alpha', accessor: (r) => r.name },
  { key: 'b', label: 'Bravo', accessor: (r) => r.name },
  { key: 'c', label: 'Charlie', accessor: (r) => r.name },
];

const STORAGE = 'dg-test-grid';
/** The shape readDataGridLayout expects: one JSON blob per grid key. */
const saveLayout = (key: string, hidden: string[]) =>
  localStorage.setItem(key, JSON.stringify({ order: [], hidden, shown: [], widths: {}, pinned: [], groupBy: [] }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActiveCompanyId(null);
});
afterEach(() => {
  cleanup();
  setActiveCompanyId(null);
});

const renderGrid = () =>
  render(<DataGrid rows={rows} columns={columns} storageKey={STORAGE} rowKey={(r) => String(r.id)} />);

describe('DataGrid layout survives the company resolving after mount', () => {
  it('picks up the company-scoped layout when the company arrives late', async () => {
    // The user's real arrangement, saved under the SCOPED key on a previous
    // visit: Bravo hidden.
    saveLayout(`${STORAGE}::c2`, ['b']);

    // Mount with NO company resolved — this is the first paint the bug hit.
    renderGrid();
    expect(await screen.findByText('Bravo')).toBeTruthy();

    // /auth/me lands and adopts the company. Before the fix, nothing re-read
    // and Bravo stayed visible: the layout "reset" on every open.
    setActiveCompanyId(2);

    await waitFor(() => expect(screen.queryByText('Bravo')).toBeNull());
    expect(screen.queryByText('Alpha')).toBeTruthy();
  });

  it('switches tenants without leaking one company layout into the other', async () => {
    saveLayout(`${STORAGE}::c2`, ['b']);   // 2990 hides Bravo
    saveLayout(`${STORAGE}::c1`, ['c']);   // Houzs hides Charlie

    setActiveCompanyId(2);
    renderGrid();
    await waitFor(() => expect(screen.queryByText('Bravo')).toBeNull());
    expect(screen.queryByText('Charlie')).toBeTruthy();

    setActiveCompanyId(1);
    await waitFor(() => expect(screen.queryByText('Charlie')).toBeNull());
    expect(screen.queryByText('Bravo')).toBeTruthy();
  });

  it('does not re-read while the key is unchanged', async () => {
    // A same-key re-render must not clobber what the user just did on screen;
    // the guard is the key, not the render count.
    setActiveCompanyId(2);
    saveLayout(`${STORAGE}::c2`, ['b']);
    const { rerender } = renderGrid();
    await waitFor(() => expect(screen.queryByText('Bravo')).toBeNull());

    // Storage changes behind the grid's back — no key change, so no re-read.
    saveLayout(`${STORAGE}::c2`, []);
    rerender(<DataGrid rows={rows} columns={columns} storageKey={STORAGE} rowKey={(r) => String(r.id)} />);
    expect(screen.queryByText('Bravo')).toBeNull();
  });
});
