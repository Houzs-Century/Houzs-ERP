/**
 * SpecialOrders — the ONE shared special-order editor (owner 2026-07-20 unify).
 *
 * Pins the invariants that make a special order flow SO -> PO -> DO -> GRN
 * without being re-entered:
 *   1. a legacy singular `variants.special` still reads as a checked pick;
 *   2. toggling writes the canonical `variants.specials` ARRAY (+ specialLabels)
 *      and NEVER the singular key — so every doc emits one payload shape;
 *   3. the "Custom / other" free text carries through as extraAddonNote;
 *   4. a source-linked doc (PO/GRN) is read-only until Override is pressed, so
 *      the parent's special order is shown + carried, not silently re-typed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpecialOrders } from './SpecialOrders';
import type { SpecialAddonRow } from '../lib/mfg-products-queries';

afterEach(cleanup);

const row = (code: string, label: string): SpecialAddonRow => ({
  id: code, code, label, soDescription: label, categories: ['BEDFRAME'],
  sellingPriceSen: 0, costPriceSen: 0, optionGroups: [], active: true, sortOrder: 0,
});

const OPTIONS: SpecialAddonRow[] = [
  row('HB_FULL', 'HB Fully Cover'),
  row('DIVAN_FULL', 'Divan Full Cover'),
];

describe('SpecialOrders', () => {
  it('reads a legacy singular variants.special as a checked pick', () => {
    render(<SpecialOrders options={OPTIONS} variants={{ special: 'HB_FULL' }} onPatch={() => {}} showPrices={false} open />);
    expect((screen.getByRole('checkbox', { name: /HB Fully Cover/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /Divan Full Cover/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('writes the canonical specials array + labels on toggle, never the singular key', async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(<SpecialOrders options={OPTIONS} variants={{ special: 'HB_FULL' }} onPatch={onPatch} showPrices={false} open />);
    await user.click(screen.getByRole('checkbox', { name: /Divan Full Cover/i }));
    expect(onPatch).toHaveBeenCalledTimes(1);
    const patch = onPatch.mock.calls[0][0];
    expect(patch.specials).toEqual(['HB_FULL', 'DIVAN_FULL']);
    expect(patch.specialLabels).toEqual(['HB Fully Cover', 'Divan Full Cover']);
    expect('special' in patch).toBe(false);
  });

  it('carries the Custom / other free text through onPatch.extraAddonNote', async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(<SpecialOrders options={OPTIONS} variants={{}} onPatch={onPatch} showPrices={false} open />);
    await user.click(screen.getByRole('button', { name: /Custom \/ other/i }));
    await user.type(screen.getByPlaceholderText(/Describe the special order/i), 'X');
    expect(onPatch).toHaveBeenCalledWith({ extraAddonNote: 'X' });
  });

  /* Owner's choice 甲, 2026-09-03 — an option recovered from an AutoCount slip is
     SHOWN so the factory can build it, and is not a pick: it lives in its own
     variants key that no pricing path reads, so it can never move the imported
     document's money. See backend/tests/specialsRecordedNeverPriced.test.ts. */
  it('a recorded-only option shows ticked and locked, and emits no patch', async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(<SpecialOrders options={OPTIONS} variants={{ specialsRecorded: ['HB_FULL'] }} onPatch={onPatch} showPrices={false} open />);
    const boxes = screen.getAllByRole('checkbox', { name: /HB Fully Cover/i }) as HTMLInputElement[];
    const locked = boxes.find((b) => b.disabled);
    expect(locked, 'the recorded option renders as a locked ticked row').toBeTruthy();
    expect(locked!.checked).toBe(true);
    await user.click(locked!);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('a recorded option the operator has since PICKED is not shown twice', () => {
    render(<SpecialOrders options={OPTIONS} variants={{ specials: ['HB_FULL'], specialsRecorded: ['HB_FULL'] }} onPatch={() => {}} showPrices={false} open />);
    expect(screen.getAllByRole('checkbox', { name: /HB Fully Cover/i })).toHaveLength(1);
  });

  it('source-linked block is read-only until Override is pressed', async () => {
    const user = userEvent.setup();
    render(<SpecialOrders options={OPTIONS} variants={{ specials: ['HB_FULL'] }} onPatch={() => {}} showPrices={false} sourceLinked sourceLabel="Sales Order" open />);
    expect((screen.getByRole('checkbox', { name: /HB Fully Cover/i }) as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: /Override/i }));
    expect((screen.getByRole('checkbox', { name: /HB Fully Cover/i }) as HTMLInputElement).disabled).toBe(false);
  });
});
