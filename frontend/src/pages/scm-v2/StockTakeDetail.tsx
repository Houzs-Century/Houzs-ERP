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
// Phase 1 (owner-approved 2026-08-08, mig 0270):
//   • ASSIGNEE on the header; Post is enabled only for the assignee / a
//     supervisor (the backend enforces it — the button state just tells the
//     truth early, driven by the server's `viewer` facts, never re-derived).
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
import { History, Save, X, Trash2, Send, Ban, AlertTriangle, Search, Wand2, Undo2, ChevronRight, ChevronDown, EyeOff, Rows3, List } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { fmtDateOrDash, fmtDateTime, fmtQty } from '@2990s/shared';
import {
  useStockTakeDetail,
  useUpdateStockTakeLines,
  usePostStockTake,
  useCancelStockTake,
  useReverseStockTake,
  useDeleteStockTake,
  type StockTakeStatus,
  type StockTakeLine,
} from '../../vendor/scm/lib/stock-queries';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { EntityHistoryPanel } from './EntityHistoryPanel';
import { STOCK_TAKE_AUDIT_LABELS } from './entity-audit-labels';
import { groupByModel } from './stock-take-grouping';
import { useStaffLookup } from '../../hooks/useStaffLookup';

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
  productCode: string;
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
};

const toDraft = (l: StockTakeLine): LineDraft => ({
  id:               l.id,
  productCode:      l.product_code,
  productName:      l.product_name,
  variantLabel:     l.variant_label,
  systemQty:        l.system_qty,
  countedQtyInput:  l.counted_qty == null ? '' : String(l.counted_qty),
  notes:            l.notes ?? '',
  origCountedQty:   l.counted_qty,
  origNotes:        l.notes ?? '',
  countedBy:        l.counted_by ?? null,
  countedAt:        l.counted_at ?? null,
});

const parseCounted = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Math.max(0, Math.floor(Number(s)));
  if (!Number.isFinite(n)) return null;
  return n;
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
  const canPost =
    !detail.data?.take.assignee_staff_id || viewer.isAssignee || viewer.canSupervise;

  /* id → name for assignee + per-cell counted-by (same idiom as the Stock
     Adjustments "Performed By" column — never render a uuid). */
  const { actorNameOf } = useStaffLookup();

  const filteredLines = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((l) =>
      l.productCode.toLowerCase().includes(q) ||
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
    }
    return {
      counted, uncounted,
      variancePos, varianceNeg,
      varianceNet: variancePos + varianceNeg,
      nonZeroVarianceLines,
      totalLines: lines.length,
    };
  }, [lines]);

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
  const zeroGroup = (productCode: string) => {
    setLines((cur) => cur.map((l) =>
      l.productCode === productCode ? { ...l, countedQtyInput: '0' } : l,
    ));
    setDirty(true);
  };

  const toggleGroup = (productCode: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(productCode)) next.delete(productCode);
      else next.add(productCode);
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
        `Net variance: ${totals.varianceNet > 0 ? '+' : ''}${totals.varianceNet}`;
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
                  {/* Post is the assignee's (or a supervisor's) move — the
                      backend refuses anyone else; disabling here just says so
                      before the round-trip. */}
                  <span title={canPost ? undefined : 'Only the assignee or a stock-take supervisor can post this count.'}>
                    <Button variant="primary" size="md" onClick={onPost} disabled={post.isPending || dirty || !canPost}>
                      <Send {...ICON} /> {post.isPending ? 'Posting…' : 'Post'}
                    </Button>
                  </span>
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
              <div style={{ padding: '8px 0', fontSize: 'var(--fs-13)', color: t.notes ? 'var(--c-ink)' : 'var(--fg-muted)' }}>
                {t.notes || '(none)'}
              </div>
            </div>
            {/* Phase 1 — accountability facts on the header. */}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Assignee</span>
              <div style={{ padding: '8px 0', fontSize: 'var(--fs-13)', color: t.assignee_staff_id ? 'var(--c-ink)' : 'var(--fg-muted)' }}>
                {t.assignee_staff_id ? actorNameOf(t.assignee_staff_id) : '(none — legacy take)'}
              </div>
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
              </>
            )}
            {blindActive && (
              <SummaryStat label="Variance" value="Hidden" tone="muted" />
            )}
          </div>
        </div>
      </section>

      {/* ── Lines ───────────────────────────────────────────────────── */}
      <section className={styles.card}>
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
          <table className={styles.table}>
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
                <th style={{ width: 130 }}>Counted By</th>
                {isDraft && <th style={{ width: 110 }} />}
              </tr>
            </thead>
            <tbody>
              {(() => {
                /* SKU + Name + Variant + Counted + Counted By = 5 fixed. */
                const colCount = 5 + (blindActive ? 0 : 2) + (isDraft ? 1 : 0);
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
                          {ln.productCode}
                        </span>
                      </td>
                      <td style={{ fontSize: 'var(--fs-13)' }}>
                        {ln.productName || <span className={styles.muted}>—</span>}
                      </td>
                      {/* Variant bucket (migration 0183) — the (product_code,
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
                            type="number"
                            min={0}
                            step={1}
                            value={ln.countedQtyInput}
                            onChange={(e) => setLine(ln.id, { countedQtyInput: e.target.value })}
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
                  const isOpen = expanded.has(g.productCode);
                  const groupVariance = blindActive ? null : g.lines.reduce<number | null>((acc, l) => {
                    const v = varianceOf(l);
                    if (v == null) return acc;
                    return (acc ?? 0) + v;
                  }, null);
                  const header = (
                    <tr key={`grp-${g.productCode}`} style={{ background: 'var(--c-cream)' }}>
                      <td>
                        <button
                          type="button"
                          onClick={() => toggleGroup(g.productCode)}
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
                          {g.productCode}
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
                      <td><span className={styles.muted}>—</span></td>
                      {isDraft && (
                        <td>
                          <button
                            type="button"
                            onClick={() => zeroGroup(g.productCode)}
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
