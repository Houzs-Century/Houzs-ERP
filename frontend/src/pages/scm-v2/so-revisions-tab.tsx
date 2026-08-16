// ----------------------------------------------------------------------------
// so-revisions-tab — the Sales Order detail page's "Revisions" tab.
//
// Lifted VERBATIM out of SalesOrderDetail.tsx; no behaviour change. That file
// carries a file-size ceiling that may only FALL, and CLAUDE.md's rule for
// being over one is "a new module, never a bigger number". This tab was the
// cleanest thing to move: it reads one query, renders read-only, and shares no
// state with the editor around it.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { fmtDateTime, fmtMoneyCenti } from '@2990s/shared';
import { useSoRevisions, type SoRevisionRow } from '../../vendor/scm/lib/so-amendment-queries';
import styles from './SalesOrderDetail.module.css';

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneyCenti(centi, currency);

/* Read-only Revisions tab — lists prior SO snapshots (newest first) via
   useSoRevisions. Clicking a revision expands its stored snapshot as read-only
   detail. Mirrors the audit/history read pattern; no writes. */
export const RevisionsTab = ({ docNo, currency }: { docNo: string; currency: string }) => {
  const { data, isLoading, error } = useSoRevisions(docNo);
  const [openId, setOpenId] = useState<string | null>(null);
  const revisions = (data?.revisions ?? []) as SoRevisionRow[];

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Revisions ({revisions.length})</h2>
      </header>
      <div className={styles.cardBody}>
        {isLoading ? (
          <p className={styles.muted}>Loading revisions…</p>
        ) : error ? (
          <div className={styles.bannerWarn}>
            <strong>Could not load revisions.</strong>{' '}
            {error instanceof Error ? error.message : 'Something went wrong.'}
          </div>
        ) : revisions.length === 0 ? (
          <p className={styles.muted}>
            No prior revisions — this Sales Order hasn't been amended yet. Approved
            amendments snapshot the previous version here.
          </p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.tableRight}>Rev.</th>
                <th>Date</th>
                <th>Snapshot</th>
              </tr>
            </thead>
            <tbody>
              {revisions.map((r) => {
                const isOpen = openId === r.id;
                return (
                  <tr key={r.id}>
                    <td className={styles.tableRight}><strong>{r.revision}</strong></td>
                    <td>{r.created_at ? fmtDateTime(r.created_at) : '—'}</td>
                    <td>
                      <button type="button"
                        onClick={() => setOpenId(isOpen ? null : r.id)}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          color: 'var(--c-burnt)', fontWeight: 600, fontSize: 'var(--fs-13)',
                          textDecoration: 'underline',
                        }}>
                        {isOpen ? 'Hide snapshot' : 'View snapshot'}
                      </button>
                      {isOpen && (
                        <RevisionSnapshot snapshot={r.snapshot} currency={currency} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};

/* Read-only render of a revision snapshot (header + lines). The snapshot JSON is
   the full SO at that revision; we surface the key header fields + the line list.
   Dual-reads snake/camel defensively (the approve-so snapshot shape isn't frozen). */
const RevisionSnapshot = ({ snapshot, currency }: { snapshot: unknown; currency: string }) => {
  const snap = (snapshot ?? {}) as Record<string, unknown>;
  const header = (snap.header ?? snap.salesOrder ?? snap) as Record<string, unknown>;
  const rawLines = (snap.lines ?? snap.items ?? []) as Array<Record<string, unknown>>;
  const lines = Array.isArray(rawLines) ? rawLines : [];
  const str = (v: unknown): string => (v == null ? '—' : String(v));
  const centi = (v: unknown): string =>
    typeof v === 'number' ? fmtRm(v, currency) : '—';

  return (
    <div style={{
      marginTop: 'var(--space-2)', padding: 'var(--space-3)',
      background: 'var(--bg-subtle, rgba(34,31,32,0.03))',
      border: '1px solid var(--line)', borderRadius: 'var(--radius-md)',
      fontSize: 'var(--fs-12)',
    }}>
      <div style={{ marginBottom: 'var(--space-2)' }}>
        <strong>Customer:</strong> {str(header.debtor_name ?? header.debtorName)}
        {' · '}<strong>Total:</strong> {centi(header.local_total_centi ?? header.localTotalCenti)}
      </div>
      {lines.length > 0 ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Item</th>
              <th className={styles.tableRight}>Qty</th>
              <th className={styles.tableRight}>Unit</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{str(l.item_code ?? l.itemCode)}</td>
                <td className={styles.tableRight}>{str(l.qty)}</td>
                <td className={styles.tableRight}>{centi(l.unit_price_centi ?? l.unitPriceCenti)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <span className={styles.muted}>Snapshot has no line detail.</span>
      )}
    </div>
  );
};
