// ----------------------------------------------------------------------------
// The Event Commission export's choices (owner 2026-11-16: 「就是多个选项让我选，可以
// total，可以单独」): who the file is for — everyone, one salesperson, or each
// salesperson in turn — before Excel, PDF or Print make it. Each table exports
// the columns its reader has showing (「通常根据我tab的header就行了」): the dialog
// says so, the page's own Columns menus choose them.
// ----------------------------------------------------------------------------

import { useCallback, useRef, useState } from 'react';
import type { Column } from '../../components/DataTable';
import { Modal } from '../../vendor/scm/components/Modal';
import { EC_ROW_KEY, type EcRows, type EcTableKey, type EcWho, type ShownTable } from './eventCommissionExport';
import ec from './EventCommission.module.css';

/** What a table tells the page: the columns showing, its rows as its column filters leave them, the filters. */
export type EcTells<T> = {
  onShownColumnsChange: (columns: Column<T>[]) => void;
  onFilteredRowsChange: (rows: T[]) => void;
  onColFiltersChange: (filters: Record<string, string[]>) => void;
};
type Told = { columns?: readonly unknown[]; keys?: string[]; filters?: Record<string, string[]> };

/** A table's column filters in words: "Salesperson: Ali, Bob · Brand: AKEMI". */
const filterWords = (filters: Record<string, string[]>, all: ReadonlyArray<{ key: string; label: string }>): string | null => {
  const words = Object.entries(filters).filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${all.find((c) => c.key === k)?.label ?? k}: ${v.slice(0, 3).join(', ')}${v.length > 3 ? ` +${v.length - 3}` : ''}`);
  return words.length > 0 ? words.join(' · ') : null;
};

/** What each table on the page shows, for the export (as Payments not matched yet's Export
    all): told on every change into a ref, read on the press — no re-render. */
export function useEcTables() {
  const told = useRef<Partial<Record<EcTableKey | 'fairOrdersProbe', Told>>>({});
  const made = useRef(new Map<string, unknown>());
  /** The props a table passes back through; the same functions every render. */
  const tell = useCallback(<K extends EcTableKey>(key: K, as: K | 'fairOrdersProbe' = key): EcTells<EcRows[K]> => {
    const had = made.current.get(as);
    if (had) return had as EcTells<EcRows[K]>;
    const keyOf = EC_ROW_KEY[key] as (row: EcRows[K]) => string;
    const put = (part: Told) => { told.current[as] = { ...told.current[as], ...part }; };
    const tells: EcTells<EcRows[K]> = {
      onShownColumnsChange: (columns) => put({ columns }),
      onFilteredRowsChange: (rows) => put({ keys: rows.map(keyOf) }),
      onColFiltersChange: (filters) => put({ filters }),
    };
    made.current.set(as, tells);
    return tells;
  }, []);
  /** A table as it shows now; one that has not said yet, its default columns and every row. */
  const shown = useCallback(<K extends EcTableKey>(key: K, all: ReadonlyArray<Column<EcRows[K]>>): ShownTable<EcRows[K]> => {
    const t = told.current[key];
    return {
      columns: (t?.columns as ReadonlyArray<Column<EcRows[K]>> | undefined) ?? all.filter((c) => !c.defaultHidden),
      rowKeys: t?.keys ?? null,
      filters: t?.filters ? filterWords(t.filters, all) : null,
    };
  }, []);
  /** The keys of the columns a fair's orders show — told by an open fair, else by the hidden probe. */
  const fairOrderKeys = useCallback((): string[] | null => {
    const cols = (told.current.fairOrders?.columns ?? told.current.fairOrdersProbe?.columns) as ReadonlyArray<{ key: string }> | undefined;
    return cols ? cols.map((c) => c.key) : null;
  }, []);
  return { tell, shown, fairOrderKeys };
}

export type EcFormat = 'excel' | 'pdf' | 'print';
const TITLES: Record<EcFormat, string> = { excel: 'Export to Excel', pdf: 'Export to PDF', print: 'Print' };

export function EventCommissionExportDialog({ format, people, onClose, onExport }: {
  format: EcFormat;
  /** The salespeople on the report, A to Z. */
  people: readonly string[];
  onClose: () => void;
  /** Makes the file; a failure is shown here and the dialog stays open. */
  onExport: (who: EcWho) => Promise<void>;
}) {
  const [kind, setKind] = useState<EcWho['kind']>('all');
  const [name, setName] = useState(people[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = kind !== 'one' || people.includes(name);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onExport(kind === 'one' ? { kind, name } : { kind });
      onClose();
    } catch (e) {
      setError(`The file could not be made — ${e instanceof Error ? e.message : 'something went wrong.'}`);
      setBusy(false);
    }
  };
  const choice = (value: EcWho['kind'], label: string, hint: string, extra?: React.ReactNode) => (
    <label className={ec.exportChoice}>
      <input type="radio" name="ec-export-who" value={value} checked={kind === value} onChange={() => setKind(value)} />
      <span>
        <strong>{label}</strong>
        <span className={ec.exportHint}>{hint}</span>
        {extra}
      </span>
    </label>
  );
  return (
    <Modal title={TITLES[format]} onClose={onClose} width="min(520px, 100%)" ariaLabel={TITLES[format]}>
      <fieldset className={ec.exportChoices} aria-label="Who the file is for" disabled={busy}>
        {choice('all', 'Everyone', 'The whole report: the summary with a line per salesperson, then every table.')}
        {choice('one', 'One salesperson', 'Their orders only: their summary, their total, their lines in every table.', kind === 'one' && (
          <select className={ec.input} aria-label="Salesperson" value={name} onChange={(e) => setName(e.target.value)}>
            {people.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ))}
        {choice('each', 'Each salesperson', format === 'excel'
          ? 'Every table by salesperson: their lines, then their subtotal; the summary with a line each.'
          : 'The summary with a line per salesperson, then each salesperson from a new page.')}
      </fieldset>
      <p className={ec.exportHint}>
        Each table gives the columns it is showing on the page, in their order, and the rows its column filters leave.
        To change them, use the table&apos;s Columns before exporting.
      </p>
      {error && <p role="alert" className={ec.exportError}>{error}</p>}
      <div className={ec.formBtns}>
        <button type="button" className={ec.closeBtn} disabled={!ready || busy} onClick={() => { void go(); }}>
          {busy ? 'Making the file…' : format === 'print' ? 'Print' : 'Export'}
        </button>
        <button type="button" className={ec.markBtn} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
