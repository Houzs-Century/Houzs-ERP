// ----------------------------------------------------------------------------
// PaymentVoucherScan — the bill pile, read and grouped, at
// /scm/payment-vouchers/scan.
//
// The owner's three cases (2026-09-02), his taxonomy exactly:
//   1. 一张bill 几页   — tick the pages, press 合并: they become ONE bill;
//   2. 一个supplier 多张单 — recognised bills GROUP by supplier, and a group
//      opens as ONE voucher, one line per bill (a statement payment);
//   3. 多个supplier 多个单 — every other group/bill opens separately.
//
// The rule that keeps it honest: ONE FILE = ONE BILL unless a human merged
// pages at upload. The reader never guesses whether two files are one
// document. And NOTHING saves here — each "Open as voucher" lands on the New
// page pre-filled, where a person picks the account, checks the figures and
// saves through the untouched approval cycle.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, FileText, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useExtractBills, fileToBase64, type ExtractedBill, type BillExtraction, type VendorMemory } from '../../vendor/scm/lib/payment-voucher-queries';
import { fmtDate } from '../../vendor/shared/format';
import { PageHeader } from '../../components/Layout';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (sen: number | null | undefined): string =>
  sen == null ? '—' : `MYR ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type PickedFile = { rid: string; file: File; merged: boolean };

export const PaymentVoucherScan = () => {
  const navigate = useNavigate();
  const extract = useExtractBills();

  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  /* bills[i] = the rids that form bill i (merged pages share an entry). */
  const [billGroups, setBillGroups] = useState<string[][]>([]);
  const [results, setResults] = useState<ExtractedBill[] | null>(null);
  const [splitGroups, setSplitGroups] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...list].map((f) => ({ rid: `f${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, file: f, merged: false }));
    setPicked((prev) => [...prev, ...next]);
    setBillGroups((prev) => [...prev, ...next.map((p) => [p.rid])]);
    setResults(null);
  };

  /* 合并所选 — the ticked files become ONE bill (case 1). */
  const mergeTicked = () => {
    if (ticked.size < 2) return;
    setBillGroups((prev) => {
      const kept = prev.filter((g) => !g.some((rid) => ticked.has(rid)));
      const mergedRids = prev.flat().filter((rid) => ticked.has(rid));
      return [...kept, [mergedRids].flat().length > 0 ? mergedRids : []].filter((g) => g.length > 0);
    });
    setPicked((prev) => prev.map((p) => (ticked.has(p.rid) ? { ...p, merged: true } : p)));
    setTicked(new Set());
    setResults(null);
  };

  const removeFile = (rid: string) => {
    setPicked((prev) => prev.filter((p) => p.rid !== rid));
    setBillGroups((prev) => prev.map((g) => g.filter((r) => r !== rid)).filter((g) => g.length > 0));
    setResults(null);
  };

  const run = async () => {
    setNote('Reading…');
    try {
      const byRid = new Map(picked.map((p) => [p.rid, p.file]));
      const bills = await Promise.all(billGroups.map(async (g) => ({
        files: await Promise.all(g.map(async (rid) => {
          const f = byRid.get(rid)!;
          return { name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) };
        })),
      })));
      const res = await extract.mutateAsync(bills);
      setResults(res.bills);
      const failed = res.bills.filter((b) => !b.ok).length;
      setNote(failed > 0 ? `${failed} bill(s) could not be read — they are listed below with the reason.` : null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'The pile could not be read.');
    }
  };

  /* Group the READ bills by matched supplier; unmatched ones group by the
     printed vendor name so two TNB bills still sit together. */
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; supplierId: string | null; bills: Array<Extract<ExtractedBill, { ok: true }>> }>();
    for (const b of results ?? []) {
      if (!b.ok) continue;
      const key = b.supplierMatch ? `s:${b.supplierMatch.id}` : `v:${(b.extraction.vendorName ?? `bill-${b.index}`).toUpperCase()}`;
      const cur = map.get(key) ?? {
        label: b.supplierMatch?.name ?? b.extraction.vendorName ?? `Unnamed bill ${b.index + 1}`,
        supplierId: b.supplierMatch?.id ?? null,
        bills: [],
      };
      cur.bills.push(b);
      map.set(key, cur);
    }
    return [...map.entries()].map(([key, g]) => ({ key, ...g }));
  }, [results]);

  const openVoucher = (extraction: BillExtraction, extras?: { lines?: Array<{ description: string | null; amountSen: number | null }>; memory?: VendorMemory | null }) => {
    navigate('/scm/payment-vouchers/new', { state: { billPrefill: { extraction, ...(extras?.lines ? { lines: extras.lines } : {}), memory: extras?.memory ?? null } } });
  };

  const openGroupAsOne = (g: { label: string; bills: Array<Extract<ExtractedBill, { ok: true }>> }) => {
    const first = g.bills[0]!;
    const lines = g.bills.map((b) => ({
      description: [g.label, b.extraction.invoiceNumber].filter(Boolean).join(' '),
      amountSen: b.extraction.totalSen,
    }));
    /* One vendor per group by construction, so the first bill's memory IS the
       group's. */
    openVoucher(
      { ...first.extraction, invoiceNumber: g.bills.map((b) => b.extraction.invoiceNumber).filter(Boolean).join(', ') || null },
      { lines, memory: first.memory },
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader back eyebrow="Finance" title="Scan bills" />

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>The pile</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            one file = one bill · tick pages of the same bill and press Merge
          </span>
        </div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)' }}>
              <Camera {...ICON} /> Add bills
              <input type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf"
                aria-label="Add bill files" style={{ display: 'none' }}
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
            <Button variant="secondary" size="sm" onClick={mergeTicked} disabled={ticked.size < 2}>
              Merge {ticked.size > 1 ? `${ticked.size} pages` : 'pages'} into one bill
            </Button>
            <span style={{ flex: 1 }} />
            <Button variant="primary" size="sm" onClick={() => void run()} disabled={picked.length === 0 || extract.isPending}>
              {extract.isPending ? 'Reading…' : `Read ${billGroups.length} bill(s)`}
            </Button>
          </div>

          {picked.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {picked.map((p) => (
                <div key={p.rid} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-13)' }}>
                  <input type="checkbox" aria-label={`Select ${p.file.name}`}
                    checked={ticked.has(p.rid)}
                    onChange={(e) => setTicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(p.rid); else n.delete(p.rid); return n; })}
                    style={{ width: 15, height: 15, accentColor: 'var(--c-orange)' }} />
                  <FileText {...ICON} />
                  <span>{p.file.name}</span>
                  {p.merged && <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>(merged page)</span>}
                  <button type="button" aria-label={`Remove ${p.file.name}`} onClick={() => removeFile(p.rid)}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--fg-muted)' }}>
                    <X size={14} strokeWidth={1.75} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {note && <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)' }}>{note}</div>}
        </div>
      </section>

      {results && (
        <>
          {groups.map((g) => {
            const split = splitGroups.has(g.key) || g.bills.length === 1;
            return (
              <section key={g.key} className={styles.card}>
                <div className={styles.cardHeader}>
                  <h2 className={styles.cardTitle}>{g.label}</h2>
                  <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                    {g.bills.length} bill(s) · {fmtRm(g.bills.reduce((s, b) => s + (b.extraction.totalSen ?? 0), 0))}
                    {g.supplierId ? ' · matched supplier' : ' · no supplier match'}
                    {g.bills[0]?.memory?.debitAccountCode ? ` · account remembered (${g.bills[0].memory.debitAccountCode})` : ''}
                  </span>
                </div>
                <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  {g.bills.map((b) => (
                    <div key={b.index} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', fontSize: 'var(--fs-13)', flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{b.extraction.invoiceNumber ?? '(no number)'}</span>
                      <span style={{ color: 'var(--fg-muted)' }}>{fmtDate(b.extraction.invoiceDate)}</span>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(b.extraction.totalSen)}</span>
                      {b.extraction.totalSen == null && <span style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-12)' }}>total unreadable — will need typing</span>}
                      {split && (
                        <Button variant="secondary" size="sm" onClick={() => openVoucher(b.extraction, { memory: b.memory })}>
                          Open as voucher
                        </Button>
                      )}
                    </div>
                  ))}
                  {g.bills.length > 1 && (
                    <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
                      <label style={{ fontSize: 'var(--fs-12)', display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                        <input type="checkbox" checked={split}
                          aria-label={`Pay ${g.label} bills separately`}
                          onChange={(e) => setSplitGroups((prev) => { const n = new Set(prev); if (e.target.checked) n.add(g.key); else n.delete(g.key); return n; })}
                          style={{ width: 15, height: 15, accentColor: 'var(--c-orange)' }} />
                        pay each bill separately
                      </label>
                      {!split && (
                        <Button variant="primary" size="sm" onClick={() => openGroupAsOne(g)}>
                          Open as ONE voucher ({g.bills.length} lines)
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
          {results.filter((b) => !b.ok).map((b) => (
            <section key={`fail-${b.index}`} className={styles.card}>
              <div className={styles.cardBody} style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-13)' }}>
                Bill {b.index + 1} could not be read: {(b as { reason: string }).reason}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
};
