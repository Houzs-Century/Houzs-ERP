// ----------------------------------------------------------------------------
// PurchaseInvoiceFromGrn — GRN LINE → Purchase Invoice picker.
//
// A purchase invoice belongs to ONE goods-received note (purchase_invoices has
// a single grn_id FK), so this picker locks to one note at a time: tick the
// lines you want to bill from a single note, then Continue to the review
// screen where you confirm prices/dates and click Create. Nothing is invoiced
// until that final Create — this page only carries your picks forward.
//
// Lines from other notes are dimmed while one note is active; clear your picks
// to switch notes. Each line is capped at its REMAINING quantity (accepted
// minus already-invoiced minus returned), so a part-billed note still shows
// only what is left to bill.
//
// Routing: /purchase-invoices/from-grn — full-page form so the chrome matches
// GrnFromPo / PurchaseInvoiceNew.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/PurchaseInvoiceFromGrn.tsx.
// Import boundary only: react-router → react-router-dom; the outstanding-GRN
// picker hook stays in suppliers-queries (vendor path); NotifyDialog → vendor;
// nav repointed to /scm/purchase-invoices.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { writeScmHandoff } from '../../lib/scmHandoffStorage';
import { readConvertScope, UnrecognisedScopeNotice } from '../../lib/convertScope';
import { ArrowRight, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { fmtDateOrDash } from '../../vendor/shared/format';
import {
  useOutstandingGrnItems,
  type OutstandingGrnItem,
} from '../../vendor/scm/lib/suppliers-queries';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

export const PurchaseInvoiceFromGrn = () => {
  const navigate = useNavigate();
  const itemsQ   = useOutstandingGrnItems();
  const notify   = useNotify();

  const [picks, setPicks] = useState<Record<string, { picked: boolean; qty: number }>>({});

  /* "Transfer to Purchase Invoice" on a GRN lands here with ?grnId=<id> so the operator sees
     the note they were just looking at, not every outstanding note in the
     company. The parameter was being constructed by both callers and dropped
     here until 2026-08-16. No parameter → the full picker, which is what the
     list toolbar's "From GRN" button wants. */
  const [searchParams] = useSearchParams();
  const scope = useMemo(
    () => readConvertScope('grnToPi', searchParams, []),
    [searchParams],
  );

  const allItems = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);
  const items = useMemo(
    () => (scope.keys.size === 0 ? allItems : allItems.filter((it) => scope.keys.has(it.grnId))),
    [allItems, scope.keys],
  );

  // Group by GRN doc no so the UI renders one card per GRN.
  const grouped = useMemo(() => {
    const byDoc = new Map<string, { meta: OutstandingGrnItem; lines: OutstandingGrnItem[] }>();
    for (const it of items) {
      const cur = byDoc.get(it.grnDocNo);
      if (cur) cur.lines.push(it);
      else byDoc.set(it.grnDocNo, { meta: it, lines: [it] });
    }
    return [...byDoc.entries()].map(([docNo, { meta, lines }]) => ({ docNo, meta, lines }));
  }, [items]);

  /* The SUPPLIER currently being billed = the supplier of the first ticked
     line. One supplier invoice may cover SEVERAL of that supplier's notes
     (owner 2026-08-06), so notes no longer lock each other — only lines from a
     DIFFERENT supplier are locked out, because a PI is one supplier's bill.
     activeGrnId stays as the PRIMARY note ref carried to the review screen. */
  const activeSupplierId = useMemo(() => {
    for (const it of items) {
      const p = picks[it.grnItemId];
      if (p?.picked && p.qty > 0) return it.supplierId;
    }
    return null;
  }, [picks, items]);

  /* The PI header carries ONE currency + FX rate, so notes that landed under a
     different pair can't share the document even for the same supplier. */
  const fxKeyOf = (it: OutstandingGrnItem) => `${it.currency ?? 'MYR'}|${it.exchangeRate ?? 1}`;
  const activeFxKey = useMemo(() => {
    for (const it of items) {
      const p = picks[it.grnItemId];
      if (p?.picked && p.qty > 0) return fxKeyOf(it);
    }
    return null;
  }, [picks, items]);

  const activeGrnId = useMemo(() => {
    for (const it of items) {
      const p = picks[it.grnItemId];
      if (p?.picked && p.qty > 0) return it.grnId;
    }
    return null;
  }, [picks, items]);

  /* Notes this selection spans — drives the "billing N notes" hint + the
     handoff so the review screen knows to load every one of them. */
  const pickedGrnIds = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      const p = picks[it.grnItemId];
      if (p?.picked && p.qty > 0) set.add(it.grnId);
    }
    return [...set];
  }, [picks, items]);

  const togglePick = (it: OutstandingGrnItem) => {
    if (activeSupplierId && activeSupplierId !== it.supplierId) return; // one supplier per invoice
    if (activeFxKey && activeFxKey !== fxKeyOf(it)) return;             // one currency + rate per invoice
    setPicks((s) => ({
      ...s,
      [it.grnItemId]: s[it.grnItemId]?.picked
        ? { picked: false, qty: 0 }
        : { picked: true, qty: s[it.grnItemId]?.qty || it.remaining },
    }));
  };

  const setQty = (it: OutstandingGrnItem, qty: number) =>
    setPicks((s) => ({ ...s, [it.grnItemId]: { picked: true, qty } }));

  const toggleAllInGrn = (lines: OutstandingGrnItem[], on: boolean) =>
    setPicks((s) => {
      const next = { ...s };
      for (const l of lines) next[l.grnItemId] = on ? { picked: true, qty: l.remaining } : { picked: false, qty: 0 };
      return next;
    });

  const clearAll = () => setPicks({});

  /* Scoped entry pre-ticks the note's remaining lines at full quantity, so the
     screen is a ready-to-review draft rather than a filtered list to re-tick by
     hand. Copies GrnFromPo, the one convert that already worked. Nothing is
     invoiced here — Continue only carries the picks to the New PI form. */
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current) return;
    if (scope.keys.size === 0) return;
    if (itemsQ.isLoading) return;
    prefilled.current = true;
    const mine = items.filter((it) => it.remaining > 0);
    const first = mine[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mine[0] is typed non-optional without noUncheckedIndexedAccess; an empty scope match is real
    if (!first) return;
    // One supplier + one currency/rate per invoice — tick only what can share
    // the document, even if the scope spans notes that cannot.
    const fxLock = fxKeyOf(first);
    setPicks(() => {
      const next: Record<string, { picked: boolean; qty: number }> = {};
      for (const l of mine) {
        if (l.supplierId !== first.supplierId) continue;
        if (fxKeyOf(l) !== fxLock) continue;
        next[l.grnItemId] = { picked: true, qty: l.remaining };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fxKeyOf is a pure formatter over the row already in `items`
  }, [items, itemsQ.isLoading, scope.keys]);

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  const onContinue = () => {
    if (pickedCount === 0 || !activeGrnId) { notify({ title: 'Tick at least one line first.', tone: 'error' }); return; }
    const stash = picked.map(([grnItemId, v]) => ({ grnItemId, qty: v.qty }));
    if (!writeScmHandoff('piFromGrnPicks', stash)) {
      notify({ title: 'Unable to continue', body: 'This browser could not safely store your picked lines. Your selection is still here; free some browser storage and try again.', tone: 'error' });
      return;
    }
    /* grnId = the PRIMARY note (the review screen's header context); grnIds =
       every note the picks span, so the review screen loads them all and the
       created PI bills the lot as ONE invoice. */
    const extra = pickedGrnIds.length > 1 ? `&grnIds=${encodeURIComponent(pickedGrnIds.join(','))}` : '';
    navigate(`/scm/purchase-invoices/new?grnId=${encodeURIComponent(activeGrnId)}${extra}&fromPicks=1`);
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Procurement"
        title="Bill a Goods-Received Note"
        actions={
          <div className={styles.actions}>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/purchase-invoices')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button
              variant="primary" size="md"
              onClick={onContinue}
              disabled={pickedCount === 0}
            >
              <ArrowRight {...ICON} />
              {pickedCount === 0
                ? 'Pick at least 1 line'
                : `Continue with ${pickedCount} line${pickedCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        }
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Outstanding GRN Lines</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <Button variant="ghost" size="sm" onClick={clearAll} disabled={Object.keys(picks).length === 0}>
              <X {...ICON} /> Clear picks
            </Button>
            <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              {/* The ternary went loading → empty with no error arm, so a failed
                  read announced that every posted GRN had already been invoiced
                  — the opposite of the truth, and revenue goes unbilled on it.

                  AND THE EMPTY ARM SAID THE SAME THING (owner 2026-08-17). On
                  the purchase side that sentence is the expensive one: an
                  operator who believes a note is fully invoiced stops looking,
                  and the unlinked-line defect means a receipt can read as
                  outstanding while a PI already billed it — the two errors point
                  opposite ways and both end in a supplier paid wrong. An empty
                  read establishes nothing: scopeToCompany fails closed
                  (scm/lib/companyScope.ts -> .in('company_id', []) returns []
                  with error: null), PostgREST truncates at db-max-rows in
                  silence, and a swallowed read error is shaped like an empty
                  one. Say what was searched; let the note's own balance say
                  what is true. */}
              {itemsQ.isLoading ? 'Loading…'
                : itemsQ.isError ? "We couldn't load the outstanding lines — please refresh and try again."
                : items.length === 0 ? (allItems.length > 0
                    ? `None of the ${allItems.length} outstanding line(s) that loaded belong to the note you came from — use “Show all outstanding notes” to see the rest.`
                    : 'This search came back with no outstanding GRN lines. That is not the same as every posted note having been billed — the list only covers the company you are working in, and notes it cannot see look identical to notes that are done. Open the goods-received note and check its invoiced balance before treating this as nothing left to bill.')
                : `${items.length} line${items.length === 1 ? '' : 's'} across ${grouped.length} GRN${grouped.length === 1 ? '' : 's'}`}
            </span>
          </div>
        </div>
        <div style={{ padding: '0 var(--space-4)' }}>
          <UnrecognisedScopeNotice unknown={scope.unknown} />
        </div>
        {scope.keys.size > 0 && (
          <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-12)', padding: '0 var(--space-4) var(--space-2)' }}>
            Showing{' '}
            <strong>
              {scope.keys.size === 1
                ? (grouped[0]?.docNo ?? 'this note')
                : `${scope.keys.size} notes`}
            </strong>{' '}
            only.{' '}
            <Link to="/scm/purchase-invoices/from-grn" style={{ color: 'var(--c-burnt)', textDecoration: 'underline' }}>
              Show all outstanding notes
            </Link>
          </p>
        )}
        <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)', padding: '0 var(--space-4) var(--space-2)' }}>
          One purchase invoice covers one supplier — tick lines from as many of that supplier&rsquo;s notes as the
          invoice bills, then Continue to review. Nothing is invoiced until you click Create on the next screen.
          {pickedGrnIds.length > 1 && (
            <strong style={{ color: 'var(--c-burnt)' }}> Billing {pickedGrnIds.length} notes as one invoice.</strong>
          )}
        </p>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {grouped.length === 0 && !itemsQ.isLoading && (
            <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>
              Once a GRN is posted (and not yet fully invoiced), its lines will show up here.
            </p>
          )}
          {grouped.map(({ docNo, meta, lines }) => {
            /* Locked only when the note can't share the document: a DIFFERENT
               supplier, or the same supplier under a different currency/rate
               (the PI header carries one pair). Same supplier + same pair =
               tickable alongside, which is the whole point of multi-note. */
            const otherSupplier = Boolean(activeSupplierId) && activeSupplierId !== meta.supplierId;
            const otherFx       = Boolean(activeFxKey) && activeFxKey !== fxKeyOf(meta);
            const locked        = otherSupplier || otherFx;
            const allPicked = lines.every((l) => picks[l.grnItemId]?.picked);
            return (
              <div key={docNo} style={{
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--c-paper)',
                padding: 'var(--space-3) var(--space-4)',
                opacity: locked ? 0.5 : 1,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: locked ? 'not-allowed' : 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={allPicked}
                      disabled={locked}
                      onChange={() => toggleAllInGrn(lines, !allPicked)}
                    />
                    <strong>{docNo}</strong>
                  </label>
                  <span style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
                    {[meta.supplierName || meta.supplierCode,
                      meta.poDocNo ? `PO ${meta.poDocNo}` : null,
                      `Received ${fmtDateOrDash(meta.receivedAt)}`,
                    ].filter(Boolean).join(' · ')}
                  </span>
                  {locked && (
                    <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-soft)', fontStyle: 'italic' }}>
                      {otherSupplier
                        ? 'Different supplier — clear your picks to bill this note instead'
                        : 'Different currency — clear your picks to bill this note instead'}
                    </span>
                  )}
                </div>

                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '24px minmax(120px, 1fr) minmax(200px, 2fr) 90px 80px 110px',
                  gap: 'var(--space-2)',
                  alignItems: 'center',
                  fontSize: 'var(--fs-12)',
                  fontFamily: 'var(--font-button)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--fg-soft)',
                  padding: 'var(--space-2) 0',
                  borderBottom: '1px solid var(--line)',
                }}>
                  <div></div>
                  <div>Item Code</div>
                  <div>Description</div>
                  <div style={{ textAlign: 'right' }}>Remaining</div>
                  <div style={{ textAlign: 'right' }}>Bill Qty</div>
                  <div style={{ textAlign: 'right' }}>Line Value</div>
                </div>

                {lines.map((l) => {
                  const p = picks[l.grnItemId];
                  const on = Boolean(p?.picked);
                  const pickQty = on ? p!.qty : l.remaining;
                  return (
                    <div
                      key={l.grnItemId}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '24px minmax(120px, 1fr) minmax(200px, 2fr) 90px 80px 110px',
                        gap: 'var(--space-2)',
                        alignItems: 'center',
                        padding: 'var(--space-2) 0',
                        borderBottom: '1px solid var(--line)',
                        background: on ? 'rgba(213, 90, 40, 0.04)' : 'transparent',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={locked}
                        onChange={() => togglePick(l)}
                      />
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)' }}>{l.itemCode}</span>
                      <div style={{ fontSize: 'var(--fs-13)' }}>
                        <VariantDescription
                          itemCode={l.itemCode}
                          itemGroup={l.itemGroup}
                          variants={l.variants}
                          description={l.description}
                        />
                      </div>
                      <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)' }}>{l.remaining}</span>
                      <input
                        type="number"
                        min={0}
                        max={l.remaining}
                        value={on ? pickQty : ''}
                        placeholder={String(l.remaining)}
                        onChange={(e) => setQty(l, Math.min(l.remaining, Math.max(0, Number(e.target.value) || 0)))}
                        disabled={!on || locked}
                        className={styles.fieldInput}
                        style={{ textAlign: 'right', padding: '4px 6px', fontSize: 'var(--fs-13)' }}
                      />
                      <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
                        {fmtRm(pickQty * l.unitPriceCenti)}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
