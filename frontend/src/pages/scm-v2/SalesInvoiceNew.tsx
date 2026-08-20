// ----------------------------------------------------------------------------
// SalesInvoiceNew — full-page Create Sales Invoice at /sales-invoices/new.
//
// An editable Create form, clone of DeliveryOrderNew (itself an SO-clone): the
// same Customer / Invoice Info / Emergency / Address cards + SoLineCard list +
// PaymentsTable in DRAFT mode.
//
// Prefill: when navigated with ?fromDo=<DO id>, it fetches the DO header +
// items + payments and seeds EVERY field (debtor, salesperson/agent, address,
// phone, line items with variants + prices, AND payment records) so the
// operator can review/edit before Saving to create the invoice. Without
// ?fromDo it is a blank Create-Invoice form.
//
// On Save: POST /sales-invoices (header + items) — the server records revenue
// (Dr Accounts Receivable / Cr Sales Revenue) on create — then replay the
// payment drafts through POST /:id/payments before navigating to the new
// invoice detail.
// ----------------------------------------------------------------------------

import { transferFromLabel } from '../../lib/convertScope';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { newIdempotencyKey, useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, removeScmHandoff } from '../../lib/scmHandoffStorage';
import { completePaymentRetryDraft, paymentRetryNavigationState, writePaymentRetryHandoff } from '../../lib/paymentRetryHandoff';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, ChevronDown, Plus, Save, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { DateField } from '../../vendor/scm/components/DateField';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { notifyAcNotSent } from '../../vendor/scm/lib/ac-not-sent';
import {
  useCreateSalesInvoice, useAddSalesInvoicePayment,
  useMfgDeliveryOrderDetail, useDeliveryOrderPayments,
} from '../../vendor/scm/lib/sales-invoice-queries';
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
import { useLocalities } from '../../vendor/scm/lib/localities-queries';
import {
  useAddressCascade, pickState, pickCity, pickPostcode,
  cityPlaceholder, postcodePlaceholder,
} from '../../vendor/scm/lib/address-cascade';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { SoLineCard, emptySoLine, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import {
  PaymentsTable, labelToApi, draftMethodFields, type PaymentDraft,
} from '../../vendor/scm/components/PaymentsTable';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtMoneySen } from '@2990s/shared';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type DraftLine = SoLineDraft & { rid: string; doItemId?: string };

const newLine = (): DraftLine => ({
  ...emptySoLine(),
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
});

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

