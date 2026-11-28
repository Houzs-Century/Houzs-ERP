// ----------------------------------------------------------------------------
// Delivery Amend Reasons — the owner-managed list of amend / reschedule reasons
// (migration 20261127T1000 / route delivery-amend-reasons.ts). These are the
// English phrases the Delivery Planning board's "Amend Reason" column and the
// Set-job-date drawer offer in their dropdown; the reason a Sales Order carries
// becomes the Postpone WhatsApp's "...due to X" line that the customer reads.
//
// The owner adds / edits / removes the options here (owner 2026-11-27) instead of
// a developer changing a hardcoded list. Wording appears VERBATIM to the customer,
// so the editor shows exactly how each reads after "due to". Changing the list
// only affects future picks: a reason already saved on an order is plain text and
// is untouched. Company-scoped, like Regions and Residence rules.
//
// Rendered standalone and as the "Amend reasons" tab in Coverage & Fleet (embedded
// drops its own PageHeader). Toolbar lives in the body so New works when embedded.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import {
  useDeliveryAmendReasons,
  useCreateDeliveryAmendReason,
  useUpdateDeliveryAmendReason,
  useDeleteDeliveryAmendReason,
  type AmendReasonRow,
} from '../../vendor/scm/lib/delivery-amend-reasons-queries';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { PageHeader } from '../../components/Layout';
import { ResizableDrawer } from '../../components/ResizableDrawer';
import { cn } from '../../lib/utils';
import { hit } from './fleet/coverageModel';
import {
  Card, Chip, Field, IconBtn, ListToolbar, NoMatch, PencilIcon, ReadRows, Switch,
  dangerBtn, exportCsv, inputCls, primaryBtn, secondaryBtn,
} from './fleet/ui';

type Open = { mode: 'read' | 'edit'; id: string } | { mode: 'new' } | null;

export const DeliveryAmendReasons = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const reasons = useDeliveryAmendReasons();
  const update = useUpdateDeliveryAmendReason();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Open>(null);
  const all = reasons.data ?? [];
  const shown = all.filter((r) => hit(q, r.label));
  const current = open && open.mode !== 'new' ? all.find((r) => r.id === open.id) ?? null : null;
  const nextSortOrder = all.reduce((m, r) => Math.max(m, r.sortOrder), 0) + 10;

  const doExport = () => exportCsv('amend-reasons.csv', shown, [
    { key: 'label', label: 'Reason (shown to customer after "due to")', getValue: (r) => r.label },
    { key: 'order', label: 'Order', getValue: (r) => String(r.sortOrder) },
    { key: 'active', label: 'Active', getValue: (r) => (r.isActive ? 'Active' : 'Inactive') },
  ]);

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader
          eyebrow="Delivery"
          title="Amend Reasons"
          description='The reasons an operator can pick when amending or postponing a delivery. The one on the order is sent to the customer verbatim in the WhatsApp postpone notice ("We need to postpone it due to ..."), so write each so it reads naturally after "due to".'
        />
      )}
      <ListToolbar search={q} onSearch={setQ} placeholder="Search reasons" shown={shown.length} total={all.length}
        onExport={doExport} newLabel="New Reason" onNew={() => setOpen({ mode: 'new' })} />
      {reasons.isError && <p className="text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">The reasons could not be loaded.</p>}
      {reasons.isLoading && <p className="text-[13px] text-ink-muted">Loading reasons…</p>}
      {!reasons.isLoading && !reasons.isError && shown.length === 0 && (
        <NoMatch text={all.length === 0 ? 'No reasons yet. Add one (e.g. "A public holiday falling on your delivery day") so operators can pick it when postponing.' : 'No reason matches this search.'}
          onClear={all.length === 0 ? null : () => setQ('')} />
      )}
      <div className="space-y-2">
        {shown.map((r) => (
          <div key={r.id} className={cn('flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3', !r.isActive && 'opacity-60')}>
            <p className="min-w-0 flex-1 text-[14px] text-ink">
              <span className="text-ink-muted">due to </span>{r.label}
            </p>
            {!r.isActive && <Chip tone="grey">Hidden</Chip>}
            <Switch on={r.isActive} label={`${r.label} active`} disabled={update.isPending}
              onClick={() => update.mutate({ id: r.id, isActive: !r.isActive }, { onError: writeFailedAs('The reason was not changed') })} />
            <IconBtn label={`Edit reason`} onClick={() => setOpen({ mode: 'edit', id: r.id })}><PencilIcon /></IconBtn>
          </div>
        ))}
      </div>
      {open && (open.mode === 'new' || current) && (
        <ReasonDrawer key={open.mode === 'new' ? 'new' : current!.id} reason={current} editing={open.mode !== 'read'}
          nextSortOrder={nextSortOrder} onEdit={() => current && setOpen({ mode: 'edit', id: current.id })} onClose={() => setOpen(null)} />
      )}
    </div>
  );
};

