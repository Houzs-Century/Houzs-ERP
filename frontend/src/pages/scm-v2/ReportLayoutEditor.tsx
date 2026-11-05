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
//
// The owner's redesign (batch 6 §5.12, Finance-1a-Reports template 174–195):
// the editor stands IN PLACE of the report while it is open (InPlaceOfReport —
// the report and its header buttons step aside), its head carries Fold all ·
// Unfold all · Reset to chart · Save · Close with an "Unsaved changes" tag, a
// category is renamed in place with its subtotal line beside it, and Close
// asks before it drops unsaved changes.
// ----------------------------------------------------------------------------

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, Hand, Layers, PenLine, Plus, X } from 'lucide-react';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { fmtDateOrDash } from '../../vendor/shared/format';
import {
  REPORT_TITLES, addCategory, addSubtotal, categoryIds, itemKey, moveWithinSiblings, newCategoryId, newSubtotalId, placeItem, removeCategory, removeSubtotal, renameCategory,
  setAccountFlow, setCategoryFlow, setCategoryTick, setTotalLabel, unplaceAccount, unplacedAccounts, useReportLayout, useResetReportLayout, useSaveReportLayout,
  type DropTarget, type Flow, type Layout, type LayoutAccountRow, type LayoutBlockDef, type LayoutCategory, type LayoutCompany, type LayoutItem, type ReportKey, type Side,
} from '../../vendor/scm/lib/report-layout';
import { InPlaceOfReport } from './reports/reportParts';
import tokens from './finance/finance-ui.module.css';
import s from './ReportLayoutEditor.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const sideWord = (side: Side): string => (side === 'in' ? 'In' : 'Out');
/* How close to the scroll area's top or bottom a drag starts it scrolling, and how far a step goes. */
const EDGE_PX = 56;
const STEP_PX = 18;

type Drag = { block: string; item: LayoutItem; key: string };
/** A rename in progress: the name, and the subtotal line's name where the category has one (Cash flow's sides). */
type Rename = { id: string; label: string; total: string | null };

type Props = { report: ReportKey; onClose: () => void };