export const SalesInvoiceNew = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  const [searchParams] = useSearchParams();
  const fromDo = searchParams.get('fromDo');
  const fromPicks = searchParams.get('fromPicks') === '1';

  const create = useCreateSalesInvoice();
  /* One key for the one invoice this page is open to raise (lib/idempotency.ts).
     Route-level form; onSuccess navigates to the SI detail unconditionally, so
     the MOUNT is exactly one invoice — stable across re-renders (lazy init) and
     across a re-press after a stalled submit, fresh on the next mount.

     Load-bearing beyond the double-tap: onSuccess awaits flushPaymentDrafts and
     up to two notifies BEFORE navigate, so it is the longest window in this set
     between "the invoice exists" and "the page leaves". A stable key means any
     re-press in that window replays the first invoiceNumber instead of posting
     revenue twice. The payment drafts carry their own per-draft keys (line 235),
     so they don't double either. */
  const idemKey = useIdempotencyKey();
  const addPayment = useAddSalesInvoicePayment();
  const staffQ = usePickableStaff({ onlySales: true });
  const loc = useLocalities();

  // Prefill source — the DO this invoice is being raised from (if any).
  const doDetail = useMfgDeliveryOrderDetail(fromDo);
  const doPayments = useDeliveryOrderPayments(fromDo);

  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship', relationshipOptsQ.data);

  // ── Customer ──
  const [debtorCode, setDebtorCode] = useState('');
  const [debtorName, setDebtorName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [salespersonId, setSalespersonId] = useState('');
  const [customerType, setCustomerType] = useState('');
  const [customerSoNo, setCustomerSoNo] = useState('');

  // ── Invoice info ──
  const [buildingType, setBuildingType] = useState('');
  const [venue, setVenue] = useState('');
  const [venueId, setVenueId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(() => todayMyt());
  const [dueDate, setDueDate] = useState('');
  const [customerDeliveryDate, setCustomerDeliveryDate] = useState('');
  const [note, setNote] = useState('');

  // ── Address ──
  const [address1, setAddress1] = useState('');
  const [address2, setAddress2] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [postcode, setPostcode] = useState('');
  const [salesLocation, setSalesLocation] = useState('');
  const [branding, setBranding] = useState('');

  // ── Provenance (Transfer From) — carried silently from the source DO so the
  //    invoice keeps its SO reference, customer PO and free-text ref. ──
  const [soDocNo, setSoDocNo] = useState('');
  const [poDocNo, setPoDocNo] = useState('');
  const [ref, setRef] = useState('');

  // ── Emergency ──
  const [emergencyName, setEmergencyName] = useState('');
  const [emergencyRel, setEmergencyRel] = useState('');
  const [emergencyPhone, setEmergencyPhone] = useState('');

  // ── Items + payments ──
  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()]);
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);
  const [createdInvoice, setCreatedInvoice] = useState<{ id: string; number: string } | null>(null);

  /* Prefill from the DO once its detail + payments load. Guarded so we only
     seed once (when the form is still pristine) — re-fetches don't clobber
     the operator's edits. */
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (!fromDo || prefilled) return;
    const doc = doDetail.data?.deliveryOrder as Record<string, unknown> | undefined;
    const doItems = (doDetail.data?.items as Array<Record<string, unknown>> | undefined) ?? [];
    if (!doc) return;

    setDebtorCode((doc.debtor_code as string) ?? '');
    setDebtorName((doc.debtor_name as string) ?? '');
    setPhone((doc.phone as string) ?? '');
    setEmail((doc.email as string) ?? '');
    setSalespersonId((doc.salesperson_id as string) ?? '');
    setCustomerType((doc.customer_type as string) ?? '');
    setCustomerSoNo((doc.customer_so_no as string) ?? '');
    setBuildingType((doc.building_type as string) ?? '');
    setVenue((doc.venue as string) ?? '');
    setVenueId((doc.venue_id as string) ?? '');
    setCustomerDeliveryDate((doc.customer_delivery_date as string) ?? '');
    setNote((doc.note as string) ?? '');
    setAddress1((doc.address1 as string) ?? '');
    setAddress2((doc.address2 as string) ?? '');
    setState((doc.customer_state as string) ?? (doc.state as string) ?? '');
    setCity((doc.city as string) ?? '');
    setPostcode((doc.postcode as string) ?? '');
    setSalesLocation((doc.sales_location as string) ?? '');
    setBranding((doc.branding as string) ?? '');
    setSoDocNo((doc.so_doc_no as string) ?? '');
    setPoDocNo((doc.po_doc_no as string) ?? '');
    setRef((doc.ref as string) ?? '');
    setEmergencyName((doc.emergency_contact_name as string) ?? '');
    setEmergencyRel((doc.emergency_contact_relationship as string) ?? '');
    setEmergencyPhone((doc.emergency_contact_phone as string) ?? '');

    // Line items. When we arrived from the DO→SI picker (fromPicks) the operator
    // already chose specific lines + quantities — build from that stash, carrying
    // each line's doItemId so the invoice stays linked to its DO line (the server's
    // remaining-to-invoice tracking depends on it). Otherwise (plain ?fromDo) seed
    // every DO line at its full quantity.
    type Stash = {
      doItemId: string; itemCode: string; itemGroup: string | null;
      description: string | null; uom: string | null; qty: number;
      unitPriceSen: number; discountSen: number; unitCostSen: number;
      variants: unknown;
    };
    const stash = fromPicks ? readScmHandoff<Stash[]>('siFromDoPicks') : null;

    if (stash && stash.length > 0) {
      setLines(stash.map((s, i) => ({
        ...emptySoLine(),
        rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${i}`,
        doItemId: s.doItemId,
        itemCode: s.itemCode ?? '',
        itemGroup: (s.itemGroup as string) ?? 'others',
        description: s.description ?? '',
        uom: s.uom ?? 'UNIT',
        qty: Number(s.qty ?? 1),
        unitPriceSen: Number(s.unitPriceSen ?? 0),
        discountSen: Number(s.discountSen ?? 0),
        unitCostSen: Number(s.unitCostSen ?? 0),
        variants: (s.variants as Record<string, unknown>) ?? {},
      })));
      removeScmHandoff('siFromDoPicks');
    } else if (doItems.length > 0) {
      setLines(doItems.map((it) => ({
        ...emptySoLine(),
        rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${String(it.id)}`,
        doItemId: (it.id as string) ?? undefined,
        itemCode: (it.item_code as string) ?? '',
        itemGroup: (it.item_group as string) ?? 'others',
        description: (it.description as string) ?? '',
        uom: (it.uom as string) ?? 'UNIT',
        qty: Number(it.qty ?? 1),
        unitPriceSen: Number(it.unit_price_sen ?? 0),
        discountSen: Number(it.discount_sen ?? 0),
        unitCostSen: Number(it.unit_cost_sen ?? 0),
        variants: (it.variants as Record<string, unknown>) ?? {},
        remark: (it.notes as string) ?? '',
      })));
    }

    // Payment records — map DO payments to PaymentsTable drafts. Skip when we
    // arrived from the line picker: a partial invoice must not re-record the DO's
    // full deposits. The operator adds any payment for this invoice by hand.
    const pays = fromPicks ? [] : (doPayments.data ?? []);
    if (pays.length > 0) {
      setPaymentDrafts(pays.map((p) => {
        const methodLabel = p.method === 'cash' ? 'Cash' : p.method === 'transfer' ? 'Online' : 'Merchant';
        const installmentLabel = p.installment_months && p.installment_months > 0 ? `${p.installment_months} months` : '';
        return {
          uid: `do-${p.id}`,
          paidAt: p.paid_at,
          methodLabel,
          merchantProvider: p.merchant_provider ?? '',
          installmentMonthsLabel: installmentLabel,
          onlineType: p.online_type ?? '',
          amountSen: p.amount_sen,
          accountSheet: p.account_sheet ?? '',
          approvalCode: p.approval_code ?? '',
          collectedBy: p.collected_by ?? '',
          // Copied DO payments become fresh SI drafts; SI route needs no slip.
          slipUploadSessionId: null,
          /* These drafts are built here rather than by newPaymentDraft, so mint
             their key here or they would post with no protection. The `prefilled`
             guard makes this effect run once, so the key is stable from then on. */
          idempotencyKey: newIdempotencyKey(),
        };
      }));
    }

    setPrefilled(true);
  }, [fromDo, fromPicks, prefilled, doDetail.data, doPayments.data]);

  const staffList = useMemo(() => (staffQ.data ?? []).filter((s) => s.active), [staffQ.data]);

  const locRows = useMemo(() => loc.data ?? [], [loc.data]);
  /* Shared address cascade, BOTH directions (address-cascade.ts). Three atoms,
     so each pick writes all three back — the raw setters keep the value just
     chosen, which routing through the State picker's handler would clear. */
  const { cities, postcodes } = useAddressCascade(locRows, state, city);
  const applyTriple = (next: { state: string; city: string; postcode: string }) => {
    setState(next.state); setCity(next.city); setPostcode(next.postcode);
  };
  const onCityPick = (next: string) => applyTriple(pickCity(locRows, { state, city, postcode }, next));
  const onPostcodePick = (next: string) => applyTriple(pickPostcode(locRows, { state, city, postcode }, next));

  const updateLine = (rid: string, patch: Partial<SoLineDraft>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, newLine()]);
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

  const subtotalSen = useMemo(
    () => lines.reduce((s, l) => s + Math.max(0, l.qty * l.unitPriceSen - l.discountSen), 0),
    [lines],
  );

  const canSave = debtorName.trim().length > 0;

  const paymentIntents = () => paymentDrafts.filter((d) => d.amountSen > 0);

  const flushPaymentDrafts = async (id: string, drafts: PaymentDraft[]): Promise<{ failedDrafts: PaymentDraft[] }> => {
    const tasks = drafts
      .map((d) => async () => {
        const { method } = labelToApi(d.methodLabel);
        const body: { id: string } & Record<string, unknown> = {
          id,
          paidAt: d.paidAt,
          method,
          amountSen: d.amountSen,
          accountSheet: d.accountSheet || null,
          approvalCode: d.approvalCode || null,
          collectedBy: d.collectedBy || null,
          // Per-draft key (lib/idempotency.ts) — the invoice is created first and
          // the payments posted after, so a re-save after a partial failure
          // re-posts these rows; the key makes that replay instead of duplicate.
          idempotencyKey: d.idempotencyKey,
        };
        Object.assign(body, draftMethodFields(method, d));
        try {
          await addPayment.mutateAsync(body);
          if (d.idempotencyKey) completePaymentRetryDraft('si', id, d.idempotencyKey);
          return null;
        }
        catch (e) {
          // eslint-disable-next-line no-console
          console.error('[si-payment] post failed for new invoice:', e);
          return d;
        }
      });
    const results: Array<PaymentDraft | null> = [];
    for (const task of tasks) results.push(await task());
    return { failedDrafts: results.filter((draft): draft is PaymentDraft => draft !== null) };
  };

  const onSave = (asDraft = false) => {
    if (createdInvoice) {
      const intents = paymentIntents();
      if (intents.length === 0) {
        navigate(`/scm/sales-invoices/${createdInvoice.id}`);
        return;
      }
      if (!writePaymentRetryHandoff('si', createdInvoice.id, intents)) {
        notify({
          title: `Invoice ${createdInvoice.number} already exists; payments were not sent.`,
          body: 'Browser storage is still unavailable. This page is keeping the payment rows; retry Save after storage is available.',
          tone: 'error',
        });
        return;
      }
      navigate(`/scm/sales-invoices/${createdInvoice.id}?retryPayments=1`, {
        state: paymentRetryNavigationState('si', createdInvoice.id, intents),
      });
      return;
    }
    if (!canSave) { notify({ title: 'Customer name is required.', tone: 'error' }); return; }
    if (asDraft && paymentDrafts.some((draft) => draft.amountSen > 0)) {
      notify({
        title: 'Payments are not saved on a draft invoice.',
        body: 'Confirm the invoice before recording payment, or remove the payment rows before saving this draft.',
        tone: 'error',
      });
      return;
    }
    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    if (validLines.length === 0) {
      notify({ title: 'Add at least one item via "+ Add Line Item".', tone: 'error' });
      return;
    }

    create.mutate(
      {
        idempotencyKey: idemKey,
        /* DRAFT flow — when saving as draft the server lands the invoice as DRAFT
           and posts NO revenue / credit until it is confirmed on the detail page. */
        asDraft: asDraft || undefined,
        deliveryOrderId: fromDo || undefined,
        debtorName,
        debtorCode: debtorCode || undefined,
        phone: phone || undefined,
        email: email || undefined,
        salespersonId: salespersonId || undefined,
        customerType: customerType || undefined,
        customerSoNo: customerSoNo || undefined,
        buildingType: buildingType || undefined,
        venue: venue || undefined,
        venueId: venueId || undefined,
        branding: branding || undefined,
        address1: address1 || undefined,
        address2: address2 || undefined,
        customerState: state || undefined,
        state: state || undefined,
        city: city || undefined,
        postcode: postcode || undefined,
        salesLocation: salesLocation || undefined,
        soDocNo: soDocNo || undefined,
        poDocNo: poDocNo || undefined,
        ref: ref || undefined,
        invoiceDate: invoiceDate || undefined,
        dueDate: dueDate || undefined,
        customerDeliveryDate: customerDeliveryDate || undefined,
        emergencyContactName: emergencyName || undefined,
        emergencyContactRelationship: emergencyRel || undefined,
        emergencyContactPhone: emergencyPhone || undefined,
        note: note || undefined,
        items: validLines.map((l) => ({
          doItemId: l.doItemId,
          itemGroup: l.itemGroup,
          itemCode: l.itemCode,
          description: l.description,
          uom: l.uom,
          qty: l.qty,
          unitPriceSen: l.unitPriceSen,
          discountSen: l.discountSen,
          unitCostSen: l.unitCostSen,
          variants: l.variants,
        })),
      },
      {
        onSuccess: async (res: { id: string; invoiceNumber: string; priceWarningMessage?: string }) => {
          /* A DRAFT invoice cannot take payments yet (the server 409s a draft
             payment). Skip the payment flush — the operator records payments
             after confirming on the detail page. */
          const intents = asDraft ? [] : paymentIntents();
          const staged = intents.length === 0 || writePaymentRetryHandoff('si', res.id, intents);
          const { failedDrafts } = staged
            ? await flushPaymentDrafts(res.id, intents)
            : { failedDrafts: intents };
          const failed = failedDrafts.length;
          if (failed > 0) {
            await notify({
              title: `Invoice ${res.invoiceNumber} was created, but ${failed} payment ` +
                `row${failed === 1 ? '' : 's'} ${staged ? 'failed to save' : 'was not sent'}.`,
              body: staged
                ? 'The failed rows will be available to retry on the Detail page.'
                : 'Browser storage was unavailable, so no payment request was attempted. The rows are carried to the Detail page for a safe retry.',
              tone: 'error',
            });
          }
          /* Price differs from the price agreed on the order (server-side
             comparison against the source DO line, which carries the SO's
             agreed price). ADVISORY, never a block — the selling price is the
             operator's to author (Commander 2026-05-29), so this states the
             discrepancy and gets out of the way. Not tone:'error': nothing
             failed, and the invoice was created. */
          if (res.priceWarningMessage) {
            await notify({
              title: `Invoice ${res.invoiceNumber} was created, but a price does not match the order.`,
              body: res.priceWarningMessage,
            });
          }
          /* THE ACCOUNTS MAY HAVE IT WITHOUT ALL OF IT — an invoice raised
             from a delivery order is TRANSFERRED into AutoCount, and the
             transfer route applies a narrower set of header fields than an edit
             does. Said before either exit, so the early return below cannot
             swallow it. Never blocks: the invoice exists. */
          await notifyAcNotSent(notify, res, 'Invoice');
          if (!staged) {
            setCreatedInvoice({ id: res.id, number: res.invoiceNumber });
            return;
          }
          navigate(
            `/scm/sales-invoices/${res.id}${failed > 0 ? '?retryPayments=1' : ''}`,
            { state: failed > 0 ? paymentRetryNavigationState('si', res.id, failedDrafts) : undefined },
          );
        },
        onError: (err) => notify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  const loadingPrefill = Boolean(fromDo) && !prefilled && (doDetail.isLoading || doPayments.isLoading);

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Supply Chain"
        title={createdInvoice
          ? `Complete Sales Invoice ${createdInvoice.number}`
          : `New Sales Invoice${fromDo ? ' — from Delivery Order' : ''}`}
        description={createdInvoice
          ? 'The invoice already exists. Finish or remove the retained payment rows, then continue to its Detail page.'
          : undefined}
        actions={
          <div className={styles.actions}>
            {/* Pull lines from a Delivery Order — mirrors the purchase-side New forms. */}
            {!createdInvoice && (
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/sales-invoices/from-do')}>
                <ArrowRightLeft {...ICON} /> {transferFromLabel('do')}
              </Button>
            )}
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/sales-invoices')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button variant="ghost" size="md" onClick={() => onSave(true)} disabled={create.isPending || !!createdInvoice}>
              <Save {...ICON} />
              {create.isPending ? 'Saving…' : 'Save as Draft'}
            </Button>
            <Button variant="primary" size="md" onClick={() => onSave(false)} disabled={create.isPending}>
              <Save {...ICON} />
              {create.isPending
                ? 'Saving…'
                : createdInvoice
                  ? (paymentIntents().length > 0 ? 'Continue payment retry' : 'Open created invoice')
                  : 'Create Sales Invoice'}
            </Button>
          </div>
        }
      />

      {createdInvoice && (
        <div role="status" className="mb-3 rounded-lg border border-warning-text/30 bg-warning-bg px-3 py-2 text-sm text-warning-text">
          Invoice {createdInvoice.number} already exists. This recovery view only keeps payment rows; customer, invoice and line-item fields are hidden so unsaved edits cannot be lost.
        </div>
      )}

      {!createdInvoice && (<>

      {loadingPrefill && (
        <div className={styles.bannerWarn} style={{ background: 'var(--c-cream)', border: '1px solid var(--line)', color: 'var(--fg-muted)' }}>
          Loading Delivery Order…
        </div>
      )}

      {/* ── CUSTOMER ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Customer</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={`${styles.fieldLabel} ${styles.fieldLabelReq}`}>Customer Name <span className={styles.req}>*</span></span>
              <input className={styles.fieldInput} value={debtorName}
                onChange={(e) => setDebtorName(e.target.value)} placeholder="e.g. Lim Mei Hua" required />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer SO Ref</span>
              <input className={styles.fieldInput} value={customerSoNo}
                placeholder="Their PO / SO number" onChange={(e) => setCustomerSoNo(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput className={styles.fieldInput} value={phone} onChange={setPhone} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input type="email" className={styles.fieldInput} value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="customer@example.com" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={customerType} onChange={(e) => setCustomerType(e.target.value)}>
                  <option value="">—</option>
                  {sortByText(customerTypeOpts).map((t) => <option key={t.id} value={t.value}>{t.label}</option>)}
                  {customerType && !customerTypeOpts.some((t) => t.value === customerType) && <option value={customerType}>{customerType}</option>}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Salesperson</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)}>
                  <option value="">— Pick staff —</option>
                  {sortByText(staffList).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>)}
                  {salespersonId && !staffList.some((s) => s.id === salespersonId) && <option value={salespersonId}>(former staff)</option>}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── INVOICE INFO ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Invoice Info</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Invoice Date</span>
              <DateField className={styles.fieldInput} fullWidth value={invoiceDate ?? ''} onChange={(iso) => setInvoiceDate(iso)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Due Date</span>
              <DateField className={styles.fieldInput} fullWidth value={dueDate ?? ''} onChange={(iso) => setDueDate(iso)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={buildingType} onChange={(e) => setBuildingType(e.target.value)}>
                  <option value="">—</option>
                  {sortByText(buildingTypeOpts).map((b) => <option key={b.id} value={b.value}>{b.label}</option>)}
                  {buildingType && !buildingTypeOpts.some((b) => b.value === buildingType) && <option value={buildingType}>{buildingType}</option>}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Venue</span>
              <input className={styles.fieldInput} value={venue} onChange={(e) => setVenue(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Internal notes — visible on the invoice detail page only" />
            </label>
          </div>
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Emergency Contact</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            Used only if we cannot reach the customer
          </span>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Contact Name</span>
              <input className={styles.fieldInput} value={emergencyName} placeholder="e.g. Lim Mei Hua"
                onChange={(e) => setEmergencyName(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={emergencyRel} onChange={(e) => setEmergencyRel(e.target.value)}>
                  <option value="">—</option>
                  {sortByText(relationshipOpts).map((r) => <option key={r.id} value={r.value}>{r.label}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput className={styles.fieldInput} value={emergencyPhone} onChange={setEmergencyPhone} />
            </label>
          </div>
        </div>
      </section>

      {/* ── BILLING / DELIVERY ADDRESS ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Billing / Delivery Address</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 1</span>
              <input className={styles.fieldInput} value={address1} onChange={(e) => setAddress1(e.target.value)} placeholder="Unit, street, area" />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input className={styles.fieldInput} value={address2} onChange={(e) => setAddress2(e.target.value)} placeholder="Apt, floor, building (optional)" />
            </label>
            {/* Owner spec 2026-07-23 — StatePicker (MY-default, click Others for CN/SG, Search). Same shared component as Warehouse / Supplier / Venue / MobileNewSO / SalesOrderNew. No `(legacy)` sneak-through, no free-text fallback. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>State</span>
              <StatePicker
                value={state}
                onChange={(next) => applyTriple(pickState(next))}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>City</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={city}
                  onChange={(e) => onCityPick(e.target.value)}>
                  <option value="">{cityPlaceholder(state)}</option>
                  {sortByText(cities).map((cc) => <option key={cc} value={cc}>{cc}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Postcode</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={postcode}
                  onChange={(e) => onPostcodePick(e.target.value)}>
                  <option value="">{postcodePlaceholder(state, city)}</option>
                  {sortByNumeric(postcodes).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── LINE ITEMS ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Line Items ({lines.length})</h2></header>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.map((line, idx) => (
            <SoLineCard
              key={line.rid}
              index={idx}
              draft={line}
              onChange={(patch) => updateLine(line.rid, patch)}
              onRemove={() => dropLine(line.rid)}
              canRemove={lines.length > 1}
              /* Downstream document: the items were already specified on the
              originating order and their variants ride in with them, so they
              are NOT re-required here. Same rule DeliveryOrderNewV2 states
              for the DO. Verified 2026-08-13: this document's server does no
              variant enforcement at all (findIncompleteVariantLines appears
              0 times in its route), so the default `= true` was pure
              client-side invention - a red ring and a ` *` for a field the
              backend never asked for. */
              variantsRequired={false}
            />
          ))}
          <button type="button" onClick={addLine}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%',
              padding: '12px 14px', background: 'transparent', border: '1px dashed var(--c-orange)',
              borderRadius: 'var(--radius-md)', color: 'var(--c-orange)', fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)', fontWeight: 600, cursor: 'pointer',
            }}>
            <Plus {...ICON} /> Add Line Item
          </button>
          <div style={{
            display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-2)', paddingTop: 'var(--space-3)',
            borderTop: '1px solid var(--line)', fontFamily: 'var(--font-mark)', fontSize: 'var(--fs-20)',
            fontWeight: 800, color: 'var(--c-burnt)',
          }}>
            Subtotal: {fmtRm(subtotalSen)}
          </div>
        </div>
      </section>

      </>)}

      {/* ── PAYMENTS (shared draft-mode ledger) ── */}
      <PaymentsTable
        docNo={null}
        payments={paymentDrafts}
        onChange={setPaymentDrafts}
        grandTotalSen={subtotalSen}
        currency="MYR"
      />
    </div>
  );
};
