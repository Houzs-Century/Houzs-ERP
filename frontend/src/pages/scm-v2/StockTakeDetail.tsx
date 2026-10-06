// ----------------------------------------------------------------------------
// StockTakeDetail — at /inventory/stock-takes/:id (PR — Inv PR5).
//
// OPEN: edit counted_qty per line, Save → PATCH /lines, Post → flips to
// POSTED and writes one ADJUSTMENT movement per non-zero-variance line.
// POSTED/CANCELLED: read-only with variance summary.
// PR-DRAFT-removal (2026-05-27): DRAFT renamed to OPEN. Stock takes keep
// an editable working state because the commander has to enter counted_qty
// per line BEFORE posting; "OPEN" makes the intent clearer.
//
// Round 1 (owner 2026-10-06): ASSIGNEES (several) are a record, editable with
// the notes while OPEN, and do not gate Post; Add line for stock the sheet
// does not list; RM gain/loss from the server's per-line cost estimate; the
// column header stays on screen while scrolling (sticky).
//
// Phase 1 (owner-approved 2026-08-08, mig 0270):
//   • MODEL view (default): lines grouped by product code via the pure fold
//     in stock-take-grouping.ts — "CODY · 12 lines · system 3" expands to its
//     variant lines; "All zero" fills a group with 0. Flat view stays.
//   • BLIND: when viewer.blindActive the server strips system_qty/variance,
//     so the two columns (and Match/Fill-all) disappear entirely.
//   • Every counted cell shows WHO counted it and WHEN (counted_by/_at).
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/StockTakeDetail.tsx.
// Import boundary only: react-router → react-router-dom; Skeleton/ConfirmDialog/
// NotifyDialog/StatusPill ← vendored; take hooks ← vendored stock-queries;
// fmtDateOrDash + buildVariantSummary via @2990s/shared; css colocated.
// Back/Close → list, Delete → /scm/stock-takes.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { History, Save, X, Trash2, Send, Ban, AlertTriangle, Search, Wand2, Undo2, ChevronRight, ChevronDown, EyeOff, Rows3, List, Printer, Pencil, Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { fmtDateOrDash, fmtDateTime, fmtQty, fmtSen } from '@2990s/shared';
import {
  useStockTakeDetail,
  useUpdateStockTakeLines,
  usePostStockTake,
  useCancelStockTake,
  useReverseStockTake,
  useDeleteStockTake,
  useUpdateStockTakeHeader,
  useAddStockTakeLine,
  useStockTakeBucketOptions,
  stockTakeAssignees,
  type StockTakeStatus,
  type StockTakeLine,
} from '../../vendor/scm/lib/stock-queries';
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
import { useMfgProducts } from '../../vendor/scm/lib/mfg-products-queries';
import { StaffMultiPick } from '../../vendor/scm/components/StaffMultiPick';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { EntityHistoryPanel } from './EntityHistoryPanel';
import { STOCK_TAKE_AUDIT_LABELS } from './entity-audit-labels';
import { groupByModel } from './stock-take-grouping';
import { useStaffLookup } from '../../hooks/useStaffLookup';
import { PrintPreviewModal, useOpenPrintPreviewFromUrl, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import { warehouseLabel } from '../../vendor/scm/lib/warehouse-label';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const scopeLabel = (scopeType: string, scopeValue: string | null): string => {
  if (scopeType === 'ALL') return 'All SKUs';
  if (scopeType === 'CATEGORY') return `Category · ${scopeValue ?? '—'}`;
  if (scopeType === 'CODE_PREFIX') return `Prefix · ${scopeValue ?? '—'}`;
  return scopeType;
};

// Local row state: counted_qty as string so empty input = null, not 0.
type LineDraft = {
  id: string;
  itemCode: string;
  productName: string | null;
  variantLabel: string | null;
  /* null while the server strips it (blind take, non-supervisor viewer). */
  systemQty: number | null;
  countedQtyInput: string;   // '' means uncounted
  notes: string;
  origCountedQty: number | null;
  origNotes: string;
  /* WHO/WHEN this cell was counted (mig 0270) — display-only here. */
  countedBy: string | null;
  countedAt: string | null;
  /* Round 1: unit cost (sen) the post would value a variance at; null = none. */
  estUnitCostSen: number | null;
  addedOnCount: boolean;
};

const toDraft = (l: StockTakeLine): LineDraft => ({
  id:               l.id,
  itemCode:      l.item_code,
  productName:      l.product_name,
  variantLabel:     l.variant_label,
  systemQty:        l.system_qty,
  countedQtyInput:  l.counted_qty == null ? '' : String(l.counted_qty),
  notes:            l.notes ?? '',
  origCountedQty:   l.counted_qty,
  origNotes:        l.notes ?? '',
  countedBy:        l.counted_by ?? null,
  countedAt:        l.counted_at ?? null,
  estUnitCostSen:   l.est_unit_cost_sen ?? null,
  addedOnCount:     l.added_on_count === true,
});

const parseCounted = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Math.max(0, Math.floor(Number(s)));
  if (!Number.isFinite(n)) return null;
  return n;
};

/* The RM a line's variance is worth, in sen; null when there is no variance
   to show or no cost to value it at. */
const valueOf = (d: LineDraft): number | null => {
  const v = varianceOf(d);
  return v == null || d.estUnitCostSen == null ? null : v * d.estUnitCostSen;
};

