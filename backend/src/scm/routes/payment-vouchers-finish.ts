
import { bookRefundCredit, refundHookInput } from '../lib/pv-refund';
import { refundDepositInvoicesBestEffort, releaseRefundNotesBestEffort } from '../../acc/deposit-refunds';
import { mirrorRefundBestEffort, removeMirrorRowsBestEffort } from '../lib/so-payment-row';
import { normalizeCurrency } from '../lib/fx';
import { recordEntityAudit, compactChanges, fieldChange } from '../lib/entity-audit';
import { planPvRateAdoption, isRateRetainedFromPv, roundRate6 } from '../lib/pv-rate-adoption';
import { recostFromGrn } from '../lib/recost';
import { fmtSen } from '../shared/format';
import { settlePvAllocation, unsettlePvAllocation, voucherAdvanceSen } from '../lib/pv-allocation-settle';

/** The voucher's journal contra (reversePvAccounting in payment-vouchers.ts), handed in. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the PostgREST client is untyped across the voucher routes
export type ReversePv = (sb: any, pvNumber: string) => Promise<{ ok: boolean; status: string; jeNo?: string; jeId?: string; reason?: string }>;

export async function finishPostedVoucher(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Hono context and the PostgREST client are untyped across this route file, as in every handler above
  c: any, sb: any,
  pvRaw: Record<string, unknown>,
  o: { id: string; companyId: number | null; postedTotalSen: number | null; refund: boolean; supplierPayment: boolean; actor: string },
): Promise<{ advanceSen?: number; overAllocated?: string[]; rateAdopted?: string[]; rateMismatch?: string[]; settleErrors?: string[] }> {
  const id = o.id;
  const companyId = o.companyId;
  const pv = pvRaw as {
    pv_number: string; voucher_date: string; payee_name: string; purpose: string | null; currency: string | null;
    exchange_rate: string | number | null; total_sen: number; company_id: number | null;
    refund_source_type?: string | null; refund_source_doc_no?: string | null; debtor_code?: string | null;
  };
  const settleErrors: string[] = [];
  const rawRate = Number(pv.exchange_rate ?? 1);
  const postedTotalSen = o.postedTotalSen ?? Math.round(Number(pv.total_sen) * (Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1));

  if (o.refund) {
    await bookRefundCredit(sb, { id, pv_number: pv.pv_number, company_id: companyId, debtor_code: pv.debtor_code ?? null, payee_name: pv.payee_name, total_sen: Number(pv.total_sen) }, 'refund');
    /* The deposit-invoice half of a refund (docs/bugs/0860): a credit note per invoice it draws on. */
    const hook = refundHookInput({ ...pv, id, company_id: companyId }, postedTotalSen, o.actor);
    await refundDepositInvoicesBestEffort(sb, hook);
    const mirrorErr = await mirrorRefundBestEffort(sb, hook);
    if (mirrorErr) settleErrors.push(mirrorErr);
  }

  const overAllocated: string[] = [];
  /* "The payment defines the FX rate" (owner, 2026-07-30) — see lib/pv-rate-adoption.
     rateAdopted names the invoices whose un-rated foreign rate this payment filled
     in (and whose GRN was therefore re-costed); rateMismatch names the ones that
     already carried a DIFFERENT deliberate rate and were LEFT ALONE. Both are
     handed back to the caller for the same reason overAllocated is: they are money
     facts an operator has to be able to see, not implementation detail. */
  const rateAdopted: string[] = [];
  const rateMismatch: string[] = [];
  let allSettled = true;
  if (o.supplierPayment) {
    const { data: allocs, error: allocErr } = await sb.from('pv_allocations')
      .select('id, pi_id, ap_invoice_id, amount_sen, from_advance').eq('pv_id', id);
    if (allocErr) {
      allSettled = false;
      settleErrors.push(`The invoices this voucher pays could not be read, so none was settled: ${allocErr.message}. Press Post again to finish.`);
    }
    for (const a of (allocs ?? []) as Array<{ id: string; pi_id: string | null; ap_invoice_id: string | null; amount_sen: number; from_advance: boolean | null }>) {
      if (a.from_advance === true) continue;
      const settled = await settlePvAllocation(sb, a.id);
      if (!settled.ok) {
        allSettled = false;
        /* eslint-disable-next-line no-console */
        console.error('[pv-settle] allocation left unsettled:', pv.pv_number, a.id, settled.reason);
        settleErrors.push(`${a.pi_id ? 'Purchase invoice' : 'AP invoice'} ${a.pi_id ?? a.ap_invoice_id} was not settled: ${settled.reason ?? 'unknown error'}. Press Post again to finish.`);
        continue;
      }
      if (settled.alreadySettled) continue;
      const clampedSen = settled.askedSen - settled.appliedSen;
      if (clampedSen > 0) {
        /* eslint-disable-next-line no-console */
        console.error('[pv-settle] allocation exceeded the invoice outstanding — clamped:',
          pv.pv_number, a.pi_id ?? a.ap_invoice_id, 'requested', settled.askedSen, 'applied', settled.appliedSen);
        overAllocated.push(a.ap_invoice_id
          ? `AP invoice ${a.ap_invoice_id}: ${fmtSen(clampedSen)} refused`
          : `${a.pi_id}: asked ${fmtSen(settled.askedSen)}, applied ${fmtSen(settled.appliedSen)}`);
      }
      if (!a.pi_id || a.ap_invoice_id) continue;

      /* ── THE PAYMENT DEFINES THE FX RATE (owner-approved, 2026-07-30) ────────
         The knock-off is the moment the true MYR-per-foreign-unit figure becomes
         known, so it is the moment an un-rated foreign invoice gets its rate and
         its GRN gets re-costed. The whole decision is in planPvRateAdoption, which
         is pure — see lib/pv-rate-adoption.ts for the table and the reasoning.

         BEST-EFFORT BY CONTRACT, and this is not a preference. By the time we are
         here the journal entry is committed and the money has left the bank; there
         is no transaction to roll back into and nothing about a costing refresh
         justifies 500-ing a payment that already happened. So every failure below
         is logged and stepped over, as the settle failure above is. */
      if (settled.appliedSen > 0) {
        try {
          const { data: piRaw, error: piErr } = await sb.from('purchase_invoices')
            .select('id, invoice_number, currency, exchange_rate, grn_id').eq('id', a.pi_id).maybeSingle();
          if (piErr) throw new Error(`invoice read failed: ${String(piErr.message)}`);
          const piRow = piRaw as {
            id: string; invoice_number: string | null; currency: string | null;
            exchange_rate: string | number | null; grn_id: string | null;
          } | null;
          if (piRow) {
            const plan = planPvRateAdoption({
              appliedSen: settled.appliedSen,
              pvCurrency: pv.currency,
              pvExchangeRate: pv.exchange_rate,
              pi: {
                piId: piRow.id,
                docNo: piRow.invoice_number,
                currency: piRow.currency,
                exchangeRate: piRow.exchange_rate,
                grnId: piRow.grn_id,
              },
            });
            const piLabel = piRow.invoice_number ?? a.pi_id;

            if (plan.action === 'adopt') {
              const { error: rateErr } = await sb.from('purchase_invoices')
                .update({ exchange_rate: plan.rate, updated_at: new Date().toISOString() })
                .eq('id', a.pi_id);
              if (rateErr) {
                /* eslint-disable-next-line no-console */
                console.error('[pv-fx-rate] rate adoption write failed — invoice left un-rated:',
                  pv.pv_number, 'pi', piLabel, rateErr.message);
              } else {
                rateAdopted.push(`${piLabel}: rate ${plan.oldRate} -> ${plan.rate} (from ${pv.pv_number})`);
                await recordEntityAudit(sb, {
                  entityType: 'PURCHASE_INVOICE',
                  entityId: a.pi_id,
                  entityDocNo: piRow.invoice_number ?? null,
                  action: 'UPDATE',
                  actor: c.get('houzsUser'),
                  companyId,
                  note: `Exchange rate adopted from payment voucher ${pv.pv_number}`,
                  fieldChanges: compactChanges([
                    fieldChange('exchangeRate', plan.oldRate, plan.rate),
                    fieldChange('currency', null, normalizeCurrency(piRow.currency)),
                    fieldChange('rateSourcePv', null, pv.pv_number),
                    fieldChange('appliedSen', null, settled.appliedSen),
                  ]),
                });
                if (plan.grnId) {
                  try {
                    await recostFromGrn(sb, plan.grnId);
                  } catch (e) {
                    /* eslint-disable-next-line no-console */
                    console.error('[pv-fx-rate] recost after rate adoption failed — rate stored, lots stale:',
                      pv.pv_number, 'pi', piLabel, 'grn', plan.grnId, e);
                  }
                }
              }
            } else if (plan.action === 'report_mismatch') {
              /* eslint-disable-next-line no-console */
              console.error('[pv-fx-rate] invoice rate differs from the payment rate — invoice LEFT UNCHANGED:',
                pv.pv_number, 'pi', piLabel, 'invoice rate', plan.piRate, 'payment rate', plan.pvRate);
              rateMismatch.push(`${piLabel}: invoice rate ${plan.piRate}, payment rate ${plan.pvRate} — invoice rate kept`);
            }
          }
        } catch (e) {
          /* eslint-disable-next-line no-console */
          console.error('[pv-fx-rate] rate adoption skipped after an unexpected failure — payment stands:',
            pv.pv_number, 'pi', a.pi_id, e);
        }
      }
    }
  }

  if (rateAdopted.length > 0 || rateMismatch.length > 0) {
    await recordEntityAudit(sb, {
      entityType: 'PAYMENT_VOUCHER',
      entityId: id,
      entityDocNo: pv.pv_number,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId,
      statusSnapshot: 'POSTED',
      note: 'Exchange rate propagated from this payment to the invoices it settled',
      fieldChanges: compactChanges([
        fieldChange('currency', null, normalizeCurrency(pv.currency)),
        fieldChange('exchangeRate', null, roundRate6(pv.exchange_rate)),
        fieldChange('fxRateAdoptedOnPi', null, rateAdopted.length > 0 ? rateAdopted.join('; ') : null),
        fieldChange('fxRateMismatchOnPi', null, rateMismatch.length > 0 ? rateMismatch.join('; ') : null),
      ]),
    });
  }

  /* ── 预付挂在 supplier (the owner, 2026-08-30) ─────────────────────────────
     Whatever this supplier voucher paid BEYOND what its invoices took is an advance: the GL already debited the
     whole amount into AP, so the supplier's ledger runs ahead. Counted from applied_sen: money an invoice refused
     (the clamp) is still in AP and belongs here, not to nobody - counting amount_sen lost it. Recorded only once
     every allocation is settled, so an unsettled one is never booked as advance and then settled as well on the
     retry. UNIQUE(pv_id) makes a resumed post harmless. */
  let advanceSen = 0;
  const supplierId = (pvRaw as { supplier_id?: string | null }).supplier_id ?? null;
  if (o.supplierPayment && supplierId && allSettled) {
    const { data: hadAdv, error: hadErr } = await sb.from('acc_supplier_advances').select('id').eq('pv_id', id).limit(1);
    const { data: allocRows, error: alErr } = await sb.from('pv_allocations')
      .select('applied_sen, from_advance').eq('pv_id', id);
    if (hadErr) {
      settleErrors.push(`The supplier advance was not checked (${hadErr.message}). Press Post again to finish.`);
    } else if (((hadAdv ?? []) as unknown[]).length > 0) {
    } else if (alErr) {
      /* eslint-disable-next-line no-console */
      console.error('[pv-advance] allocation read failed — advance NOT recorded:', pv.pv_number, alErr.message);
      settleErrors.push(`The supplier advance was not recorded (allocations unreadable: ${alErr.message}). Press Post again to finish.`);
    } else {
      advanceSen = voucherAdvanceSen(Number(pv.total_sen), (allocRows ?? []) as Array<{ applied_sen: number | null; from_advance: boolean | null }>);
      if (advanceSen > 0) {
        const { error: advErr } = await sb.from('acc_supplier_advances').insert({
          company_id: companyId, supplier_id: supplierId,
          pv_id: id, pv_number: pv.pv_number, amount_sen: advanceSen, applied_sen: 0,
        });
        const dup = advErr && (String(advErr.code ?? '') === '23505' || /duplicate key/i.test(String(advErr.message ?? '')));
        if (advErr && !dup) {
          /* eslint-disable-next-line no-console */
          console.error('[pv-advance] advance NOT recorded:', pv.pv_number, advErr.message);
          settleErrors.push(`The supplier advance of ${fmtSen(advanceSen)} was not recorded: ${advErr.message}. Press Post again to finish.`);
          advanceSen = 0;
        } else if (dup) {
          advanceSen = 0;
        } else {
          await recordEntityAudit(sb, {
            entityType: 'PAYMENT_VOUCHER', entityId: id, entityDocNo: pv.pv_number,
            action: 'UPDATE', actor: c.get('houzsUser'), companyId,
            statusSnapshot: 'POSTED',
            note: `Paid ${fmtSen(advanceSen)} ahead of any invoice — recorded as this supplier's advance, to knock off against invoices to come`,
            fieldChanges: compactChanges([fieldChange('supplierAdvanceSen', null, advanceSen)]),
          });
        }
      }
    }
  }

  return {
    ...(advanceSen > 0 ? { advanceSen } : {}),
    ...(overAllocated.length > 0 ? { overAllocated } : {}),
    ...(rateAdopted.length > 0 ? { rateAdopted } : {}),
    ...(rateMismatch.length > 0 ? { rateMismatch } : {}),
    ...(settleErrors.length > 0 ? { settleErrors } : {}),
  };
}

