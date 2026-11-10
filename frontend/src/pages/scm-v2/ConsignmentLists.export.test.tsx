/* Consignment Notes and Consignment Returns: Export writes every document the
 * list's status and search match, not the page on screen (Hookka #806 class;
 * Houzs issue #5459 row B2.4).
 *
 * Mounts the real pages with the paged hook faked to hold ONE row, while the
 * server, asked page by page, holds three across two pages. The network and the
 * sheet writer are the seams asserted. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const h = vi.hoisted(() => ({
  authed: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({})),
  aoa: [] as unknown[][],
  written: [] as string[],
  notify: vi.fn(async (..._a: unknown[]) => {}),
}));

vi.mock('../../vendor/scm/lib/authed-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/authed-fetch')>()),
  authedFetch: h.authed,
}));
vi.mock('../../lib/xlsx-runtime', () => ({
  utils: {
    aoa_to_sheet: (aoa: unknown[][]) => { h.aoa = aoa; return {}; },
    encode_cell: ({ r, c }: { r: number; c: number }) => `${c}:${r}`,
    book_new: () => ({}),
    book_append_sheet: () => {},
  },
  writeFileXLSX: (_wb: unknown, name: string) => { h.written.push(name); },
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, permissions: ['*'] }, can: () => true, pageAccess: () => 'edit' }),
}));
vi.mock('../../auth/salesAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/salesAccess')>()),
  canViewScmCosting: () => false,
}));
vi.mock('../../vendor/scm/lib/admin-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/admin-queries')>()),
  useStaff: () => ({ data: [], isLoading: false, error: null }),
}));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => h.notify }));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => vi.fn() }));

const pagedResult = (key: string, row: Record<string, unknown>) => ({
  data: { [key]: [row], total: 3, page: 0, pageSize: 1, aggregates: { revenueSen: 0 } },
  isLoading: false, isFetching: false, isPlaceholderData: false, error: null,
});

const note = (id: string, debtor: string) => ({
  id, do_number: `HC-CN-2611-00${id}`, do_date: '2026-11-01', debtor_code: 'C001', debtor_name: debtor,
  status: 'DISPATCHED', currency: 'MYR', local_total_sen: 100000, salesperson_id: null, has_children: false,
});
const ret = (id: string, debtor: string) => ({
  id, return_number: `HC-CR-2611-00${id}`, do_doc_no: 'HC-CN-2611-001', return_date: '2026-11-02',
  debtor_code: 'C001', debtor_name: debtor, status: 'RECEIVED', currency: 'MYR', local_total_sen: 50000, salesperson_id: null,
});
const NOTES = [note('1', 'Alpha'), note('2', 'Bravo'), note('3', 'Charlie')];
const RETURNS = [ret('1', 'Alpha'), ret('2', 'Bravo'), ret('3', 'Charlie')];

vi.mock('../../vendor/scm/lib/consignment-note-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/consignment-note-queries')>()),
  useConsignmentNotesPaged: () => pagedResult('deliveryOrders', NOTES[0]!),
  useConsignmentNoteDetail: () => ({ data: undefined, isLoading: false, error: null }),
  useUpdateConsignmentNoteStatus: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../vendor/scm/lib/consignment-return-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/consignment-return-queries')>()),
  useConsignmentReturnsPaged: () => pagedResult('deliveryReturns', RETURNS[0]!),
  useConsignmentReturnDetail: () => ({ data: undefined, isLoading: false, error: null }),
  useUpdateConsignmentReturnStatus: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { ConsignmentNotes } from './ConsignmentNotes';
import { ConsignmentReturns } from './ConsignmentReturns';

/* The server answers the paged contract: 0-based `page`, `pageSize` clamped to
   200 — here 2 per page, so three documents take two requests. */
const serve = (route: string, key: string, all: unknown[]) => async (path: string) => {
  if (!path.startsWith(`${route}?`)) return {};
  const p = new URL(path, 'http://x').searchParams;
  const page = Number(p.get('page'));
  const size = 2;
  return { [key]: all.slice(page * size, page * size + size), total: all.length, page, pageSize: size };
};

const mount = (ui: ReactElement, url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

const exportNow = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^Export$/ }));
  await waitFor(() => expect(h.written).toHaveLength(1));
  const [header, ...body] = h.aoa as [string[], ...unknown[][]];
  return { body, col: (label: string) => body.map((r) => r[header.indexOf(label)]) };
};

const listCalls = (route: string) =>
  h.authed.mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith(`${route}?`))
    .map((p) => new URL(p, 'http://x').searchParams);

beforeEach(() => {
  h.aoa = [];
  h.written = [];
  h.notify.mockClear();
  h.authed.mockReset();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const cases = [
  { name: 'Consignment Notes', ui: <ConsignmentNotes />, url: '/scm/consignment-notes', route: '/consignment-notes', key: 'deliveryOrders', all: NOTES, search: /Search note no/, file: /^Consignment Notes-\d{4}-\d{2}-\d{2}\.xlsx$/ },
  { name: 'Consignment Returns', ui: <ConsignmentReturns />, url: '/scm/consignment-returns', route: '/consignment-returns', key: 'deliveryReturns', all: RETURNS, search: /Search return no/, file: /^Consignment Returns-\d{4}-\d{2}-\d{2}\.xlsx$/ },
];

describe.each(cases)('$name list Export', ({ ui, url, route, key, all, search, file }) => {
  it('writes every document the server holds, not the one row on screen', async () => {
    h.authed.mockImplementation(serve(route, key, all));
    mount(ui, url);
    const { body, col } = await exportNow();
    expect(body).toHaveLength(3);
    expect(col('Customer')).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(listCalls(route).map((p) => p.get('page'))).toEqual(['0', '1']);
    expect(h.written[0]).toMatch(file);
  });

  it("asks with the list's status and search", async () => {
    h.authed.mockImplementation(serve(route, key, all));
    mount(ui, `${url}?status=CANCELLED`);
    fireEvent.change(screen.getByPlaceholderText(search), { target: { value: 'Bravo' } });
    // the page debounces its search box by 300 ms before the term reaches the query
    await new Promise((r) => setTimeout(r, 400));
    await exportNow();
    expect(listCalls(route)[0]?.get('q')).toBe('Bravo');
    for (const p of listCalls(route)) expect(p.get('status')).toBe('CANCELLED');
  });

  it('a failed read writes no file and tells the operator', async () => {
    h.authed.mockImplementation(async (path: string) => {
      if (path.startsWith(`${route}?`)) throw new Error('load_failed');
      return {};
    });
    mount(ui, url);
    fireEvent.click(screen.getByRole('button', { name: /^Export$/ }));
    await waitFor(() => expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Export failed', tone: 'error' })));
    expect(h.written).toHaveLength(0);
  });
});
