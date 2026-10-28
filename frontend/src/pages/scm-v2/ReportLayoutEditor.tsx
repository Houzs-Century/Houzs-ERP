// ----------------------------------------------------------------------------
// ReportLayoutEditor — where the owner arranges a Finance report (2026-09-14,
// docs/bugs/0911: 我要能自己调动排版，然后能自己加大 categories … 做公用然后选要不要，
// 类似 chart of account). One tree per report, shared by every company: a
// category is renamed in place, added at the top of a block or under another,
// deleted (what it held moves up a level — an account is never lost), moved
// by drag or by the ↑ ↓ buttons, and ticked per company like the chart of
// accounts. Accounts are the leaves; the block's accounts the tree does not
// place sit under Unassigned, where the report prints them, until dragged in.
// Nothing reaches the server until Save; Reset puts the chart's own tree back.
// The block itself is never editable — the chart's section decides it.
// The Cash Flow (owner 2026-09-18) adds a Direction column: a top category is
// In or Out, a line is In / Out / Net so one account may sit on both sides, a
// category names its own subtotal line, a subtotal row sums everything above
// it, and the spares are offered per side.
// ----------------------------------------------------------------------------

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { fmtDateOrDash } from '../../vendor/shared/format';
import {
  REPORT_TITLES, accountKey, addCategory, addSubtotal, categoryIds, itemKey, moveWithinSiblings, newCategoryId, newSubtotalId, placeItem, removeCategory, removeSubtotal, renameCategory,
  setAccountFlow, setCategoryFlow, setCategoryTick, setTotalLabel, unplaceAccount, unplacedAccounts, useReportLayout, useResetReportLayout, useSaveReportLayout,
  type DropTarget, type Flow, type Layout, type LayoutAccountRow, type LayoutBlockDef, type LayoutCategory, type LayoutCompany, type LayoutItem, type ReportKey, type Side,
} from '../../vendor/scm/lib/report-layout';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const soft: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };
const iconBtn: React.CSSProperties = {
  background: 'transparent', border: 0, padding: '2px 4px', cursor: 'pointer', color: 'inherit', display: 'inline-flex', alignItems: 'center',
};
const cell: React.CSSProperties = { padding: '3px 8px', verticalAlign: 'middle' };
/* Account No. and Name are their own columns, the drag handle beside the number
   (owner 2026-09-18: 拖动应该在 account number 旁边; number 和 name 各自一个 column). */
