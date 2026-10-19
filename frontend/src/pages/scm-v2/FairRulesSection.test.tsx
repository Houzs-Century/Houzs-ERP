/* SO Maintenance › Fair rules (owner 2026-10-19): "Venue differs" on a scanned
 * order is a flag until the owner or Finance switches it to stop Confirm.
 *
 *   - no row yet reads as the default, Flag only;
 *   - the owner / Finance can switch it, and the switch is what is sent;
 *   - anyone else sees it but cannot change it;
 *   - a list that failed to load says so instead of showing the default.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ settings: [] as unknown[] | Error, perms: new Set<string>() }));

vi.mock('../../vendor/scm/lib/authed-fetch', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/authed-fetch')>()),
  authedFetch: vi.fn((path: string, init?: { method?: string; body?: string }) => {
    if (path === '/so-settings') {
      return state.settings instanceof Error ? Promise.reject(state.settings) : Promise.resolve({ settings: state.settings });
    }
    if (init?.method === 'PATCH') return Promise.resolve({ setting: { key: 'fair_venue_differs_blocks', ...JSON.parse(init.body ?? '{}') } });
    return new Promise(() => undefined);
  }),
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: (p: string) => state.perms.has('*') || state.perms.has(p) }),
}));

import { FairRulesSection } from './FairRulesSection';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';

afterEach(() => { vi.mocked(authedFetch).mockClear(); state.settings = []; state.perms = new Set(); });

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <FairRulesSection />
  </QueryClientProvider>,
);
const radio = (name: RegExp) => screen.getByRole('radio', { name }) as HTMLInputElement;

describe('Fair rules — "Venue differs" (owner 2026-10-19)', () => {
  it('no row yet is the default: Flag only', async () => {
    state.perms = new Set(['scm.finance.accounting']);
    mount();
    await waitFor(() => expect(radio(/Flag only/).disabled).toBe(false));
    expect(radio(/Flag only/).checked).toBe(true);
    expect(radio(/Stop Confirm/).checked).toBe(false);
  });

  it('Finance switches it to Stop Confirm, and that is what is sent', async () => {
    state.perms = new Set(['scm.finance.accounting']);
    mount();
    await waitFor(() => expect(radio(/Stop Confirm/).disabled).toBe(false));
    fireEvent.click(radio(/Stop Confirm/));
    await waitFor(() => expect(vi.mocked(authedFetch).mock.calls.some(([p]) => p === '/so-settings/fair_venue_differs_blocks')).toBe(true));
    const call = vi.mocked(authedFetch).mock.calls.find(([p]) => p === '/so-settings/fair_venue_differs_blocks')!;
    expect(JSON.parse(String((call[1] as { body: string }).body))).toEqual({ enabled: true });
  });

  it('a row that is on reads as Stop Confirm', async () => {
    state.perms = new Set(['*']);
    state.settings = [{ key: 'fair_venue_differs_blocks', enabled: true, label: 'x', updated_at: '2026-10-19T12:00:00Z' }];
    mount();
    await waitFor(() => expect(radio(/Stop Confirm/).checked).toBe(true));
    expect(screen.getByText(/Last changed/)).toBeTruthy();
  });

  it('anyone else sees it but cannot change it', async () => {
    state.perms = new Set(['scm.config.write']);
    mount();
    await waitFor(() => expect(screen.getByText('Only the owner or Finance can change this.')).toBeTruthy());
    expect(radio(/Stop Confirm/).disabled).toBe(true);
  });

  it('a failed load says so rather than showing the default as the answer', async () => {
    state.perms = new Set(['*']);
    state.settings = new Error("You don't have permission to do that.");
    mount();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("Couldn't load the fair rules."));
    expect(radio(/Flag only/).disabled).toBe(true);
  });
});