export async function finishCancelledVoucher(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Hono context and the PostgREST client are untyped across this route file, as in every handler above
  c: any, sb: any,
  head: {
    pv_number: string; purpose: string | null; currency: string | null; exchange_rate: string | number | null;
    company_id: number | null; total_sen: number; payee_name: string; debtor_code?: string | null;
  },
  o: { id: string; companyId: number; resumed: boolean; refund: boolean; supplierPayment: boolean; actor: string; reverse: ReversePv },
): Promise<{ fxRateRetained?: string[]; settleErrors?: string[] }> {
  const id = o.id;
  const settleErrors: string[] = [];

  const rev = await o.reverse(sb, head.pv_number);
  if (rev.ok && o.refund) {
    await bookRefundCredit(sb, { id, ...head }, 'reversal');
    await releaseRefundNotesBestEffort(sb, { companyId: o.companyId, pvId: id, pvNumber: head.pv_number, actor: o.actor });
    const missed = await removeMirrorRowsBestEffort(sb, { companyId: o.companyId, match: { refund_pv_id: id }, why: `refund voucher ${head.pv_number} cancelled` });
    for (const m of missed) settleErrors.push(`${m} Press Cancel again to finish.`);
  }
  if (!rev.ok) {
    // eslint-disable-next-line no-console
    console.error(`[pv-accounting] reversal failed for ${head.pv_number}:`, rev.status, rev.reason);
    settleErrors.push(`The voucher is cancelled, but its journal was NOT reversed (${rev.status}${rev.reason ? `: ${rev.reason}` : ''}). Press Cancel again to finish.`);
  }
  if (!o.resumed || !rev.ok || rev.status === 'reversed') {
    await recordEntityAudit(sb, {
      entityType: 'PAYMENT_VOUCHER',
      entityId: id,
      entityDocNo: head.pv_number,
      action: 'REVERSE',
      actor: c.get('houzsUser'),
      statusSnapshot: 'CANCELLED',
      note: rev.ok ? `GL reversal: ${rev.status}` : `GL reversal FAILED: ${rev.status} — ${rev.reason ?? 'no reason given'}`,
      fieldChanges: compactChanges([
        fieldChange('reversalJeNo', null, rev.jeNo ?? null),
        fieldChange('reversalOk', null, rev.ok),
      ]),
    });
  }

  const fxRateRetained: string[] = [];
  if (o.supplierPayment) {
    const { data: allocs, error: allocErr } = await sb.from('pv_allocations')
      .select('id, pi_id, ap_invoice_id, applied_sen').eq('pv_id', id);
    if (allocErr) settleErrors.push(`The invoices this voucher paid could not be read, so none was unwound: ${allocErr.message}. Press Cancel again to finish.`);
    for (const a of (allocs ?? []) as Array<{ id: string; pi_id: string | null; ap_invoice_id: string | null; applied_sen: number | null }>) {
      const applied = Math.max(0, Number(a.applied_sen ?? 0));
      if (applied <= 0) continue;
      if (a.pi_id && !a.ap_invoice_id) {
        try {
          const { data: piRaw, error: piErr } = await sb.from('purchase_invoices')
            .select('invoice_number, currency, exchange_rate').eq('id', a.pi_id).maybeSingle();
          if (piErr) throw new Error(`invoice read failed: ${String(piErr.message)}`);
          const piRow = piRaw as { invoice_number: string | null; currency: string | null; exchange_rate: string | number | null } | null;
          if (piRow && isRateRetainedFromPv({
            pvCurrency: head.currency,
            pvExchangeRate: head.exchange_rate,
            piCurrency: piRow.currency,
            piExchangeRate: piRow.exchange_rate,
          })) {
            const piLabel = piRow.invoice_number ?? a.pi_id;
            fxRateRetained.push(`${piLabel}: rate ${roundRate6(piRow.exchange_rate)} kept`);
            await recordEntityAudit(sb, {
              entityType: 'PURCHASE_INVOICE',
              entityId: a.pi_id,
              entityDocNo: piRow.invoice_number ?? null,
              action: 'UPDATE',
              actor: c.get('houzsUser'),
              companyId: head.company_id ?? null,
              note: `Payment voucher ${head.pv_number} cancelled — the exchange rate it established is RETAINED and inventory is not re-costed back`,
              fieldChanges: compactChanges([
                fieldChange('exchangeRateRetained', null, roundRate6(piRow.exchange_rate)),
                fieldChange('fxRateRetainedFromPv', null, head.pv_number),
              ]),
            });
          }
        } catch (e) {
          /* eslint-disable-next-line no-console */
          console.error('[pv-fx-rate] retention notice skipped — cancel continues:', head.pv_number, 'pi', a.pi_id, e);
        }
      }

      const reversed = await unsettlePvAllocation(sb, a.id);
      if (!reversed.ok) {
        /* eslint-disable-next-line no-console */
        console.error('[pv-settle] reversal failed — invoice still carries this payment:', head.pv_number, a.pi_id ?? a.ap_invoice_id, 'applied', applied, reversed.reason);
        settleErrors.push(`${a.pi_id ? 'Purchase invoice' : 'AP invoice'} ${a.pi_id ?? a.ap_invoice_id} still shows ${fmtSen(applied)} paid by this voucher: ${reversed.reason ?? 'unknown error'}. Press Cancel again to finish.`);
      } else if (reversed.reversedSen < reversed.recordedSen) {
        /* eslint-disable-next-line no-console */
        console.error('[pv-settle] reversal exceeded what the invoice was carrying:',
          head.pv_number, a.pi_id ?? a.ap_invoice_id, 'recorded', reversed.recordedSen, 'reversed', reversed.reversedSen);
      }
    }
  }

  return {
    ...(fxRateRetained.length > 0 ? { fxRateRetained } : {}),
    ...(settleErrors.length > 0 ? { settleErrors } : {}),
  };
}
