// ----------------------------------------------------------------------------
// previousRecords — a salesperson's payment record the owner has checked and
// marked as the previous system's (owner 2026-11-11: 我检查确定后，就直接说这个是
// 之前record，我哪里都不会take-in / 我说的是sales man 的收款记录（包括imported
// from autocount)). Marked, it shows up on no list here, in Merchant Recon or in
// the Cash Flow, and is offered to no merchant or bank line; nothing is posted.
//
// The pieces both screens use: ticks for a table, the "Previous record" button
// that marks the ticked rows, what came back (how many, and each refusal in the
// server's words), and the Previous records list with Undo. That list is its own
// — not Merchant Recon's or Bank Recon's Set aside, which hold report lines and
// statement lines (owner: 要分开，不然看不懂). The rule is the server's
// (backend acc/previous-payments).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Archive, Undo2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { DataTable, type Column } from '../../components/DataTable';
import { fmtDate } from '../../vendor/shared/format';
import { danger, softText } from './settlement-ui';
import styles from './Suppliers.module.css';
import { docLink, moneyColumn } from './unmatchedLists';
import {
  useMarkPrevious, usePreviousPayments, useUndoPrevious, type PaymentRef, type PreviousPayment, type PreviousRefusal,
} from './unmatched-payments-queries';

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A row's payment, from the key a table gives it (`${source}:${id}`). */
export const refOfKey = (key: string): PaymentRef | null => {
  const at = key.indexOf(':');
  const source = key.slice(0, at);
  const id = key.slice(at + 1);
  return (source === 'SOPAY' || source === 'SIPAY') && id ? { source, id } : null;
};

/** Ticks for one table: what DataTable's `selection` takes, and the payments ticked. */
export function usePaymentTicks(visibleKeys: readonly string[]) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  /* A row that left the list (marked, or no longer in the dates) is no longer ticked. */
  const visible = visibleKeys.join('\n');
  const kept = useMemo(() => {
    const live = new Set(visible.split('\n'));
    return new Set([...ticked].filter((k) => live.has(k)));
  }, [ticked, visible]);
  return {
    keys: kept,
    refs: [...kept].map(refOfKey).filter((r): r is PaymentRef => r != null),
    clear: () => setTicked(new Set()),
    selection: {
      selectedIds: kept,
      onToggle: (id: string) => setTicked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      }),
      onToggleAll: (keys: string[], allSelected: boolean) => setTicked((prev) => {
        const next = new Set(prev);
        for (const k of keys) { if (allSelected) next.delete(k); else next.add(k); }
        return next;
      }),
    },
  };
}

/** What a press came back with: how many it did, and each one it would not. */
export type PressResult = { text: string; refused: PreviousRefusal[]; failed: boolean };

export const PressNote = ({ result }: { result: PressResult | null }) => {
  if (!result) return null;
  return (
    <div role={result.failed ? 'alert' : 'status'} style={{ ...softText, ...(result.failed ? { color: danger } : {}) }}>
      <div>{result.text}</div>
      {result.refused.length > 0 && (
        <ul style={{ margin: '4px 0 0 18px', listStyle: 'disc' }}>
          {result.refused.map((r) => <li key={`${r.source}:${r.id}`}>{r.message}</li>)}
        </ul>
      )}
    </div>
  );
};

/** "Previous record" — marks the ticked payments; what came back goes to `onResult`. */
export const MarkPreviousButton = ({ refs, onDone, onResult }: {
  refs: readonly PaymentRef[]; onDone: () => void; onResult: (r: PressResult) => void;
}) => {
  const mark = useMarkPrevious();
  const press = () => {
    if (refs.length === 0 || mark.isPending) return;
    mark.mutate([...refs], {
      onSuccess: (got) => {
        onDone();
        onResult({
          failed: false,
          refused: got.refused,
          text: got.marked > 0
            ? `${plural(got.marked, 'payment')} marked as previous records — shown nowhere now; Previous records lists them, with Undo.`
            : 'Nothing was marked.',
        });
      },
      onError: (e) => onResult({ failed: true, refused: [], text: e instanceof Error && e.message ? e.message : 'The payments could not be marked.' }),
    });
  };
  return (
    <Button variant="ghost" size="sm" disabled={refs.length === 0 || mark.isPending} onClick={press}
      title="Tick the payments you have checked are the previous system's: they leave every list and are matched to nothing">
      <Archive {...ICON} /> {mark.isPending ? 'Marking…' : `Previous record${refs.length > 0 ? ` (${refs.length})` : ''}`}
    </Button>
  );
};