function ReasonDrawer({ reason, editing, nextSortOrder, onEdit, onClose }: {
  reason: AmendReasonRow | null; editing: boolean; nextSortOrder: number; onEdit: () => void; onClose: () => void;
}) {
  const del = useDeleteDeliveryAmendReason();
  const confirm = useConfirm();
  const remove = (r: AmendReasonRow) => {
    void confirm({
      title: 'Delete this reason?',
      body: 'It will no longer appear in the pick list. Orders that already carry it keep it — this only removes it as an option. You can re-add it later. To keep it but hide it, turn it off instead.',
      confirmLabel: 'Delete', danger: true,
    }).then((ok) => { if (ok) del.mutate(r.id, { onSuccess: onClose, onError: writeFailedAs('The reason was not deleted') }); });
  };
  return (
    <ResizableDrawer onClose={onClose} storageKey="amend-reason-drawer" defaultWidth={480} ariaLabel={reason ? `Amend reason ${reason.label}` : 'New amend reason'}
      title={reason ? (editing ? 'Edit reason' : 'Reason') : 'New Reason'} subtitle="Amend / postpone reason"
      headerActions={reason && !editing ? <button type="button" onClick={onEdit} className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-white">Edit</button> : null}>
      {editing ? <ReasonForm reason={reason} nextSortOrder={nextSortOrder} onDone={onClose} /> : reason && (
        <div className="space-y-3 p-4">
          <Card>
            <ReadRows rows={[
              ['Reads as', <span key="r">due to {reason.label}</span>],
              ['Order', String(reason.sortOrder)],
              ['Active', reason.isActive ? 'Yes' : 'No'],
            ]} />
          </Card>
          <button type="button" onClick={() => remove(reason)} disabled={del.isPending} className={dangerBtn}>Delete reason</button>
        </div>
      )}
    </ResizableDrawer>
  );
}

function ReasonForm({ reason, nextSortOrder, onDone }: { reason: AmendReasonRow | null; nextSortOrder: number; onDone: () => void }) {
  const create = useCreateDeliveryAmendReason();
  const update = useUpdateDeliveryAmendReason();
  const [label, setLabel] = useState(reason?.label ?? '');
  const [sortOrder, setSortOrder] = useState(String(reason?.sortOrder ?? nextSortOrder));
  const [active, setActive] = useState(reason?.isActive ?? true);
  const trimmed = label.trim();
  const orderNum = Number(sortOrder);
  const problem = !trimmed ? 'Type the reason.' : !Number.isFinite(orderNum) ? 'Order must be a number.' : null;
  const pending = create.isPending || update.isPending;
  const save = () => {
    if (problem) return;
    const body = { label: trimmed, sortOrder: Math.round(orderNum), isActive: active };
    if (reason) update.mutate({ id: reason.id, ...body }, { onSuccess: onDone, onError: writeFailedAs('The reason was not saved') });
    else create.mutate(body, { onSuccess: onDone, onError: writeFailedAs('The reason was not added') });
  };
  return (
    <div className="space-y-4 p-4">
      <Field label='Reason (reads after "due to")' wide>
        <textarea value={label} onChange={(e) => setLabel(e.target.value)} rows={2} maxLength={200}
          placeholder="e.g. A public holiday falling on your delivery day"
          className={cn(inputCls, 'min-h-[64px] py-2 leading-snug')} />
      </Field>
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink-secondary">
        Customer sees: <span className="text-ink">We need to postpone it due to {trimmed || '…'}</span>
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Order">
          <input type="number" step="1" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className={inputCls} />
        </Field>
        <div className="flex items-end gap-2">
          <Switch on={active} label="Active" disabled={pending} onClick={() => setActive((v) => !v)} />
          <span className="pb-2 text-[13px] text-ink">{active ? 'Shown in the list' : 'Hidden from the list'}</span>
        </div>
      </div>
      <p className="text-[12px] text-ink-muted">Lower order shows first. Hiding keeps the reason but drops it from the pick list; orders already using it keep it.</p>
      {problem && label !== '' && <p className="text-[12.5px] text-[color:var(--hz-dk-err,#8a2c2c)]">{problem}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={problem !== null || pending} onClick={save} className={primaryBtn}>{pending ? 'Saving…' : reason ? 'Save changes' : 'Create Reason'}</button>
        <button type="button" onClick={onDone} className={secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}

export default DeliveryAmendReasons;