export const ReportLayoutEditor = ({ report, onClose }: Props) => {
  const q = useReportLayout(report);
  const save = useSaveReportLayout(report);
  const reset = useResetReportLayout(report);
  const askConfirm = useConfirm();

  const [draft, setDraft] = useState<Layout | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rename, setRename] = useState<Rename | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /* Owner 2026-11-05: a long tree cannot be dragged past the screen. A row is picked
     up (parked), the page scrolled freely, and the row put down with Place here. */
  const [parked, setParked] = useState<Drag | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /* Close with unsaved changes asks first (the design's banner under the head). */
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!parked) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setParked(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [parked]);

  /* While a row is dragged, near the scroll area's top or bottom edge (or the window's)
     the tree scrolls, so a drag reaches a row off the screen. */
  useEffect(() => {
    if (!drag) return;
    const onOver = (e: DragEvent) => {
      const el = scrollRef.current;
      const r = el?.getBoundingClientRect();
      if (el && r && el.scrollHeight > el.clientHeight) {
        if (e.clientY < r.top + EDGE_PX) el.scrollTop -= STEP_PX;
        else if (e.clientY > r.bottom - EDGE_PX) el.scrollTop += STEP_PX;
      }
      if (e.clientY < EDGE_PX) window.scrollBy(0, -STEP_PX);
      else if (e.clientY > window.innerHeight - EDGE_PX) window.scrollBy(0, STEP_PX);
    };
    document.addEventListener('dragover', onOver);
    return () => document.removeEventListener('dragover', onOver);
  }, [drag]);

  const data = q.data;
  /* The server's tree is the draft until the first edit; after a save or a
     reset the fresh read replaces it again. */
  useEffect(() => { if (data && !dirty) setDraft(data.layout); }, [data, dirty]);

  const names = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.code, a])), [data]);
  const companies: LayoutCompany[] = data?.companies ?? [];
  /* The Cash Flow carries directions — one more column, spares per side. */
  const cashFlow = report === 'rp';
  const span = 4 + companies.length + (cashFlow ? 1 : 0);
  const title = `Layout · ${REPORT_TITLES[report]}`;

  const apply = (next: Layout) => {
    if (!draft || next === draft) return;
    setDraft(next);
    setDirty(true);
    setError(null);
    setAsking(false);
  };

  const startRename = (id: string, label: string, total: string | null) => setRename({ id, label, total });
  const commitRename = () => {
    if (!draft || !rename) return;
    let next = draft;
    const label = rename.label.trim();
    if (label) next = renameCategory(next, rename.id, label);
    if (rename.total !== null) next = setTotalLabel(next, rename.id, rename.total);
    apply(next);
    setRename(null);
  };
  const renameKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') setRename(null);
  };

  const drop = (target: DropTarget, block: string) => {
    if (!draft || !drag || drag.block !== block) return;
    apply(placeItem(draft, block, drag.item, target));
    setDrag(null);
    setOver(null);
  };
  const dragProps = (block: string, target: DropTarget, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag || drag.block !== block) return;
      e.preventDefault();
      if (over !== key) setOver(key);
    },
    onDragLeave: () => { if (over === key) setOver(null); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); drop(target, block); },
  });
  const startDrag = (block: string, item: LayoutItem, key: string) => ({
    draggable: true,
    onDragStart: () => setDrag({ block, item, key }),
    onDragEnd: () => { setDrag(null); setOver(null); },
  });
  const rowClass = (base: string, key: string): string =>
    [base, drag?.key === key || parked?.key === key ? s.dragging : '', over === key && drag?.key !== key ? s.dropOn : ''].filter(Boolean).join(' ');
  const pickUp = (block: string, item: LayoutItem, key: string, label: string) => (
    <button type="button" className={s.iconBtn} aria-label={`Pick up ${label}`} title="Pick up: scroll to where it goes, then Place here"
      aria-pressed={parked?.key === key} onClick={() => setParked(parked?.key === key ? null : { block, item, key })}><Hand {...ICON} /></button>
  );
  /* Where a parked row may go down: before this row, or inside this category. */
  const placeHere = (block: string, target: DropTarget, key: string, label: string) =>
    parked && parked.block === block && parked.key !== key && (
      <button type="button" className={s.place} aria-label={`${target.kind === 'into' ? 'Place inside' : 'Place before'} ${label}`}
        onClick={() => { if (draft) apply(placeItem(draft, block, parked.item, target)); setParked(null); }}>
        {target.kind === 'into' ? 'Place inside' : 'Place here'}
      </button>
    );

  const onSave = async () => {
    if (!draft) return;
    setError(null);
    try {
      await save.mutateAsync(draft);
      setDirty(false);
      setAsking(false);
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
      setAsking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The layout was not reset.');
    }
  };
  const close = () => { if (dirty) setAsking(true); else onClose(); };

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
  const indentOf = (depth: number): React.CSSProperties => ({ paddingLeft: 16 * (depth - 1) });

  const order = (block: string, key: string, label: string) => (
    <span className={s.icons}>
      <button type="button" className={s.iconBtn} aria-label={`Move ${label} up`} title="Move up"
        onClick={() => draft && apply(moveWithinSiblings(draft, block, key, -1))}><ArrowUp {...ICON} /></button>
      <button type="button" className={s.iconBtn} aria-label={`Move ${label} down`} title="Move down"
        onClick={() => draft && apply(moveWithinSiblings(draft, block, key, 1))}><ArrowDown {...ICON} /></button>
    </span>
  );
  const noTicks = companies.map((co) => <td key={co.id} />);

  /* The name typed in place, and the subtotal line beside it where the category has one. */
  const renameBox = (it: { id: string; label: string }) => rename && (
    <span className={s.rename} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commitRename(); }}>
      <input
        autoFocus
        className={s.renName}
        aria-label={`Rename ${it.label}`}
        placeholder="Category name"
        value={rename.label}
        onChange={(e) => setRename({ ...rename, label: e.target.value })}
        onKeyDown={renameKeys}
      />
      {rename.total !== null && (
        <input
          className={s.renTotal}
          aria-label={`Subtotal name of ${it.label}`}
          title="Its subtotal line"
          placeholder={`Total ${rename.label.trim() || it.label}`}
          value={rename.total}
          onChange={(e) => setRename({ ...rename, total: e.target.value })}
          onKeyDown={renameKeys}
        />
      )}
      <button type="button" className={s.done} onClick={commitRename}>Done</button>
    </span>
  );

  const renderItems = (block: string, items: LayoutItem[], depth: number): React.ReactNode => items.map((it) => {
    const key = itemKey(it);
    if (it.kind === 'account') {
      return (
        <tr key={key} data-kind="account" className={rowClass('', key)} {...startDrag(block, it, key)} {...dragProps(block, { kind: 'before', key }, key)}>
          <td className={s.shrink}>
            <span className={s.codeCell} style={indentOf(depth)}>
              <span className={s.chevGap} aria-hidden />
              <span className={s.grip} title="Drag to move" aria-hidden><GripVertical {...ICON} /></span>
              <span className={s.code}>{it.code}</span>
            </span>
          </td>
          <td>{nameOf(it.code)}</td>
          {cashFlow && (
            <td>
              <select aria-label={`Direction of ${it.code}`} className={s.select} value={it.flow ?? 'in'}
                onChange={(e) => draft && apply(setAccountFlow(draft, block, key, e.target.value as Flow))}>
                <option value="in">In</option>
                <option value="out">Out</option>
                <option value="net">Net</option>
              </select>
            </td>
          )}
          {noTicks}
          <td className={`${s.shrink} ${s.center}`}>{order(block, key, it.code)}</td>
          <td className={`${s.shrink} ${s.right}`}>
            <span className={s.icons}>
              {placeHere(block, { kind: 'before', key }, key, it.code)}
              {pickUp(block, it, key, it.code)}
              <button type="button" className={s.iconBtn} aria-label={`Unplace ${it.code}`} title="Back to Unassigned"
                onClick={() => draft && apply(unplaceAccount(draft, block, it.code, it.flow))}><X {...ICON} /></button>
            </span>
          </td>
        </tr>
      );
    }
    if (it.kind === 'subtotal') {
      return (
        <tr key={key} data-kind="subtotal" className={rowClass(s.subtotal, key)} {...startDrag(block, it, key)} {...dragProps(block, { kind: 'before', key }, key)}>
          <td className={s.shrink}>
            <span className={s.codeCell} style={indentOf(depth)}>
              <span className={s.chevGap} aria-hidden />
              <span className={s.grip} title="Drag to move" aria-hidden><GripVertical {...ICON} /></span>
            </span>
          </td>
          <td>
            {rename?.id === it.id ? renameBox(it) : (
              <span className={s.name}><span>{it.label}</span><span className={s.subText}>subtotal of everything above</span></span>
            )}
          </td>
          {cashFlow && <td />}
          {noTicks}
          <td className={`${s.shrink} ${s.center}`}>{order(block, key, it.label)}</td>
          <td className={`${s.shrink} ${s.right}`}>
            <span className={s.icons}>
              {placeHere(block, { kind: 'before', key }, key, it.label)}
              {pickUp(block, it, key, it.label)}
              {rename?.id !== it.id && (
                <button type="button" className={s.iconBtn} aria-label={`Rename ${it.label}`} title="Rename" onClick={() => startRename(it.id, it.label, null)}><PenLine {...ICON} /></button>
              )}
              <button type="button" className={`${s.iconBtn} ${s.iconBtnDanger}`} aria-label={`Delete ${it.label}`} title="Delete the subtotal line"
                onClick={() => draft && apply(removeSubtotal(draft, it.id))}><X {...ICON} /></button>
            </span>
          </td>
        </tr>
      );
    }
    const open = !folded.has(it.id);
    /* Cash flow's sides (its top categories) name their own subtotal line. */
    const side = cashFlow && depth === 1;
    return (
      <Fragment key={key}>
        <tr data-kind="category" className={rowClass(s.category, key)} {...startDrag(block, it, key)} {...dragProps(block, { kind: 'into', categoryId: it.id }, key)}>
          <td className={s.shrink}>
            <span className={s.codeCell} style={indentOf(depth)}>
              <button type="button" className={s.chev} aria-label={open ? `Fold ${it.label}` : `Unfold ${it.label}`} onClick={() => toggleFold(it.id)}>
                {open ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
              </button>
              <span className={s.grip} title="Drag to move" aria-hidden><GripVertical {...ICON} /></span>
              <span className={s.code}>{it.code ?? ''}</span>
            </span>
          </td>
          <td>
            {rename?.id === it.id ? renameBox(it) : (
              <span className={s.name}>
                <span>{it.label}</span>
                {(side || it.totalLabel) && <span className={s.subText}>{`Subtotal line: ${it.totalLabel || `Total ${it.label}`}`}</span>}
              </span>
            )}
          </td>
          {cashFlow && (
            <td>
              {side && (
                <select aria-label={`Side of ${it.label}`} className={s.select} value={it.flow ?? 'in'}
                  onChange={(e) => draft && apply(setCategoryFlow(draft, it.id, e.target.value as Side))}>
                  <option value="in">In</option>
                  <option value="out">Out</option>
                </select>
              )}
            </td>
          )}
          {companies.map((co) => (
            <td key={co.id} className={s.center}>
              <input
                type="checkbox"
                className={s.tick}
                aria-label={`${it.label} for ${co.code}`}
                title={`${co.code} shows ${it.label}; unticked, its accounts print under Unassigned there`}
                checked={!(it.hiddenFor ?? []).includes(co.id)}
                onChange={(e) => draft && apply(setCategoryTick(draft, it.id, co.id, e.target.checked))}
              />
            </td>
          ))}
          <td className={`${s.shrink} ${s.center}`}>{order(block, key, it.label)}</td>
          <td className={`${s.shrink} ${s.right}`}>
            <span className={s.icons}>
              {placeHere(block, { kind: 'before', key }, `${key}:before`, it.label)}
              {placeHere(block, { kind: 'into', categoryId: it.id }, key, it.label)}
              {pickUp(block, it, key, it.label)}
              {rename?.id !== it.id && (
                <button type="button" className={s.iconBtn} aria-label={`Rename ${it.label}`} title="Rename"
                  onClick={() => startRename(it.id, it.label, it.totalLabel ?? '')}><PenLine {...ICON} /></button>
              )}
              <button type="button" className={s.iconBtn} aria-label={`Add a category under ${it.label}`} title="Add a category under it"
                onClick={() => draft && apply(addCategory(draft, block, it.id, 'New category', newCategoryId()))}><Plus {...ICON} /></button>
              <button type="button" className={`${s.iconBtn} ${s.iconBtnDanger}`} aria-label={`Delete ${it.label}`} title="Delete · what it holds moves up a level"
                onClick={() => draft && apply(removeCategory(draft, it.id))}><X {...ICON} /></button>
            </span>
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
    const blockKey = `block:${block.key}`;
    return (
      <Fragment key={block.key}>
        <tr data-block={block.key} className={rowClass(s.block, blockKey)} {...dragProps(block.key, { kind: 'end' }, blockKey)}>
          <td colSpan={2}>
            <span className={s.name}>
              <span>{block.title}</span>
              <span className={s.blockTools}>
                <button type="button" className={s.addLink} aria-label={`Add a category to ${block.title}`}
                  onClick={() => apply(addCategory(draft, block.key, null, 'New category', newCategoryId()))}>+ Add category</button>
                {parked && parked.block === block.key && (
                  <button type="button" className={s.place} aria-label={`Place at the end of ${block.title}`}
                    onClick={() => { apply(placeItem(draft, block.key, parked.item, { kind: 'end' })); setParked(null); }}>Place at the end</button>
                )}
                {cashFlow && (
                  <button type="button" className={s.addLink} aria-label={`Add a subtotal to ${block.title}`} title="A running subtotal of everything above it, In less Out"
                    onClick={() => apply(addSubtotal(draft, block.key, 'New subtotal', newSubtotalId()))}>+ Subtotal</button>
                )}
              </span>
            </span>
          </td>
          <td colSpan={span - 2} />
        </tr>
        {renderItems(block.key, items, 1)}
        {items.length === 0 && spares.every((sp) => sp.rows.length === 0) && (
          <tr className={s.empty}><td colSpan={span}>No accounts in this block.</td></tr>
        )}
        {spares.map(({ side, rows }) => rows.length > 0 && (
          <Fragment key={side ?? 'all'}>
            <tr className={s.spareHead} data-unassigned={side ? `${block.key}:${side}` : block.key}>
              <td colSpan={span}>
                {side
                  ? `Unassigned ${side === 'in' ? 'receipts' : 'payments'} — printed as their own group at the foot until placed on the ${sideWord(side)} side`
                  : `Unassigned — printed at the foot of ${block.title} until placed`}
              </td>
            </tr>
            {rows.map((a) => {
              const item: LayoutItem = side ? { kind: 'account', code: a.code, flow: side } : { kind: 'account', code: a.code };
              const key = `spare:${side ?? 'all'}:${a.code}`;
              const noSide = side !== null && sideCategory(side) === null;
              return (
                <tr key={a.code} data-kind="spare" className={rowClass(s.spare, key)} {...startDrag(block.key, item, key)}>
                  <td className={s.shrink}>
                    <span className={s.codeCell} style={indentOf(2)}>
                      <span className={s.chevGap} aria-hidden />
                      <span className={s.grip} title="Drag to move" aria-hidden><GripVertical {...ICON} /></span>
                      <span className={s.code}>{a.code}</span>
                    </span>
                  </td>
                  <td>{a.name}</td>
                  {cashFlow && <td><span className={s.dirText}>{side ? sideWord(side) : ''}</span></td>}
                  {noTicks}
                  <td />
                  <td className={`${s.shrink} ${s.right}`}>
                    <button type="button" className={s.place} aria-label={side ? `Place ${a.code} as ${sideWord(side)}` : `Place ${a.code}`}
                      disabled={noSide} title={noSide ? `Add an ${sideWord(side)} category first` : undefined}
                      onClick={() => placeSpare(a.code, side)}>
                      Place
                    </button>
                  </td>
                </tr>
              );
            })}
          </Fragment>
        ))}
      </Fragment>
    );
  };

  return (
    <InPlaceOfReport>
      <section role="dialog" aria-label={title} className={`${tokens.root} ${s.card}`}>
        <div className={s.head}>
          <div className={s.headText}>
            <h2 className={s.title}>
              <Layers size={16} strokeWidth={1.75} className={s.titleIcon} aria-hidden />
              {title}
              {dirty && <span className={s.tag}>Unsaved changes</span>}
            </h2>
            {data && (
              <div className={s.sub}>
                {data.stored
                  ? `Saved by ${data.updatedBy ?? '—'} on ${fmtDateOrDash(data.updatedAt)} · shared by every company`
                  : 'The chart\'s own tree — nothing saved yet · shared by every company'}
              </div>
            )}
          </div>
          <div className={s.actions}>
            <button type="button" className={s.btn} onClick={foldAll} disabled={!draft}>Fold all</button>
            <button type="button" className={s.btn} onClick={unfoldAll} disabled={!draft}>Unfold all</button>
            <button type="button" className={s.btn} onClick={() => void onReset()} disabled={reset.isPending || save.isPending}>Reset to chart</button>
            <button type="button" className={`${s.btn} ${s.btnSolid}`} onClick={() => void onSave()} disabled={!dirty || save.isPending || reset.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className={s.btn} onClick={close} aria-label="Close the layout editor">Close</button>
          </div>
        </div>
        {asking && (
          <div className={s.ask}>
            <AlertTriangle size={16} strokeWidth={1.75} className={s.askIcon} aria-hidden />
            <span className={s.askText}>This layout has changes that are not saved. Close it without them, or keep editing and Save.</span>
            <button type="button" className={s.btn} onClick={() => setAsking(false)}>Keep editing</button>
            <button type="button" className={`${s.btn} ${s.btnDanger}`} onClick={onClose}>Close without saving</button>
          </div>
        )}
        {error && <div role="alert" className={s.problem}>{error}</div>}
        {q.isLoading && <div className={s.status}>Reading the layout…</div>}
        {q.isError && <div className={s.problem}>The layout did not load — close and open it again.</div>}
        {data && draft && (
          <>
            <div className={s.note}>
              Drag a row onto a category to put it inside, onto an account to put it above, or use ↑ ↓. A tick means that
              company shows the category; unticked, its accounts print under Unassigned there. The block an account belongs
              to follows its section on the chart of accounts.
              {cashFlow && (
                <>
                  {' '}On the Cash flow every top category is In or Out — that decides the sign of its lines and which total they
                  feed; a line's own direction (In, Out, or Net = in − out) may differ, so one account can sit on both sides; a
                  side names its own subtotal line (Rename); a subtotal row sums everything above it, In less Out.
                </>
              )}
            </div>
            {parked && (
              <div className={s.parked} role="status">
                <Hand {...ICON} aria-hidden />
                <span className={s.askText}>{`Moving ${parked.item.kind === 'account' ? parked.item.code : parked.item.label}: scroll to where it goes and press Place here (Place inside for a category). Esc cancels.`}</span>
                <button type="button" className={s.btn} onClick={() => setParked(null)}>Cancel</button>
              </div>
            )}
            <div className={s.scroll} ref={scrollRef}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Account No.</th>
                    <th>Name</th>
                    {cashFlow && <th>Direction</th>}
                    {companies.map((co) => <th key={co.id} className={s.center}>{co.code}</th>)}
                    <th className={s.center}>Order</th>
                    <th className={s.right}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>{data.blocks.map(renderBlock)}</tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </InPlaceOfReport>
  );
};
