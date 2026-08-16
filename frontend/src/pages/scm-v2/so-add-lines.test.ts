// ----------------------------------------------------------------------------
// so-add-lines — the staged-new-line rules of the SO editor.
//
// Owner 2026-08-16: he clicked "+ Add Line Item", got one card, and the button
// vanished; "it should be able to keep adding lines." He also saw
// "LINE ITEMS (2)" over three rows, which made the new row look unreal.
//
// Every test here fails against the single-`addingDraft` shape it replaced —
// see the PR body for the stash/restore run that proves it.
// ----------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';
import { emptySoLine, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import {
  cascadeStagedDeliveryDate,
  dropStagedAdd,
  firstBlankStagedAdd,
  lineWriteErrorMessage,
  namedStagedAdds,
  patchStagedAdd,
  runSoLineWrites,
  settleParallelLineWrites,
  settleSequentialLineWrites,
  stagedAddDrafts,
  stagedAddLabel,
  visibleLineCounts,
  type StagedAddLine,
} from './so-add-lines';

const staged = (key: string, patch: Partial<SoLineDraft> = {}): StagedAddLine => ({
  key,
  idempotencyKey: `idem-${key}`,
  draft: { ...emptySoLine(), ...patch },
});

describe('staging several new lines', () => {
  it('keeps every staged line distinct, in the order they were added', () => {
    const list = [staged('a', { itemCode: 'SOFA-1' }), staged('b', { itemCode: 'BF-2' })];
    expect(stagedAddDrafts(list).map((d) => d.itemCode)).toEqual(['SOFA-1', 'BF-2']);
  });

  it('gives each staged line its OWN idempotency key', () => {
    // One key shared across distinct inserts makes the middleware replay the
    // first response for all of them, i.e. lines silently swallowed.
    const list = [staged('a'), staged('b'), staged('c')];
    expect(new Set(list.map((r) => r.idempotencyKey)).size).toBe(3);
  });

  it('patches only the addressed line and leaves the others identical', () => {
    const list = [staged('a', { qty: 1 }), staged('b', { qty: 1 })];
    const next = patchStagedAdd(list, 'b', { qty: 7 });
    expect(next[0]).toBe(list[0]);            // untouched rows keep identity (React.memo)
    expect(next[1]!.draft.qty).toBe(7);
    expect(list[1]!.draft.qty).toBe(1);       // no mutation of the previous state
  });

  it('returns the SAME array when the patch addresses nothing', () => {
    const list = [staged('a')];
    expect(patchStagedAdd(list, 'missing', { qty: 3 })).toBe(list);
  });

  it('removes one staged line without disturbing its siblings', () => {
    const list = [staged('a'), staged('b'), staged('c')];
    expect(dropStagedAdd(list, 'b').map((r) => r.key)).toEqual(['a', 'c']);
    expect(dropStagedAdd(list, 'zz')).toBe(list);
  });
});

describe('header Delivery Date cascade', () => {
  it('moves every non-overridden staged line, not just the first', () => {
    const list = [
      staged('a', { lineDeliveryDate: '2026-01-01' }),
      staged('b', { lineDeliveryDate: '2026-01-01' }),
      staged('c', { lineDeliveryDate: '2026-03-03', lineDeliveryDateOverridden: true }),
    ];
    const next = cascadeStagedDeliveryDate(list, '2026-02-02');
    expect(next.map((r) => r.draft.lineDeliveryDate))
      .toEqual(['2026-02-02', '2026-02-02', '2026-03-03']);
  });

  it('is a no-op (same array) when nothing has to move', () => {
    const list = [staged('a', { lineDeliveryDate: null })];
    expect(cascadeStagedDeliveryDate(list, null)).toBe(list);
  });
});

describe('the blank-line guard names WHICH staged line', () => {
  it('reports the 1-based position of the first line with no product', () => {
    const list = [staged('a', { itemCode: 'SOFA-1' }), staged('b'), staged('c')];
    expect(firstBlankStagedAdd(list)).toBe(2);
    expect(stagedAddLabel(firstBlankStagedAdd(list)!)).toBe('New line 2');
  });

  it('passes when every staged line names a product', () => {
    expect(firstBlankStagedAdd([staged('a', { itemCode: 'X' })])).toBeNull();
    expect(firstBlankStagedAdd([])).toBeNull();
  });

  it('treats whitespace as blank', () => {
    expect(firstBlankStagedAdd([staged('a', { itemCode: '   ' })])).toBe(1);
  });
});

describe('the amendment ADD diff', () => {
  it('emits one row per staged line, dropping code-less ones', () => {
    const list = [
      staged('a', { itemCode: 'SOFA-1' }),
      staged('b', { itemCode: '' }),
      staged('c', { itemCode: 'BF-2' }),
    ];
    expect(namedStagedAdds(list).map((r) => r.draft.itemCode)).toEqual(['SOFA-1', 'BF-2']);
  });
});

describe('"Line Items (n)" counts what is on screen', () => {
  it('counts staged adds alongside the persisted rows in edit mode', () => {
    // The reported symptom: three cards, header reading (2).
    expect(visibleLineCounts({
      isEditing: true,
      itemIds: ['i1', 'i2'],
      editingDraftIds: ['i1', 'i2'],
      stagedAdds: 1,
    })).toEqual({ persisted: 2, total: 3 });
  });

  it('drops a row removed this session, which lingers in items until the refetch', () => {
    expect(visibleLineCounts({
      isEditing: true,
      itemIds: ['i1', 'i2'],
      editingDraftIds: ['i1'],
      stagedAdds: 0,
    })).toEqual({ persisted: 1, total: 1 });
  });

  it('is plain items.length outside edit mode', () => {
    expect(visibleLineCounts({
      isEditing: false,
      itemIds: ['i1', 'i2', 'i3'],
      editingDraftIds: [],
      stagedAdds: 0,
    })).toEqual({ persisted: 3, total: 3 });
  });
});

describe('line writes settle instead of racing the first rejection', () => {
  const job = (label: string, run: () => Promise<unknown>) => ({ label, value: label, run });

  it('parallel: waits for every write and reports every refusal', async () => {
    const out = await settleParallelLineWrites([
      job('SOFA-1', () => Promise.resolve('ok')),
      job('BF-2', () => Promise.reject(new Error('price refused'))),
      job('MT-3', () => Promise.reject(new Error('variant missing'))),
    ]);
    expect(out.done).toEqual(['SOFA-1']);
    expect(out.failures).toEqual([
      { label: 'BF-2', message: 'price refused' },
      { label: 'MT-3', message: 'variant missing' },
    ]);
  });

  it('sequential: one at a time, in order', async () => {
    const order: string[] = [];
    let live = 0;
    const track = (label: string) => async () => {
      live += 1;
      expect(live).toBe(1);            // never two adds in flight at once
      order.push(label);
      await Promise.resolve();
      live -= 1;
    };
    const out = await settleSequentialLineWrites([
      job('A', track('A')), job('B', track('B')), job('C', track('C')),
    ]);
    expect(order).toEqual(['A', 'B', 'C']);
    expect(out.done).toEqual(['A', 'B', 'C']);
  });

  it('sequential: keeps going past a refusal so later lines are still attempted', async () => {
    const out = await settleSequentialLineWrites([
      job('A', () => Promise.resolve(1)),
      job('B', () => Promise.reject(new Error('so_sofa_no_other_main'))),
      job('C', () => Promise.resolve(1)),
    ]);
    expect(out.done).toEqual(['A', 'C']);
    expect(out.failures).toEqual([{ label: 'B', message: 'so_sofa_no_other_main' }]);
  });
});

describe('the failure message names the line', () => {
  it('names a single refusal', () => {
    expect(lineWriteErrorMessage([{ label: 'SOFA-1', message: 'price refused' }], 0))
      .toBe('Could not save SOFA-1: price refused.');
  });

  it('names every refusal when several fail', () => {
    const msg = lineWriteErrorMessage([
      { label: 'SOFA-1', message: 'price refused' },
      { label: 'New line 2', message: 'variant missing' },
    ], 0);
    expect(msg).toContain('2 lines could not be saved');
    expect(msg).toContain('SOFA-1: price refused');
    expect(msg).toContain('New line 2: variant missing');
  });

  it('says the staged work is still on screen', () => {
    expect(lineWriteErrorMessage([{ label: 'BF-2', message: 'price refused' }], 2))
      .toContain('Your 2 new lines are still on screen and not saved yet');
    expect(lineWriteErrorMessage([{ label: 'BF-2', message: 'price refused' }], 1))
      .toContain('Your 1 new line is still on screen and not saved yet');
  });
});

describe('runSoLineWrites — the page Save chain', () => {
  const ok = (label: string, spy: () => void) => ({ label, value: label, run: async () => { spy(); } });

  it('commits ALL staged adds, not one', async () => {
    const hits: string[] = [];
    const landed: string[][] = [];
    await runSoLineWrites({
      deletes: [],
      updates: [],
      adds: [
        ok('A', () => hits.push('A')), ok('B', () => hits.push('B')), ok('C', () => hits.push('C')),
      ],
      onAddsLanded: (rows) => landed.push(rows as string[]),
    });
    expect(hits).toEqual(['A', 'B', 'C']);
    expect(landed).toEqual([['A', 'B', 'C']]);
  });

  it('runs deletes, then updates, then adds', async () => {
    const seen: string[] = [];
    await runSoLineWrites({
      deletes: [ok('del', () => seen.push('del'))],
      updates: [ok('upd', () => seen.push('upd'))],
      adds: [ok('add', () => seen.push('add'))],
      onAddsLanded: () => {},
    });
    expect(seen).toEqual(['del', 'upd', 'add']);
  });

  it('a refused line PATCH names itself AND says the new lines were not saved', async () => {
    const addRan = vi.fn();
    await expect(runSoLineWrites({
      deletes: [],
      updates: [{ label: 'SOFA-1', value: 'SOFA-1', run: () => Promise.reject(new Error('price refused')) }],
      adds: [ok('New line 1', addRan)],
      onAddsLanded: () => {},
    })).rejects.toThrow(/SOFA-1: price refused.*1 new line is still on screen/s);
    // The old chain's silent half: the add never ran and was never mentioned.
    expect(addRan).not.toHaveBeenCalled();
  });

  it('a partial add failure reports WHICH line and keeps the ones that landed', async () => {
    const landed: string[][] = [];
    await expect(runSoLineWrites({
      deletes: [],
      updates: [],
      adds: [
        ok('SOFA-1', () => {}),
        { label: 'BF-2', value: 'BF-2', run: () => Promise.reject(new Error('so_sofa_no_other_main')) },
        ok('MT-3', () => {}),
      ],
      onAddsLanded: (rows) => landed.push(rows as string[]),
    })).rejects.toThrow(/BF-2: so_sofa_no_other_main/);
    expect(landed).toEqual([['SOFA-1', 'MT-3']]);
  });
});