const METHOD_WORDS: Record<string, string> = { merchant: 'Card', installment: 'Instalment', transfer: 'Transfer', imported: 'From AutoCount' };
const methodOf = (r: PreviousPayment): string =>
  [METHOD_WORDS[r.method] ?? r.method, r.channel].filter(Boolean).join(' · ');

export const PREVIOUS_COLUMNS: Column<PreviousPayment>[] = [
  { key: 'paidOn', label: 'Paid on', render: (r) => fmtDate(r.paidOn), getValue: (r) => r.paidOn, exportFormat: 'date' },
  { key: 'document', label: 'Document', render: (r) => (r.docNo ? docLink(r.source, r.docNo) : '—'), getValue: (r) => r.docNo ?? '' },
  { key: 'customer', label: 'Customer', render: (r) => r.customer ?? '—', getValue: (r) => r.customer ?? '' },
  { key: 'method', label: 'Method', render: (r) => <span className={styles.codeChip}>{methodOf(r)}</span>, getValue: methodOf },
  moneyColumn<PreviousPayment>('amount', 'Amount', (r) => r.amountSen),
  { key: 'reference', label: 'Reference', render: (r) => r.reference ?? '—', getValue: (r) => r.reference ?? '' },
  { key: 'markedBy', label: 'Marked by', render: (r) => r.markedBy ?? '—', getValue: (r) => r.markedBy ?? '' },
  { key: 'markedOn', label: 'Marked on', render: (r) => fmtDate(r.markedAt.slice(0, 10)), getValue: (r) => r.markedAt.slice(0, 10), exportFormat: 'date' },
];

/** The Previous records list: every marked payment, ticks, and Undo for the ticked. */
export const PreviousRecordsList = () => {
  const q = usePreviousPayments();
  const rows = q.data?.rows ?? null;
  const ticks = usePaymentTicks((rows ?? []).map((r) => `${r.source}:${r.id}`));
  const undo = useUndoPrevious();
  const [result, setResult] = useState<PressResult | null>(null);
  const press = () => {
    if (ticks.refs.length === 0 || undo.isPending) return;
    undo.mutate(ticks.refs, {
      onSuccess: (got) => {
        ticks.clear();
        setResult({ failed: false, refused: [], text: `${plural(got.undone, 'payment')} put back — each shows up again where it did before.` });
      },
      onError: (e) => setResult({ failed: true, refused: [], text: e instanceof Error && e.message ? e.message : 'The payments could not be put back.' }),
    });
  };
  return (
    <div className="space-y-2">
      <PressNote result={result} />
      <DataTable<PreviousPayment>
        tableId="previous-payment-records"
        exportName="previous-payment-records"
        exportXlsx
        selection={ticks.selection}
        toolbarExtra={(
          <Button variant="ghost" size="sm" disabled={ticks.refs.length === 0 || undo.isPending} onClick={press}
            title="Put the ticked payments back where they were">
            <Undo2 {...ICON} /> {undo.isPending ? 'Undoing…' : `Undo${ticks.refs.length > 0 ? ` (${ticks.refs.length})` : ''}`}
          </Button>
        )}
        columns={PREVIOUS_COLUMNS}
        rows={rows}
        loading={q.isLoading}
        error={q.isError ? 'The previous records did not load.' : null}
        emptyLabel="No payment is marked as a previous record."
        getRowKey={(r) => `${r.source}:${r.id}`}
      />
    </div>
  );
};
