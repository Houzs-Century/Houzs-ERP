// ----------------------------------------------------------------------------
// PiBackfillCard — the owner's own door onto POST /accounting/backfill/
// pi-periodic (GL redesign item 3). The endpoint shipped in #2974; this card
// is the missing handle: Dry run shows the list (invoice, kind, amount) and
// NOTHING writes until he presses 执行写入 himself — the button IS the nod
// the flow always required (dry-run 给我过目,点头才写入).
//
// The write pass loops the batched endpoint (25/call, Workers budget) until
// `remaining` is 0, and STOPS the moment a pass completes nothing — an
// unbound group surfaces as its own failure row, never as an infinite loop.
// Runs on the ACTIVE company only; 2990 and HOUZS are two visits.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';

type Item = { invoiceNumber: string; totalSen: number; kind: 'missing' | 'reshape' };
type DryRun = { dryRun: true; missing: Item[]; reshape: Item[]; current: number };
type Outcome = { invoiceNumber: string; kind: string; outcome: string; jeNo?: string; reason?: string };
type WritePass = { dryRun: false; processed: Outcome[]; remaining: number; summary: { attempted: number; done: number; failed: number } };

const soft: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };
const rm = (sen: number): string => `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (items: Item[]): number => items.reduce((s, i) => s + i.totalSen, 0);
const btn = (primary?: boolean, disabled?: boolean): React.CSSProperties => ({
  padding: '5px 12px',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  borderRadius: 'var(--radius-sm, 6px)',
  background: primary ? 'var(--c-ink)' : 'transparent',
  color: primary ? 'var(--c-cream)' : 'var(--c-ink)',
  fontSize: 'var(--fs-13)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});

export const PiBackfillCard = () => {
  const [preview, setPreview] = useState<DryRun | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [busy, setBusy] = useState<'dry' | 'write' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dryRun = async () => {
    setBusy('dry'); setError(null); setOutcomes(null);
    try {
      setPreview(await authedFetch<DryRun>('/accounting/backfill/pi-periodic?dryRun=1', { method: 'POST', body: '{}' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dry run failed.');
    } finally {
      setBusy(null);
    }
  };

  const write = async () => {
    setBusy('write'); setError(null);
    const all: Outcome[] = [];
    try {
      /* Loop the batch until nothing is left — but bail when a pass gets
         NOTHING done, so a wall of unbound-group failures shows itself once
         instead of spinning. */
      for (;;) {
        const pass = await authedFetch<WritePass>('/accounting/backfill/pi-periodic?limit=25', { method: 'POST', body: '{}' });
        all.push(...pass.processed);
        setOutcomes([...all]);
        if (pass.remaining === 0 || pass.summary.done === 0) break;
      }
      /* Re-classify so the card's counts tell the after-state truth. */
      setPreview(await authedFetch<DryRun>('/accounting/backfill/pi-periodic?dryRun=1', { method: 'POST', body: '{}' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The write pass stopped.');
    } finally {
      setBusy(null);
    }
  };

  const pendingCount = preview ? preview.missing.length + preview.reshape.length : 0;
  const failed = (outcomes ?? []).filter((o) => o.outcome === 'failed');

  return (
    <div style={{ border: '1px solid var(--c-line, rgba(34,31,32,0.12))', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }} className="space-y-2">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 'var(--fs-14)' }}>PI backfill — 历史采购发票补账</b>
        <span style={soft}>先 Dry run 看清单;执行时每张走正常引擎(旧 330 先反转再重开),按发票日期入账,重复跑是 no-op。只动当前公司。</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn(false, busy != null)} disabled={busy != null} onClick={() => void dryRun()}>
          {busy === 'dry' ? 'Checking…' : 'Dry run'}
        </button>
        <button type="button" style={btn(true, busy != null || !preview || pendingCount === 0)}
          disabled={busy != null || !preview || pendingCount === 0} onClick={() => void write()}>
          {busy === 'write' ? 'Writing…' : `执行写入${preview ? ` (${pendingCount})` : ''}`}
        </button>
      </div>

      {error && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>{error}</div>}

      {preview && (
        <div style={{ fontSize: 'var(--fs-13)' }} className="space-y-1">
          <div>
            <b>{preview.missing.length}</b> missing ({rm(sum(preview.missing))}) · <b>{preview.reshape.length}</b> reshape ({rm(sum(preview.reshape))}) · {preview.current} already current
          </div>
          {pendingCount > 0 && (
            <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 'var(--radius-sm, 6px)', padding: '4px 8px' }}>
              {[...preview.missing, ...preview.reshape].map((i) => (
                <div key={i.invoiceNumber} style={{ display: 'flex', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{i.invoiceNumber}</span>
                  <span style={soft}>{i.kind}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>{rm(i.totalSen)}</span>
                </div>
              ))}
            </div>
          )}
          {pendingCount === 0 && <div style={{ color: 'var(--c-good, #2f5d4f)' }}>账已齐 — 没有要补的发票。</div>}
        </div>
      )}

      {outcomes && (
        <div style={{ fontSize: 'var(--fs-13)' }} className="space-y-1">
          <div>
            写入结果:<b>{outcomes.length - failed.length}</b> done{failed.length > 0 && <> · <span style={{ color: 'var(--c-danger, #a33)' }}>{failed.length} failed</span></>}
          </div>
          {failed.length > 0 && (
            <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 'var(--radius-sm, 6px)', padding: '4px 8px' }}>
              {failed.map((o) => (
                <div key={o.invoiceNumber} style={{ display: 'flex', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{o.invoiceNumber}</span>
                  <span style={{ color: 'var(--c-danger, #a33)' }}>{o.reason ?? o.outcome}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