const codeCell: React.CSSProperties = { ...cell, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' };
const grip: React.CSSProperties = { ...soft, marginRight: 6, cursor: 'grab', display: 'inline-flex', verticalAlign: 'middle' };
const select: React.CSSProperties = { fontSize: 'var(--fs-13)', padding: '1px 4px' };
const sideWord = (side: Side): string => (side === 'in' ? 'In' : 'Out');

type Drag = { block: string; item: LayoutItem };

type Props = { report: ReportKey; onClose: () => void };

export const ReportLayoutEditor = ({ report, onClose }: Props) => {
  const q = useReportLayout(report);
  const save = useSaveReportLayout(report);
  const reset = useResetReportLayout(report);
  const askConfirm = useConfirm();

  const [draft, setDraft] = useState<Layout | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);

  const data = q.data;
  /* The server's tree is the draft until the first edit; after a save or a
     reset the fresh read replaces it again. */
  useEffect(() => { if (data && !dirty) setDraft(data.layout); }, [data, dirty]);

  const names = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.code, a])), [data]);
  const companies: LayoutCompany[] = data?.companies ?? [];
  /* The Cash Flow carries directions — one more column, spares per side. */
  const cashFlow = report === 'rp';
  const span = 3 + companies.length + (cashFlow ? 1 : 0);

  const apply = (next: Layout) => {
    if (!draft || next === draft) return;
    setDraft(next);
    setDirty(true);
    setError(null);
  };

  const startRename = (id: string, label: string) => { setEditingId(id); setEditLabel(label); };
  const commitRename = () => {
    if (!draft || !editingId) return;
    const label = editLabel.trim();
    if (label) apply(renameCategory(draft, editingId, label));
    setEditingId(null);
  };

  const drop = (target: DropTarget, block: string) => {
    if (!draft || !drag || drag.block !== block) return;
    apply(placeItem(draft, block, drag.item, target));
    setDrag(null);
  };
  const dragProps = (block: string, target: DropTarget) => ({
    onDragOver: (e: React.DragEvent) => { if (drag && drag.block === block) e.preventDefault(); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); drop(target, block); },
  });

  const onSave = async () => {
    if (!draft) return;
    setError(null);
    try {
      await save.mutateAsync(draft);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The layout was not saved.');
    }
  };
  const onReset = async () => {
    const ok = await askConfirm({
      title: 'Reset the layout to the chart?',
      body: 'The saved layout goes and the report draws the chart\'s own tree again — for every company. Categories you added are lost; the accounts are not.',
      confirmLabel: 'Reset',
    });
    if (!ok) return;
    setError(null);
    try {
      await reset.mutateAsync();
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The layout was not reset.');
    }
  };

  const toggleFold = (id: string) => setFolded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  /* A whole chart on one tree (Receipts & Payments) is long — fold it to
     its top categories in one press, open it in one press. */
  const foldAll = () => { if (draft) setFolded(new Set(categoryIds(draft))); };
  const unfoldAll = () => setFolded(new Set());

  const nameOf = (code: string): string => names.get(code)?.name ?? '(not on the chart)';

  const renderItems = (block: string, items: LayoutItem[], depth: number): React.ReactNode => items.map((it) => {
    const key = itemKey(it);
    const indent = 8 + 16 * (depth - 1);
    const arrows = (
      <>
        <button type="button" style={iconBtn} aria-label={`Move ${it.kind === 'account' ? it.code : it.label} up`}
          onClick={() => draft && apply(moveWithinSiblings(draft, block, key, -1))}><ArrowUp {...ICON} /></button>
        <button type="button" style={iconBtn} aria-label={`Move ${it.kind === 'account' ? it.code : it.label} down`}
          onClick={() => draft && apply(moveWithinSiblings(draft, block, key, 1))}><ArrowDown {...ICON} /></button>
      </>
    );
    if (it.kind === 'account') {
      return (
        <tr key={key} data-kind="account" draggable onDragStart={() => setDrag({ block, item: it })} {...dragProps(block, { kind: 'before', key })}>
          <td style={{ ...codeCell, paddingLeft: indent }}>
            <span style={grip} aria-hidden><GripVertical {...ICON} /></span>
            {it.code}
          </td>
          <td style={cell}>{nameOf(it.code)}</td>
          {cashFlow && (
            <td style={cell}>
              <select aria-label={`Direction of ${it.code}`} style={select} value={it.flow ?? 'in'}
                onChange={(e) => draft && apply(setAccountFlow(draft, block, key, e.target.value as Flow))}>
                <option value="in">In</option>
                <option value="out">Out</option>
                <option value="net">Net</option>
              </select>
            </td>
          )}
          {companies.map((co) => <td key={co.id} style={cell} />)}
          <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
            {arrows}
            <button type="button" style={iconBtn} aria-label={`Unplace ${it.code}`} title="Back to Unassigned"
              onClick={() => draft && apply(unplaceAccount(draft, block, it.code, it.flow))}><X {...ICON} /></button>
          </td>
        </tr>
      );
    }
    if (it.kind === 'subtotal') {
      return (
        <tr key={key} data-kind="subtotal" draggable onDragStart={() => setDrag({ block, item: it })} {...dragProps(block, { kind: 'before', key })}>
          <td style={{ ...codeCell, paddingLeft: indent }}><span style={grip} aria-hidden><GripVertical {...ICON} /></span></td>
          <td style={{ ...cell, fontWeight: 600 }}>
            {editingId === it.id ? (
              <input
                autoFocus
                aria-label={`Rename ${it.label}`}
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
                style={{ fontSize: 'var(--fs-13)', padding: '1px 4px', minWidth: 180 }}
              />
            ) : (
              <>
                <span>{it.label}</span>
                <button type="button" style={iconBtn} aria-label={`Rename ${it.label}`} onClick={() => startRename(it.id, it.label)}><Pencil {...ICON} /></button>
              </>
            )}
          </td>
          {cashFlow && <td style={{ ...cell, ...soft }}>subtotal of everything above</td>}
          {companies.map((co) => <td key={co.id} style={cell} />)}
          <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
            {arrows}
            <button type="button" style={iconBtn} aria-label={`Delete ${it.label}`} title="Delete the subtotal line"
              onClick={() => draft && apply(removeSubtotal(draft, it.id))}><Trash2 {...ICON} /></button>
          </td>
        </tr>
      );
    }
    const open = !folded.has(it.id);
    return (
      <Fragment key={key}>
        <tr data-kind="category" draggable onDragStart={() => setDrag({ block, item: it })} {...dragProps(block, { kind: 'into', categoryId: it.id })}>
          <td style={{ ...codeCell, paddingLeft: indent, fontWeight: 600 }}>
            <span style={grip} aria-hidden><GripVertical {...ICON} /></span>
            <button type="button" style={iconBtn} aria-label={open ? `Fold ${it.label}` : `Unfold ${it.label}`} onClick={() => toggleFold(it.id)}>
              {open ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
            </button>
            {it.code ?? ''}
          </td>
          <td style={{ ...cell, fontWeight: 600 }}>
            {editingId === it.id ? (
              <input
                autoFocus
                aria-label={`Rename ${it.label}`}
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
                style={{ fontSize: 'var(--fs-13)', padding: '1px 4px', minWidth: 180 }}
              />
            ) : (
              <>
                <span>{it.label}</span>
                <button type="button" style={iconBtn} aria-label={`Rename ${it.label}`} onClick={() => startRename(it.id, it.label)}><Pencil {...ICON} /></button>
              </>
            )}
            {cashFlow && depth === 1 && (
              <div style={{ marginTop: 2, fontWeight: 400 }}>
                <span style={soft}>Subtotal line </span>
                <input
                  aria-label={`Subtotal name of ${it.label}`}
                  placeholder={`Total ${it.label}`}
                  value={it.totalLabel ?? ''}
                  onChange={(e) => draft && apply(setTotalLabel(draft, it.id, e.target.value))}
                  style={{ fontSize: 'var(--fs-12)', padding: '1px 4px', minWidth: 160 }}
                />
              </div>
            )}
          </td>
          {cashFlow && (
            <td style={cell}>
              {depth === 1 && (
                <select aria-label={`Side of ${it.label}`} style={select} value={it.flow ?? 'in'}
                  onChange={(e) => draft && apply(setCategoryFlow(draft, it.id, e.target.value as Side))}>
                  <option value="in">In</option>
                  <option value="out">Out</option>
                </select>
              )}
            </td>
          )}
          {companies.map((co) => (
            <td key={co.id} style={{ ...cell, textAlign: 'center' }}>
              <input
                type="checkbox"
                aria-label={`${it.label} for ${co.code}`}
                checked={!(it.hiddenFor ?? []).includes(co.id)}
                onChange={(e) => draft && apply(setCategoryTick(draft, it.id, co.id, e.target.checked))}
              />
            </td>
          ))}
          <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
            {arrows}
            <button type="button" style={iconBtn} aria-label={`Add a category under ${it.label}`} title="Sub-category"
              onClick={() => draft && apply(addCategory(draft, block, it.id, 'New category', newCategoryId()))}><Plus {...ICON} /></button>
            <button type="button" style={iconBtn} aria-label={`Delete ${it.label}`} title="Delete — what it holds moves up a level"
              onClick={() => draft && apply(removeCategory(draft, it.id))}><Trash2 {...ICON} /></button>
          </td>
        </tr>
        {open && renderItems(block, it.children, depth + 1)}
      </Fragment>
    );
  });

  const renderBlock = (block: LayoutBlockDef) => {
    if (!draft || !data) return null;
    const items = draft.blocks[block.key] ?? [];
    /* The Cash Flow offers its spares per side: the accounts whose money in
       (or out) no line reads yet; Place puts one inside the first category
       of that side. */
    const spares: Array<{ side: Side | null; rows: LayoutAccountRow[] }> = cashFlow
      ? [{ side: 'in', rows: unplacedAccounts(draft, block, data.accounts, 'in') }, { side: 'out', rows: unplacedAccounts(draft, block, data.accounts, 'out') }]
      : [{ side: null, rows: unplacedAccounts(draft, block, data.accounts) }];
    const sideCategory = (side: Side): string | null =>
      items.find((it): it is LayoutCategory => it.kind === 'category' && (it.flow ?? 'in') === side)?.id ?? null;
    const placeSpare = (code: string, side: Side | null) => {
      if (side === null) { apply(placeItem(draft, block.key, { kind: 'account', code }, { kind: 'end' })); return; }
      const into = sideCategory(side);
      if (into) apply(placeItem(draft, block.key, { kind: 'account', code, flow: side }, { kind: 'into', categoryId: into }));
    };
    return (
      <Fragment key={block.key}>
        <tr data-block={block.key} {...dragProps(block.key, { kind: 'end' })}>
          <td colSpan={cashFlow ? 3 : 2} style={{ ...cell, paddingTop: 10, fontWeight: 700 }}>{block.title}</td>
          {companies.map((co) => <td key={co.id} style={cell} />)}
          <td style={{ ...cell, textAlign: 'right', paddingTop: 10, whiteSpace: 'nowrap' }}>
            <Button variant="ghost" size="sm" aria-label={`Add a category to ${block.title}`}
              onClick={() => apply(addCategory(draft, block.key, null, 'New category', newCategoryId()))}>
              <Plus {...ICON} /> Category
            </Button>
            {cashFlow && (
              <Button variant="ghost" size="sm" aria-label={`Add a subtotal to ${block.title}`} title="A running subtotal of everything above it, In less Out"
                onClick={() => apply(addSubtotal(draft, block.key, 'New subtotal', newSubtotalId()))}>
                <Plus {...ICON} /> Subtotal
              </Button>
            )}
          </td>
        </tr>
        {renderItems(block.key, items, 1)}
        {items.length === 0 && spares.every((sp) => sp.rows.length === 0) && (
          <tr><td colSpan={span} style={{ ...cell, paddingLeft: 24, ...soft }}>No accounts in this block.</td></tr>
        )}
        {spares.map(({ side, rows }) => rows.length > 0 && (
          <Fragment key={side ?? 'all'}>
            <tr data-unassigned={side ? `${block.key}:${side}` : block.key}>
              <td colSpan={span} style={{ ...cell, paddingLeft: 24, fontStyle: 'italic', ...soft }}>
                {side
                  ? `Unassigned ${side === 'in' ? 'receipts' : 'payments'} — printed as their own group at the foot until placed on the ${sideWord(side)} side`
                  : `Unassigned — printed at the foot of ${block.title} until placed`}
              </td>
            </tr>
            {rows.map((a) => (
              <tr key={a.code} data-kind="spare" draggable onDragStart={() => setDrag({ block: block.key, item: side ? { kind: 'account', code: a.code, flow: side } : { kind: 'account', code: a.code } })}>
                <td style={{ ...codeCell, paddingLeft: 40 }}>
                  <span style={grip} aria-hidden><GripVertical {...ICON} /></span>
                  {a.code}
                </td>
                <td style={cell}>{a.name}</td>
                {cashFlow && <td style={{ ...cell, ...soft }}>{side ? sideWord(side) : ''}</td>}
                {companies.map((co) => <td key={co.id} style={cell} />)}
                <td style={{ ...cell, textAlign: 'right' }}>
                  <Button variant="ghost" size="sm" aria-label={side ? `Place ${a.code} as ${sideWord(side)}` : `Place ${a.code}`}
                    disabled={side !== null && sideCategory(side) === null}
                    title={side !== null && sideCategory(side) === null ? `Add an ${sideWord(side)} category first` : undefined}
                    onClick={() => placeSpare(a.code, side)}>
                    Place
                  </Button>
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </Fragment>
    );
  };

  return (
    <section role="dialog" aria-label={`Layout · ${REPORT_TITLES[report]}`} className={styles.card}>
      <div className={styles.cardHeader} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <h2 className={styles.cardTitle} style={{ marginRight: 'auto' }}>Layout · {REPORT_TITLES[report]}</h2>
        {data && (
          <span style={soft}>
            {data.stored
              ? `Saved by ${data.updatedBy ?? '—'} on ${fmtDateOrDash(data.updatedAt)} · shared by every company`
              : 'The chart\'s own tree — nothing saved yet · shared by every company'}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={foldAll} disabled={!draft}>Fold all</Button>
        <Button variant="ghost" size="sm" onClick={unfoldAll} disabled={!draft}>Unfold all</Button>
        <Button variant="ghost" size="sm" onClick={() => void onReset()} disabled={reset.isPending || save.isPending}>Reset to chart</Button>
        <Button variant="primary" size="sm" onClick={() => void onSave()} disabled={!dirty || save.isPending || reset.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close the layout editor">Close</Button>
      </div>
      <div className={styles.cardBody} style={{ fontSize: 'var(--fs-13)', overflowX: 'auto' }}>
        {q.isLoading && <div style={soft}>Reading the layout…</div>}
        {q.isError && <div style={{ color: 'var(--c-danger, #a33)' }}>The layout did not load — close and open it again.</div>}
        {error && <div role="alert" style={{ color: 'var(--c-danger, #a33)', marginBottom: 8 }}>{error}</div>}
        {data && draft && (
          <>
            <div style={{ ...soft, marginBottom: 8 }}>
              Drag a row onto a category to put it inside, onto an account to put it above, or use ↑ ↓. A tick means that
              company shows the category; unticked, its accounts print under Unassigned there. The block an account belongs
              to follows its section on the chart of accounts.
              {cashFlow && (
                <>
                  {' '}On the Cash Flow every top category is In or Out — that decides the sign of its lines and which total they
                  feed; a line's own direction (In, Out, or Net = in − out) may differ, so one account can sit on both sides; a
                  category's subtotal line can carry its own name; a subtotal row sums everything above it, In less Out.
                </>
              )}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...cell, textAlign: 'left', ...soft }}>Account No.</th>
                  <th style={{ ...cell, textAlign: 'left', ...soft }}>Name</th>
                  {cashFlow && <th style={{ ...cell, textAlign: 'left', ...soft }}>Direction</th>}
                  {companies.map((co) => <th key={co.id} style={{ ...cell, textAlign: 'center', ...soft }}>{co.code}</th>)}
                  <th style={{ ...cell, textAlign: 'right', ...soft }}>Order</th>
                </tr>
              </thead>
              <tbody>{data.blocks.map(renderBlock)}</tbody>
            </table>
          </>
        )}
      </div>
    </section>
  );
};
