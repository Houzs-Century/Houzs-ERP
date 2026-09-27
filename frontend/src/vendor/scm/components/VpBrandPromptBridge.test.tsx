import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/* The question as the operator meets it: the shell's pick-one dialog, raised
 * from the query layer after a save, with the linked booth's brand first and
 * Skip as the way out (owner 2026-09-27). */

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock('../lib/authed-fetch', () => ({ authedFetch }));
vi.mock('../lib/dialog-service', () => ({ serviceNotify: vi.fn() }));

import { ChoiceProvider } from './ChoiceDialog';
import { VpBrandPromptBridge } from './VpBrandPromptBridge';
import { askVpBrand } from '../lib/vp-brand-prompt';

const OPTIONS = ['ZANOTTI', 'DUNLOPILLO', 'AKEMI', 'ERGOTEX'];

function mountShell() {
  render(
    <ChoiceProvider>
      <VpBrandPromptBridge />
    </ChoiceProvider>,
  );
}

afterEach(() => {
  cleanup();
  authedFetch.mockReset();
});

describe('VpBrandPromptBridge', () => {
  it('asks in the shell’s dialog and stores the brand picked', async () => {
    authedFetch.mockResolvedValue({ ok: true });
    mountShell();
    let done!: Promise<void>;
    act(() => { done = askVpBrand('HC-SO-2609-219', { suggested: 'AKEMI', options: OPTIONS }); });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe('Which brand is HC-SO-2609-219 for?');
    const choices = within(dialog).getAllByRole('button').map((b) => b.textContent);
    expect(choices).toEqual([
      'AKEMIThe brand of the fair this bill is linked to', 'ZANOTTI', 'DUNLOPILLO', 'ERGOTEX', 'Skip',
    ]);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^AKEMI/ }));
      await done;
    });
    expect(authedFetch).toHaveBeenCalledWith('/mfg-sales-orders/HC-SO-2609-219/vp-brand', {
      method: 'PUT',
      body: JSON.stringify({ brand: 'AKEMI' }),
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Skip and writes nothing', async () => {
    mountShell();
    let done!: Promise<void>;
    act(() => { done = askVpBrand('HC-SO-2609-127', { suggested: null, options: OPTIONS }); });
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Skip' }));
      await done;
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('asks nothing once the shell is gone', async () => {
    mountShell();
    cleanup();
    await askVpBrand('HC-SO-2609-127', { suggested: null, options: OPTIONS });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(authedFetch).not.toHaveBeenCalled();
  });
});
