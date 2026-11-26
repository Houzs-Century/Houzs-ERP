
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DataTable, type Column } from './DataTable';
import { setActiveCompanyId } from '../lib/activeCompany';

type Row = { id: number; name: string };
const rows: Row[] = [{ id: 1, name: 'r1' }];
const columns: Column<Row>[] = [
  { key: 'a', label: 'Alpha', render: (r) => r.name, getValue: (r) => r.name },
  { key: 'b', label: 'Bravo', render: (r) => r.name, getValue: (r) => r.name },
  { key: 'c', label: 'Charlie', render: (r) => r.name, getValue: (r) => r.name },
];

const TABLE = 'dt-company-key-test';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActiveCompanyId(null);
});
afterEach(() => {
  cleanup();
  setActiveCompanyId(null);
});

const renderTable = () =>
  render(<DataTable tableId={TABLE} rows={rows} columns={columns} getRowKey={(r) => r.id} />);

describe('DataTable layout survives the company resolving after mount', () => {
  it('picks up the company-scoped layout when the company arrives late', async () => {
    localStorage.setItem(`dt:hidden:c2:${TABLE}`, JSON.stringify(['b']));

    renderTable();
    expect(await screen.findByText('Bravo')).toBeTruthy();

    setActiveCompanyId(2);

    await waitFor(() => expect(screen.queryByText('Bravo')).toBeNull());
    expect(screen.queryByText('Alpha')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(`dt:hidden:c2:${TABLE}`)!)).toEqual(['b']);
  });

  it('switches tenants without leaking one company layout into the other', async () => {
    localStorage.setItem(`dt:hidden:c2:${TABLE}`, JSON.stringify(['b']));
    localStorage.setItem(`dt:hidden:c1:${TABLE}`, JSON.stringify(['c']));

    setActiveCompanyId(2);
    renderTable();
    await waitFor(() => expect(screen.queryByText('Bravo')).toBeNull());
    expect(screen.queryByText('Charlie')).toBeTruthy();

    setActiveCompanyId(1);
    await waitFor(() => expect(screen.queryByText('Charlie')).toBeNull());
    expect(screen.queryByText('Bravo')).toBeTruthy();
  });
});