/* null = "no variance to show": uncounted, OR system qty hidden (blind). */
const varianceOf = (d: LineDraft): number | null => {
  const c = parseCounted(d.countedQtyInput);
  if (c == null || d.systemQty == null) return null;
  return c - d.systemQty;
};

export const StockTakeDetail = () => {
  const { id }   = useParams<{ id: string }>();
  const navigate = useNavigate();

  /* History drawer. Stable close handler so the memoized panel does not
     re-render on every count keystroke. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  const detail = useStockTakeDetail(id ?? null);
  const update = useUpdateStockTakeLines();
  const post    = usePostStockTake();
  const cancel  = useCancelStockTake();
  const reverse = useReverseStockTake();
  const del     = useDeleteStockTake();

  const askConfirm = useConfirm();
  const notify = useNotify();

  const [lines,  setLines]  = useState<LineDraft[]>([]);
  const [search, setSearch] = useState<string>('');
  const [dirty,  setDirty]  = useState<boolean>(false);
  /* Model view is the DEFAULT — variant-heavy categories are why it exists.
     Flat is the toggle (owner phase 1). */
  const [view, setView] = useState<'model' | 'flat'>('model');
  /* Expanded model groups (multi-line groups start collapsed to one header). */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /* Header edit (round 1): assignees + notes while OPEN. */
  const updateHeader = useUpdateStockTakeHeader();
  const pickableStaff = usePickableStaff();
  const [editingHeader, setEditingHeader] = useState(false);
  const [draftAssignees, setDraftAssignees] = useState<string[]>([]);
  const [draftNotes, setDraftNotes] = useState('');

  useEffect(() => {
    if (!detail.data) return;
    setLines(detail.data.lines.map(toDraft));
    setDirty(false);
  }, [detail.data]);

  const status: StockTakeStatus | undefined = detail.data?.take.status;
  const isDraft  = status === 'OPEN';      // local var name kept for diff minimization; refers to OPEN state
  const isPosted = status === 'POSTED';

  /* Server-decided viewer facts (backend GET /:id). The fallback only matters
     against an older worker that omits `viewer` — behave exactly as before
     this phase (no blind, buttons enabled; the backend still enforces). */
  const viewer = detail.data?.viewer ?? { isAssignee: true, canSupervise: true, blindActive: false };
  const blindActive = viewer.blindActive;
  /* Owner 2026-10-06: the assignees are a record of who counted, not a gate —
     anyone who can open the take can post it (a big variance still needs a
     supervisor, enforced by the server). */

  /* id → name for assignee + per-cell counted-by (same idiom as the Stock
     Adjustments "Performed By" column — never render a uuid). */
  const { actorNameOf } = useStaffLookup();

  const filteredLines = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((l) =>
      l.itemCode.toLowerCase().includes(q) ||
      (l.productName ?? '').toLowerCase().includes(q) ||
      (l.variantLabel ?? '').toLowerCase().includes(q),
    );
  }, [lines, search]);

  /* Model groups over the FILTERED lines — search narrows, then groups. */
  const groups = useMemo(() => groupByModel(filteredLines), [filteredLines]);

  // ── Aggregates ───────────────────────────────────────────────────────
  const totals = useMemo(() => {
    let counted = 0;
    let uncounted = 0;
    let variancePos = 0;
    let varianceNeg = 0;
    let nonZeroVarianceLines = 0;
    let valuePosSen = 0;
    let valueNegSen = 0;
    let uncostedVarianceLines = 0;
    for (const l of lines) {
      /* Counted-ness is judged on the ENTRY, not the variance — on a blind
         take variance is unknowable here, but "how many cells are done" must
         still be right. */
      const c = parseCounted(l.countedQtyInput);
      if (c == null) { uncounted += 1; continue; }
      counted += 1;
      const v = varianceOf(l);
      if (v == null) continue; // blind — variance unknown to this viewer
      if (v > 0) variancePos += v;
      if (v < 0) varianceNeg += v;       // negative number
      if (v !== 0) nonZeroVarianceLines += 1;
      const val = valueOf(l);
      if (v !== 0 && val == null) uncostedVarianceLines += 1;
      if (val != null && val > 0) valuePosSen += val;
      if (val != null && val < 0) valueNegSen += val;
    }
    return {
      counted, uncounted,
      variancePos, varianceNeg,
      varianceNet: variancePos + varianceNeg,
      nonZeroVarianceLines,
      valuePosSen, valueNegSen, valueNetSen: valuePosSen + valueNegSen,
      uncostedVarianceLines,
      totalLines: lines.length,
    };
  }, [lines]);

  /* ── Print ──────────────────────────────────────────────────────────────
     This document had no print handler at all until now, on any surface.
     (A fabricated owner quote was attached here and has been removed — see
     row-menus.ts for the provenance note.)

     The SERVER rows, not the local drafts: a count that has not been saved is
     not yet part of the record, and a printed sheet that carries typed-but-
     unsaved numbers is a document nobody can reconcile against the take.

     BLIND NEEDS NO SPECIAL CASE HERE. The server has already stripped
     `system_qty` / `variance` from this payload for a non-supervising viewer,
     so the generator has nothing to leak and prints a count sheet instead.

     "Print now" goes through the PDF (action: 'print') and never
     window.print(): index.css's @media print block hides `body *`, so printing
     this page directly yields a blank sheet. */
  const deliverPrintPdf = (action: PdfAction) => {
    const d = detail.data;
    if (!d) return;
    return import('../../vendor/scm/lib/stock-take-pdf')
      .then(({ generateStockTakePdf }) => generateStockTakePdf(
        {
          ...d.take,
          /* Resolved here, never inside the PDF lib — `assignee_staff_id` is a
             uuid and a uuid never reaches a person. */
          assignee_name: stockTakeAssignees(d.take).map((x) => actorNameOf(x)).join(', ') || null,
        },
        d.lines,
        { action },
      ))
      .catch((e) => notify({
        title: 'PDF generation failed',
        body: e instanceof Error ? e.message : 'Something went wrong.',
        tone: 'error',
      }));
  };
  const print = usePrintPreview(deliverPrintPdf);
  /* The list's right-click Print navigates here with ?print=1 — same contract
     every other document's row menu uses. */
  useOpenPrintPreviewFromUrl(print.openPreview, !!detail.data);

  // ── Local edit helpers ───────────────────────────────────────────────
  const setLine = (id: string, patch: Partial<LineDraft>) => {
    setLines((cur) => cur.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  const matchSystem = (id: string) => {
    setLines((cur) => cur.map((l) =>
      l.id === id && l.systemQty != null ? { ...l, countedQtyInput: String(l.systemQty) } : l,
    ));
    setDirty(true);
  };

  const matchAllToSystem = async () => {
    if (!(await askConfirm({
      title: 'Fill EVERY counted qty with the system qty?',
      body: 'This sets variance to 0 for all lines.',
      confirmLabel: 'Fill all',
    }))) return;
    setLines((cur) => cur.map((l) => (
      l.systemQty == null ? l : { ...l, countedQtyInput: String(l.systemQty) }
    )));
    setDirty(true);
  };

  /* One-click "all zero for this group" (phase 1): the common truth for a
     variant-heavy model is "none of these are physically here". Local draft
     only — Save persists, so a slip is undoable. */
  const zeroGroup = (itemCode: string) => {
    setLines((cur) => cur.map((l) =>
      l.itemCode === itemCode ? { ...l, countedQtyInput: '0' } : l,
    ));
    setDirty(true);
  };

  const toggleGroup = (itemCode: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(itemCode)) next.delete(itemCode);
      else next.add(itemCode);
      return next;
    });
  };

  // ── Mutations ────────────────────────────────────────────────────────
  const onSave = () => {
    if (!id) return;
    // Build diff payload — only lines whose counted or notes changed.
    const changed = lines.filter((l) => {
      const parsedCounted = parseCounted(l.countedQtyInput);
      return parsedCounted !== l.origCountedQty || l.notes !== l.origNotes;
    });
    if (changed.length === 0) { setDirty(false); return; }
    update.mutate(
      {
        id,
        lines: changed.map((l) => ({
          id:         l.id,
          countedQty: parseCounted(l.countedQtyInput),
          notes:      l.notes.trim() ? l.notes.trim() : null,
        })),
      },
      {
        onSuccess: () => { setDirty(false); detail.refetch(); },
        onError:   (err) => notify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  const onPost = async () => {
    if (!id) return;
    if (dirty) { notify({ title: 'Save your counts before posting.', tone: 'error' }); return; }
    const summary = blindActive
      /* Blind counter: the variance figures are exactly what they must not
         see before posting, so the confirm speaks only of coverage. */
      ? `Lines: ${totals.totalLines} (${totals.counted} counted, ${totals.uncounted} untouched)\n` +
        `Blind count — variances are revealed after posting.`
      : `Lines: ${totals.totalLines} (${totals.counted} counted, ${totals.uncounted} untouched)\n` +
        `Variance lines: ${totals.nonZeroVarianceLines}\n` +
        `Net variance: ${totals.varianceNet > 0 ? '+' : ''}${totals.varianceNet}\n` +
        `Estimated gain / loss: ${fmtSignedRM(totals.valueNetSen)}`;
    const proceed = await askConfirm({
      title: 'Post this stock take?',
      body: `${summary}\n\nOne ADJUSTMENT movement will be written per non-zero-variance line. Untouched lines (no counted qty) are skipped.`,
      confirmLabel: 'Post',
    });
    if (!proceed) return;
    post.mutate(id, {
      onSuccess: (res) => {
        detail.refetch();
        if (res.movementErrors && res.movementErrors.length > 0) {
          notify({
            title: 'Stock take posted, but adjustment write failed',
            body: `${res.movementErrors.join('\n')}\n\nFix manually via Stock Adjustments.`,
            tone: 'error',
          });
        } else {
          notify({ title: 'Posted', body: `${res.movementsWritten} adjustment movement${res.movementsWritten === 1 ? '' : 's'} written.` });
        }
      },
      onError: (err) => notify({ title: 'Post failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  const onCancel = async () => {
    if (!id) return;
    if (!(await askConfirm({
      title: 'Cancel this OPEN stock take?',
      body: 'It will be marked cancelled and locked.',
      confirmLabel: 'Cancel take',
      danger: true,
    }))) return;
    cancel.mutate(id, {
      onSuccess: () => detail.refetch(),
      onError: (err) => notify({ title: 'Cancel failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  const onReverse = async () => {
    if (!id) return;
    const proceed = await askConfirm({
      title: 'Undo this posted stock take?',
      body:
        'The stock changes it made will be reversed — every item goes back to the quantity it had before this count was posted. ' +
        'This count will then be marked Cancelled and locked.\n\n' +
        'To count again, start a new stock take.',
      confirmLabel: 'Undo',
      danger: true,
    });
    if (!proceed) return;
    reverse.mutate(id, {
      onSuccess: (res) => {
        detail.refetch();
        if (res.movementErrors && res.movementErrors.length > 0) {
          notify({
            title: 'Undone, but reversing the stock changes failed',
            body: `${res.movementErrors.join('\n')}\n\nFix manually via Stock Adjustments.`,
            tone: 'error',
          });
        } else {
          notify({
            title: 'Undone',
            body: `${res.movementsReversed} stock change${res.movementsReversed === 1 ? '' : 's'} reversed.`,
          });
        }
      },
      onError: (err) => notify({ title: 'Undo failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  const onDelete = async () => {
    if (!id) return;
    if (!(await askConfirm({
      title: 'Delete this OPEN stock take permanently?',
      body: 'The count sheet will be lost.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    del.mutate(id, {
      onSuccess: () => navigate('/scm/stock-takes'),
      onError: (err) => notify({ title: 'Delete failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  // ── Render ───────────────────────────────────────────────────────────
  if (detail.isPending) {
    return <SkeletonDetailPage />;
  }
  if (detail.error || !detail.data) {
    return (
      <div className="space-y-4">
        <p className={styles.subtitle}>
          {detail.error instanceof Error ? detail.error.message : 'Stock take not found.'}
        </p>
        <Link to="/scm/stock-takes">Back to Stock Takes</Link>
      </div>
    );
  }

  const t = detail.data.take;

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Warehouse"
        title={t.take_no}
        description={`Created ${fmtDateTime(t.created_at)}${t.posted_at ? ` · Posted ${fmtDateTime(t.posted_at)}` : ''}${t.cancelled_at ? ` · Cancelled ${fmtDateTime(t.cancelled_at)}` : ''}`}
        actions={
          <>
            {status && <StatusPill docType="stockTake" status={status} />}
            <div className={styles.actions}>
              {/* History drawer toggle. Same header seat on every detail page,
                  and unconditional: a cancelled or posted take is exactly when
                  someone needs to see who changed what. */}
              <Button variant="ghost" size="md" onClick={() => setHistoryOpen(true)}>
                <History {...ICON} /> History
              </Button>
              {/* Unconditional, like History. An OPEN take prints as the count
                  sheet somebody walks the aisles with; a POSTED one prints as
                  the variance record. Both are wanted. */}
              <Button variant="ghost" size="md" onClick={print.openPreview}>
                <Printer {...ICON} /> Print PDF
              </Button>
              {isDraft && (
                <>
                  <Button variant="ghost" size="md" onClick={onDelete} disabled={del.isPending}>
                    <Trash2 {...ICON} /> Delete
                  </Button>
                  <Button variant="ghost" size="md" onClick={onCancel} disabled={cancel.isPending}>
                    <Ban {...ICON} /> Cancel
                  </Button>
                  <Button variant="ghost" size="md" onClick={onSave} disabled={!dirty || update.isPending}>
                    <Save {...ICON} /> {update.isPending ? 'Saving…' : 'Save Counts'}
                  </Button>
                  <Button variant="primary" size="md" onClick={onPost} disabled={post.isPending || dirty}>
                    <Send {...ICON} /> {post.isPending ? 'Posting…' : 'Post'}
                  </Button>
                </>
              )}
              {isPosted && (
                <Button variant="ghost" size="md" onClick={onReverse} disabled={reverse.isPending}>
                  <Undo2 {...ICON} /> {reverse.isPending ? 'Undoing…' : 'Undo'}
                </Button>
              )}
              {!isDraft && (
                <Button variant="ghost" size="md" onClick={() => navigate('/scm/stock-takes')}>
                  <X {...ICON} /> Close
                </Button>
              )}
            </div>
          </>
        }
      />

      {/* ── Header card ─────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Setup</h2>
          {isDraft && !editingHeader && (
            <Button variant="ghost" size="sm" onClick={() => {
              setDraftAssignees(stockTakeAssignees(t));
              setDraftNotes(t.notes ?? '');
              setEditingHeader(true);
            }}>
              <Pencil size={14} strokeWidth={1.75} /> Edit
            </Button>
          )}
          {isDraft && editingHeader && (
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button variant="ghost" size="sm" onClick={() => setEditingHeader(false)}>
                <X size={14} strokeWidth={1.75} /> Cancel
              </Button>
              <Button variant="primary" size="sm" disabled={updateHeader.isPending || draftAssignees.length === 0}
                onClick={() => updateHeader.mutate(
                  { id: t.id, assigneeStaffIds: draftAssignees, notes: draftNotes.trim() || null },
                  {
                    onSuccess: () => setEditingHeader(false),
                    onError: (err) => { void notify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }); },
                  },
                )}>
                <Save size={14} strokeWidth={1.75} /> {updateHeader.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          )}
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Warehouse</span>
              <div style={{ padding: '8px 0', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)' }}>
                {t.warehouse ? `${t.warehouse.code} · ${t.warehouse.name}` : t.warehouse_id}
              </div>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Take Date</span>
              <div style={{ padding: '8px 0', fontSize: 'var(--fs-13)' }}>{fmtDateOrDash(t.take_date)}</div>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Scope</span>
              <div style={{ padding: '8px 0', fontSize: 'var(--fs-13)' }}>
                {scopeLabel(t.scope_type, t.scope_value)}
              </div>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              {editingHeader ? (
                <input type="text" className={styles.fieldInput} value={draftNotes}
                  onChange={(e) => setDraftNotes(e.target.value)} aria-label="Notes" />
              ) : (
                <div style={{ padding: '8px 0', fontSize: 'var(--fs-13)', color: t.notes ? 'var(--c-ink)' : 'var(--fg-muted)' }}>
                  {t.notes || '(none)'}
                </div>
              )}
            </div>
            {/* Phase 1 — accountability facts on the header. */}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Assignees</span>
              {editingHeader ? (
                <StaffMultiPick
                  label="Add assignee"
                  options={pickableStaff.data ?? []}
                  value={draftAssignees}
                  onChange={setDraftAssignees}
                  nameOf={actorNameOf}
                  disabled={false}
                />
              ) : (
                <div style={{ padding: '8px 0', fontSize: 'var(--fs-13)', color: stockTakeAssignees(t).length ? 'var(--c-ink)' : 'var(--fg-muted)' }}>
                  {stockTakeAssignees(t).map((x) => actorNameOf(x)).join(', ') || '(none)'}
                </div>
              )}
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Blind Count</span>
              <div style={{ padding: '8px 0', fontSize: 'var(--fs-13)', display: 'flex', alignItems: 'center', gap: 6 }}>
                {t.blind
                  ? <><EyeOff size={14} strokeWidth={1.75} /> Yes{blindActive ? ' — system qty hidden until posted' : ''}</>
                  : <span style={{ color: 'var(--fg-muted)' }}>No</span>}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Variance Summary ────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Variance Summary</h2>
        </div>
        <div className={styles.cardBody}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 'var(--space-3)',
          }}>
            <SummaryStat label="Total lines"    value={totals.totalLines.toString()} />
            <SummaryStat label="Counted"        value={totals.counted.toString()} />
            <SummaryStat label="Untouched"      value={totals.uncounted.toString()}
              tone={totals.uncounted > 0 ? 'muted' : undefined} />
            {/* Blind view: the variance figures ARE the hidden information —
                coverage stats only until posted/revealed. */}
            {!blindActive && (
              <>
                <SummaryStat label="Variance lines" value={totals.nonZeroVarianceLines.toString()} />
                <SummaryStat
                  label="+ Found"
                  value={`+${fmtQty(totals.variancePos)}`}
                  tone={totals.variancePos > 0 ? 'positive' : 'muted'}
                />
                <SummaryStat
                  label="− Lost"
                  value={fmtQty(totals.varianceNeg)}
                  tone={totals.varianceNeg < 0 ? 'negative' : 'muted'}
                />
                <SummaryStat
                  label="Net"
                  value={`${totals.varianceNet > 0 ? '+' : ''}${fmtQty(totals.varianceNet)}`}
                  tone={totals.varianceNet > 0 ? 'positive' : totals.varianceNet < 0 ? 'negative' : 'muted'}
                />
                {/* Owner 2026-10-06: what the count is worth in money, at the
                    cost the post would book it at. An estimate until posted —
                    the post re-reads live stock. */}
                <SummaryStat
                  label="+ Gain (RM)"
                  value={fmtSignedRM(totals.valuePosSen)}
                  tone={totals.valuePosSen > 0 ? 'positive' : 'muted'}
                />
                <SummaryStat
                  label="− Loss (RM)"
                  value={fmtSignedRM(totals.valueNegSen)}
                  tone={totals.valueNegSen < 0 ? 'negative' : 'muted'}
                />
                <SummaryStat
                  label={totals.uncostedVarianceLines > 0
                    ? `Net (RM) · ${totals.uncostedVarianceLines} line${totals.uncostedVarianceLines === 1 ? '' : 's'} uncosted`
                    : 'Net (RM)'}
                  value={fmtSignedRM(totals.valueNetSen)}
                  tone={totals.valueNetSen > 0 ? 'positive' : totals.valueNetSen < 0 ? 'negative' : 'muted'}
                />
              </>
            )}
            {blindActive && (
              <SummaryStat label="Variance" value="Hidden" tone="muted" />
            )}
          </div>
        </div>
      </section>

      {/* ── Lines ───────────────────────────────────────────────────── */}
      {/* overflow: clip, not the card's hidden — `hidden` makes the card a
          scroll container, and a sticky header then sticks to a box that never
          scrolls (owner 2026-10-06: the header must stay on screen). */}
      <section className={styles.card} style={{ overflow: 'clip' }}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>
            Count Sheet
            <span style={{
              marginLeft: 8, fontSize: 'var(--fs-12)',
              color: 'var(--fg-muted)', fontWeight: 400,
            }}>
              {filteredLines.length} of {lines.length} shown
            </span>
          </h2>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            {/* Model / flat toggle (phase 1) — model view is the default. */}
            <Button variant={view === 'model' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('model')}>
              <Rows3 size={14} strokeWidth={1.75} /> By model
            </Button>
            <Button variant={view === 'flat' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('flat')}>
              <List size={14} strokeWidth={1.75} /> Flat
            </Button>
            {isDraft && (
              <>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', background: 'var(--c-paper)',
                  border: '1px solid var(--line)', borderRadius: 'var(--radius-md)',
                }}>
                  <Search size={14} strokeWidth={1.75} style={{ color: 'var(--fg-muted)' }} />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Filter by code / name…"
                    style={{
                      border: 'none', outline: 'none', background: 'transparent',
                      fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)',
                      width: 200, color: 'var(--c-ink)',
                    }}
                  />
                </div>
                {/* Meaningless on a blind take — there is no visible system qty
                    to fill from (and the server strips the figure anyway). */}
                {!blindActive && (
                  <Button variant="ghost" size="sm" onClick={matchAllToSystem}>
                    <Wand2 size={14} strokeWidth={1.75} /> Fill all to system
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
        <div className={styles.cardBody}>
          <table className={`${styles.table} ${styles.tableOwnWidths} ${styles.stickyHead}`}>
            <thead>
              <tr>
                <th style={{ width: '18%' }}>SKU</th>
                <th>Name</th>
                <th>Variant</th>
                {/* Blind (phase 1): the two figures the counter must not see
                    simply do not exist in this view — the server already
                    stripped them from the payload. */}
                {!blindActive && <th style={{ width: 110, textAlign: 'right' }}>System Qty</th>}
                <th style={{ width: 130, textAlign: 'right' }}>Counted Qty</th>
                {!blindActive && <th style={{ width: 110, textAlign: 'right' }}>Variance</th>}
                {!blindActive && <th style={{ width: 110, textAlign: 'right' }}>Value (RM)</th>}
                <th style={{ width: 130 }}>Counted By</th>
                {isDraft && <th style={{ width: 110 }} />}
              </tr>
            </thead>
            <tbody>
              {(() => {
                /* SKU + Name + Variant + Counted + Counted By = 5 fixed. */
                const colCount = 5 + (blindActive ? 0 : 3) + (isDraft ? 1 : 0);
                if (filteredLines.length === 0) {
                  return (
                    <tr><td colSpan={colCount} className={styles.emptyRow}>
                      {lines.length === 0 ? 'No lines on this stock take.' : 'No lines match the search.'}
                    </td></tr>
                  );
                }

                const lineRow = (ln: LineDraft, inGroup: boolean) => {
                  const v = varianceOf(ln);
                  const isUntouched = parseCounted(ln.countedQtyInput) == null;
                  const varianceColor = v == null
                    ? 'var(--fg-muted)'
                    : v > 0
                      ? 'var(--c-secondary-a, #2F5D4F)'
                      : v < 0
                        ? 'var(--c-festive-b, #B8331F)'
                        : 'var(--fg-muted)';
                  return (
                    <tr key={ln.id}>
                      <td>
                        <span className={styles.codeCell} style={{
                          fontFamily: 'var(--font-mono)',
                          paddingLeft: inGroup ? 22 : undefined,
                        }}>
                          {ln.itemCode}
                        </span>
                        {ln.addedOnCount && (
                          <span className={styles.chip} title="Added during the count — not on the original sheet"
                            style={{ marginLeft: 6, fontSize: 'var(--fs-11)' }}>Added</span>
                        )}
                      </td>
                      <td style={{ fontSize: 'var(--fs-13)' }}>
                        {ln.productName || <span className={styles.muted}>—</span>}
                      </td>
                      {/* Variant bucket (migration 0183) — the (item_code,
                          variant_key) this line counts. A plain SKU shows '—'. */}
                      <td style={{ fontSize: 'var(--fs-13)' }}>
                        {ln.variantLabel
                          ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>{ln.variantLabel}</span>
                          : <span className={styles.muted}>—</span>}
                      </td>
                      {!blindActive && (
                        <td className={styles.tableRight}
                            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)' }}>
                          {ln.systemQty == null ? '—' : fmtQty(ln.systemQty)}
                        </td>
                      )}
                      <td className={styles.tableRight}>
                        {isDraft ? (
                          <input
                            type="text"
                            inputMode="numeric"
                            aria-label={`Counted qty for ${ln.itemCode}`}
                            value={ln.countedQtyInput}
                            /* Digits only: a text box has no spinner and no
                               mouse-wheel change, the two ways a count got
                               nudged by accident. */
                            onChange={(e) => setLine(ln.id, { countedQtyInput: e.target.value.replace(/[^0-9]/g, '') })}
                            placeholder="—"
                            className={styles.fieldInput}
                            style={{
                              textAlign: 'right',
                              fontFamily: 'var(--font-mono)',
                              color: isUntouched ? 'var(--fg-muted)' : 'var(--c-ink)',
                            }}
                          />
                        ) : (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)',
                            color: isUntouched ? 'var(--fg-muted)' : 'var(--c-ink)' }}>
                            {isUntouched ? '—' : fmtQty(Number(ln.countedQtyInput))}
                          </span>
                        )}
                      </td>
                      {!blindActive && (
                        <td className={styles.tableRight}
                            style={{
                              fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)',
                              color: varianceColor, fontWeight: v && v !== 0 ? 600 : 400,
                            }}>
                          {v == null
                            ? '—'
                            : `${v > 0 ? '+' : ''}${fmtQty(v)}`}
                        </td>
                      )}
                      {!blindActive && (() => {
                        const val = valueOf(ln);
                        return (
                          <td className={styles.tableRight}
                              title={v != null && v !== 0 && val == null ? 'No cost on record for this SKU' : undefined}
                              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)', color: varianceColor }}>
                            {val == null || val === 0 ? '—' : fmtSignedRM(val)}
                          </td>
                        );
                      })()}
                      {/* WHO counted this cell (mig 0270) — stamped server-side
                          on save; a just-typed, unsaved entry still shows the
                          previous author until Save Counts round-trips. */}
                      <td style={{ fontSize: 'var(--fs-12)' }}
                          title={ln.countedAt ? fmtDateTime(ln.countedAt) : undefined}>
                        {ln.countedBy
                          ? actorNameOf(ln.countedBy)
                          : <span className={styles.muted}>—</span>}
                      </td>
                      {isDraft && (
                        <td>
                          {!blindActive && ln.systemQty != null && (
                            <button
                              type="button"
                              onClick={() => matchSystem(ln.id)}
                              className={styles.chip}
                              title="Set counted = system (zero variance)"
                              style={{ fontSize: 'var(--fs-11)', cursor: 'pointer' }}
                            >
                              Match
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                };

                if (view === 'flat') return filteredLines.map((ln) => lineRow(ln, false));

                /* MODEL view (default): one header row per multi-line model,
                   collapsed until expanded; single-line models render plain. */
                return groups.flatMap((g) => {
                  if (g.lines.length === 1) return [lineRow(g.lines[0], false)];
                  const isOpen = expanded.has(g.itemCode);
                  const groupVariance = blindActive ? null : g.lines.reduce<number | null>((acc, l) => {
                    const v = varianceOf(l);
                    if (v == null) return acc;
                    return (acc ?? 0) + v;
                  }, null);
                  const header = (
                    <tr key={`grp-${g.itemCode}`} style={{ background: 'var(--c-cream)' }}>
                      <td>
                        <button
                          type="button"
                          onClick={() => toggleGroup(g.itemCode)}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                            border: 'none', background: 'transparent', cursor: 'pointer',
                            fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)',
                            fontWeight: 600, color: 'var(--c-ink)', padding: 0,
                          }}
                          aria-expanded={isOpen}
                        >
                          {isOpen
                            ? <ChevronDown size={14} strokeWidth={1.75} />
                            : <ChevronRight size={14} strokeWidth={1.75} />}
                          {g.itemCode}
                        </button>
                      </td>
                      <td style={{ fontSize: 'var(--fs-13)', fontWeight: 600 }}>
                        {g.productName || <span className={styles.muted}>—</span>}
                        <span style={{ marginLeft: 8, color: 'var(--fg-muted)', fontWeight: 400 }}>
                          · {g.lines.length} lines
                        </span>
                      </td>
                      <td><span className={styles.muted}>—</span></td>
                      {!blindActive && (
                        <td className={styles.tableRight}
                            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)', fontWeight: 600 }}>
                          {g.systemTotal == null ? '—' : fmtQty(g.systemTotal)}
                        </td>
                      )}
                      <td className={styles.tableRight}
                          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)' }}>
                        {g.countedLines === 0
                          ? <span className={styles.muted}>0/{g.lines.length}</span>
                          : <>{fmtQty(g.countedTotal)} <span style={{ color: 'var(--fg-muted)' }}>({g.countedLines}/{g.lines.length})</span></>}
                      </td>
                      {!blindActive && (
                        <td className={styles.tableRight}
                            style={{
                              fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)', fontWeight: 600,
                              color: groupVariance == null || groupVariance === 0
                                ? 'var(--fg-muted)'
                                : groupVariance > 0 ? 'var(--c-secondary-a, #2F5D4F)' : 'var(--c-festive-b, #B8331F)',
                            }}>
                          {groupVariance == null ? '—' : `${groupVariance > 0 ? '+' : ''}${fmtQty(groupVariance)}`}
                        </td>
                      )}
                      {!blindActive && (() => {
                        const gv = g.lines.reduce<number | null>((acc, l) => {
                          const val = valueOf(l);
                          return val == null ? acc : (acc ?? 0) + val;
                        }, null);
                        return (
                          <td className={styles.tableRight} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)', fontWeight: 600 }}>
                            {gv == null || gv === 0 ? '—' : fmtSignedRM(gv)}
                          </td>
                        );
                      })()}
                      <td><span className={styles.muted}>—</span></td>
                      {isDraft && (
                        <td>
                          <button
                            type="button"
                            onClick={() => zeroGroup(g.itemCode)}
                            className={styles.chip}
                            title="Fill every line in this model with counted qty 0"
                            style={{ fontSize: 'var(--fs-11)', cursor: 'pointer' }}
                          >
                            All zero
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                  return isOpen ? [header, ...g.lines.map((l) => lineRow(l, true))] : [header];
                });
              })()}
            </tbody>
          </table>

          {isDraft && (
            <AddFoundLine
              takeId={t.id}
              dirty={dirty}
              onAdded={() => { void detail.refetch(); }}
            />
          )}

          {isDraft && totals.uncounted > 0 && (
            <div style={{
              marginTop: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              background: 'rgba(34, 31, 32, 0.04)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--fs-13)',
              color: 'var(--fg-muted)',
              display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)',
            }}>
              <AlertTriangle size={16} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                <strong>{totals.uncounted} line{totals.uncounted === 1 ? '' : 's'} untouched.</strong>
                {' '}On Post these are skipped (no adjustment written).{' '}
                {blindActive ? 'Type a count to include them.' : 'Click "Match" or type a count to include them.'}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* History drawer — portals to <body>, so its position here is only
          about lifecycle, not layout. */}
      {historyOpen && (
        <EntityHistoryPanel
          entityType="STOCK_TAKE"
          entityId={String(t.id)}
          recordLabel={t.take_no}
          entityName="Stock take"
          labels={STOCK_TAKE_AUDIT_LABELS}
          statusDocType="stockTake"
          onClose={closeHistory}
        />
      )}

      <PrintPreviewModal
        open={print.open}
        onClose={print.close}
        docTitle="Stock Take"
        docNo={t.take_no}
        rows={[
          { label: 'Warehouse', value: warehouseLabel(t.warehouse) ?? t.warehouse_id },
          { label: 'Scope', value: scopeLabel(t.scope_type, t.scope_value) },
          { label: 'Date', value: fmtDateOrDash(t.take_date) },
          { label: 'Lines', value: `${totals.counted} counted of ${totals.totalLines}` },
          /* The card says what the sheet will say. On a blind take the
             variance is exactly the number the counter must not see, so it
             names the blind instead of printing a figure. */
          blindActive
            ? { label: 'Variance', value: 'Hidden — blind count' }
            : { label: 'Net variance', value: `${totals.varianceNet > 0 ? '+' : ''}${fmtQty(totals.varianceNet)}` },
        ]}
        {...print.handlers}
      />
    </div>
  );
};

// ── Small inline component for the variance summary cards ──────────────
type SummaryTone = 'positive' | 'negative' | 'muted';
const SummaryStat = (props: { label: string; value: string; tone?: SummaryTone }) => {
  const color =
    props.tone === 'positive' ? 'var(--c-secondary-a, #2F5D4F)' :
    props.tone === 'negative' ? 'var(--c-festive-b, #B8331F)' :
    props.tone === 'muted'    ? 'var(--fg-muted)' :
    'var(--c-ink)';
  return (
    <div style={{
      padding: 'var(--space-3)',
      background: 'var(--c-cream)',
      border: '1px solid var(--line)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {props.label}
      </div>
      <div style={{
        marginTop: 4, fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-18, 18px)', fontWeight: 600, color,
      }}>
        {props.value}
      </div>
    </div>
  );
};

/* "+RM 1,234.00" / "−RM 56.00" / "RM 0.00" from sen. */
const fmtSignedRM = (sen: number): string =>
  sen > 0 ? `+${fmtSen(sen)}` : sen < 0 ? `−${fmtSen(-sen)}` : fmtSen(0);

/* Add line (owner 2026-10-06): stock found on the shelf that the sheet does not
   list. Pick the SKU (and, for a SKU the business holds in variants, which
   one), type the count, Add — it lands counted. Unsaved counts must be saved
   first, because adding re-reads the take and would drop them. */
function AddFoundLine({ takeId, dirty, onAdded }: { takeId: string; dirty: boolean; onAdded: () => void }) {
  const notify = useNotify();
  const products = useMfgProducts();
  const add = useAddStockTakeLine();
  const [code, setCode] = useState('');
  const [variantKey, setVariantKey] = useState('');
  const [qty, setQty] = useState('');
  const known = (products.data ?? []).some((p) => p.code === code.trim());
  const options = useStockTakeBucketOptions(takeId, known ? code : '');
  const opts = options.data ?? [];

  const submit = () => {
    if (dirty) { void notify({ title: 'Save your counts first', body: 'Adding a line reloads the sheet.', tone: 'error' }); return; }
    if (!known) { void notify({ title: 'Pick a SKU from the list.', tone: 'error' }); return; }
    if (qty === '') { void notify({ title: 'Type the counted quantity.', tone: 'error' }); return; }
    add.mutate(
      { id: takeId, itemCode: code.trim(), variantKey, countedQty: Number(qty) },
      {
        onSuccess: () => { setCode(''); setVariantKey(''); setQty(''); onAdded(); },
        onError: (err) => { void notify({ title: 'Add line failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }); },
      },
    );
  };

  return (
    <div style={{
      marginTop: 'var(--space-3)', padding: 'var(--space-3)',
      border: '1px dashed var(--line)', borderRadius: 'var(--radius-md)',
      display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'flex-end',
    }}>
      <label className={styles.field} style={{ flex: '1 1 220px' }}>
        <span className={styles.fieldLabel}>Add line — SKU found, not on the sheet</span>
        <input className={styles.fieldInput} list="stk-add-skus" value={code} placeholder="Type or pick a SKU code…"
          onChange={(e) => { setCode(e.target.value); setVariantKey(''); }} style={{ fontFamily: 'var(--font-mono)' }} />
        <datalist id="stk-add-skus">
          {(products.data ?? []).map((p) => <option key={p.id} value={p.code}>{p.name}</option>)}
        </datalist>
      </label>
      <label className={styles.field} style={{ flex: '2 1 280px' }}>
        <span className={styles.fieldLabel}>Variant</span>
        <select className={styles.fieldSelect} value={variantKey} onChange={(e) => setVariantKey(e.target.value)}
          disabled={!known || options.isLoading}>
          <option value="">{opts.length && !opts.some((o) => o.variantKey === '') ? '— Pick variant —' : '(plain / no variant)'}</option>
          {opts.filter((o) => o.variantKey !== '').map((o) => (
            <option key={o.variantKey} value={o.variantKey}>{o.variantLabel ?? o.variantKey} — {o.qtyHere} here</option>
          ))}
        </select>
      </label>
      <label className={styles.field} style={{ flex: '0 0 110px' }}>
        <span className={styles.fieldLabel}>Counted</span>
        <input className={styles.fieldInput} inputMode="numeric" value={qty} aria-label="Counted qty for the new line"
          onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ''))} style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }} />
      </label>
      <Button variant="secondary" size="md" onClick={submit} disabled={add.isPending}>
        <Plus size={14} strokeWidth={1.75} /> {add.isPending ? 'Adding…' : 'Add line'}
      </Button>
    </div>
  );
}
