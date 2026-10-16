// ----------------------------------------------------------------------------
// bill-pile-store — the Scan bills pile, kept while the tab lives (owner
// 2026-10-06: 开了一张 AP invoice 回来，剩下的单要重新读 → 回来时还在).
//
// The pile page used to hold its files and readings in component state, so
// opening one bill as an AP invoice (or a voucher) threw the rest away and the
// owner re-read — and paid for — every bill again. The pile now lives here, one
// per company and per pile (PV / AP), outside any component: leaving the page
// keeps it, a read that lands after the page was left still lands, and a page
// coming back finds it as it was. It is browser memory only — closing the tab
// or a refresh empties it, which is what the owner was told.
//
// A read is stamped with the run that sent it: clearing the pile (or reading
// it again) ends that run, and an answer from an ended run is dropped rather
// than landing in a pile that no longer has its bill.
// ----------------------------------------------------------------------------

import { useSyncExternalStore } from 'react';
import type { ExtractedBill, PvFilePayload } from './payment-voucher-queries';

export type PileTarget = 'pv' | 'ap';
export type PickedFile = { rid: string; file: File; merged: boolean };

export type PileState = {
  picked: PickedFile[];
  /** bills[i] = the files that form bill i (merged pages share an entry). */
  billGroups: string[][];
  /** What the reader answered, by bill; null before a read. */
  results: ExtractedBill[] | null;
  /** The read payload by bill — the document opened from a bill carries it. */
  billFiles: PvFilePayload[][];
  /** Bills already opened as a document (by index), so the pile says which are done. */
  opened: number[];
  /** The read under way. */
  progress: { done: number; total: number } | null;
  /** Failed bills being read again. */
  rereading: number[];
  /** The run a landing answer must belong to. */
  run: number;
};

export const EMPTY_PILE: PileState = {
  picked: [], billGroups: [], results: null, billFiles: [], opened: [], progress: null, rereading: [], run: 0,
};

const piles = new Map<string, PileState>();
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** One pile per company and per kind — a 2990 pile never shows in Houzs. */
export const pileKey = (companyId: number | null, target: PileTarget): string => `${companyId ?? '-'}:${target}`;

export const getPile = (key: string): PileState => piles.get(key) ?? EMPTY_PILE;

export function updatePile(key: string, change: (p: PileState) => PileState): void {
  piles.set(key, change(getPile(key)));
  emit();
}

/** Empty the pile — and end any read still out, so its answers are dropped. */
export function clearPile(key: string): void {
  piles.set(key, { ...EMPTY_PILE, run: getPile(key).run + 1 });
  emit();
}

/** Tests only: every pile, gone. */
export function clearAllPiles(): void {
  piles.clear();
  emit();
}

export const usePile = (key: string): PileState =>
  useSyncExternalStore(subscribe, () => getPile(key), () => getPile(key));

/** Read bills not yet opened as a document — "Back to Scan bills (N left)". */
export const billsLeft = (p: PileState): number =>
  (p.results ?? []).filter((b) => b.ok && !p.opened.includes(b.index)).length;
