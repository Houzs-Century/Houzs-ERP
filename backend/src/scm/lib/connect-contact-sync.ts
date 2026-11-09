// ---------------------------------------------------------------------------
// connect-contact-sync — push a customer's FULL order field set into their Houzs
// Connect contact, WITHOUT sending a WhatsApp.
//
// Two callers share buildContactSyncEvent (the per-group build):
//   - POST /api/scm/delivery-messages/sync (routes/delivery-messages.ts) — the
//     operator's "Sync to Connect" button, request-scoped to their companies.
//   - runScheduledConnectSync (this file) — the */30 cron that backfills every
//     existing contact and keeps new ones current, across all companies.
//
// Both fire CONNECT_SYNC_AUTOMATION (a name no enabled Connect automation
// matches), so Connect upserts the attributes and sends nothing; resetConversation
// is false so a sync never blanks button_status and unlocks the Delivery Lock.
// (owner 2026-11-02: the contact panel sat at ~13/65 because a send only ever
// pushed the fields its own template used.)
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { effectiveSoDelivery, type SoDeliveryDateRow } from '../shared';
import { normalizePhone } from '../shared/phone';
import { templateDate } from './delivery-message-kinds';
import {
  isConnectConfigured,
  buildDeliveryFollowUp,
  buildSyncHeadline,
  postConnectContact,
  parseConnectCompanyProfiles,
  chatCallbackUrl,
  CONNECT_COMPANY_PROFILE_KEY,
  CONNECT_SYNC_AUTOMATION,
  type ConnectOrder,
  type ConnectContact,
  type ConnectCompanyProfile,
} from '../../services/connect';
import { todayMyt } from './my-time';

/* The SCM PostgREST client is untyped at every call site in this tree (see
   venture-portal-outbox.ts); one named alias keeps the `any` in one place. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
type ScmClient = SupabaseClient<any, any, any>;

/** The SO-header columns a sync reads — the delivery bundle's own columns PLUS
 *  the headline columns buildSyncHeadline maps. One home, imported by the route
 *  so the two readers never drift. */
export const SYNC_SO_SELECT =
  'doc_no, ref, debtor_name, phone, branding, company_id, customer_delivery_date, amended_delivery_date, venue, agent, customer_state, house_type, disposal_request, delivery_message_status';

/** app_config key holding the scheduled sync's cursor (the last doc_no synced);
 *  '' / missing means start from the top. */
export const CONNECT_SYNC_CURSOR_KEY = 'connect.sync_cursor';

/** Orders synced per cron run. Kept small (near the SCM subrequest diet
 *  CLAUDE.md holds this repo to — one POST per phone group plus a few reads); the
 *  cursor walks the window over several runs and then wraps to keep it fresh. */
export const CONNECT_SYNC_BATCH = 40;

/** Only orders whose effective delivery date is within this many days (past or
 *  future) are synced — the customers likely to be in an active conversation. An
 *  old, long-delivered order's contact is not worth a Connect round trip. */
export const CONNECT_SYNC_WINDOW_DAYS = 120;

/** Build the Connect sync event (full delivery bundle + headline fields, the sync
 *  sentinel, no conversation reset) for ONE (phone, company) group. `first` — the
 *  group's first order — drives the single-value headline fields, as the
 *  single-order templates do. Pure: the caller supplies the already-read rows and
 *  the balance / total / profile / code it resolved. */
export function buildContactSyncEvent(args: {
  phone: string;
  groupRows: Array<Record<string, unknown>>;
  balanceByDoc: Map<string, number>;
  totalByDoc: Map<string, number>;
  companyProfile: ConnectCompanyProfile | null;
  companyCode: string | null;
  callbackUrl: string;
}): ConnectContact {
  const { phone, groupRows, balanceByDoc, totalByDoc, companyProfile, companyCode, callbackUrl } = args;
  const first = groupRows[0] as Record<string, unknown>;
  const orders: ConnectOrder[] = groupRows.map((r) => ({
    ref: String(r.doc_no ?? ''),
    orderRef: String(r.ref ?? ''),
    branding: String(r.branding ?? ''),
    deliveryDate: templateDate(effectiveSoDelivery(r as SoDeliveryDateRow)),
    balanceSen: balanceByDoc.get(String(r.doc_no)) ?? null,
    totalSen: totalByDoc.get(String(r.doc_no)) ?? null,
    companyCode,
  }));
  return buildDeliveryFollowUp(phone, String(first.debtor_name ?? ''), orders, companyProfile, {
    callbackUrl,
    automation: CONNECT_SYNC_AUTOMATION,
    extra: buildSyncHeadline(first, phone, templateDate(effectiveSoDelivery(first as SoDeliveryDateRow))),
    resetConversation: false,
  });
}

/** The cursor to store after a batch: the last doc_no when the batch came back
 *  FULL (more to walk next run), or '' to wrap to the top when it came back short
 *  (window exhausted — the next run re-reads from the start, refreshing). Pure, so
 *  the wrap/advance decision is pinned without a database. */
export function nextCursor(batchDocNos: string[], limit: number): string {
  if (batchDocNos.length >= limit && batchDocNos.length > 0) return batchDocNos[batchDocNos.length - 1];
  return '';
}

export type ConnectSyncSummary = {
  skipped?: string;
  scanned: number;
  synced: number;
  failed: number;
  cursorFrom: string;
  cursorTo: string;
};

async function writeCursor(sb: ScmClient, value: string): Promise<void> {
  // company-scope: app_config is a global key/value config table (PK on key),
  // not per-company data; the cursor is one global row.
  await sb
    .from('app_config')
    .upsert({ key: CONNECT_SYNC_CURSOR_KEY, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}

/**
 * The scheduled Connect contact sync. Walks the in-window orders by doc_no a
 * batch at a time (cursor in app_config), syncing each (phone, company) group;
 * when it reaches the end it wraps, so it both BACKFILLS every existing contact
 * over the first cycle and KEEPS them current afterwards. New contacts (a customer
 * who messaged in) are picked up on the next pass over their order.
 *
 * Ships dark: a no-op (skipped:'not_configured') until CONNECT_WEBHOOK_URL/KEY are
 * set — same gate as the board's Send. Best-effort per the cron contract: a failed
 * group is logged (source 'connect-sync-cron') and counted, never thrown.
 */
export async function runScheduledConnectSync(
  env: Env,
  opts: { limit?: number } = {},
): Promise<ConnectSyncSummary> {
  const zero = { scanned: 0, synced: 0, failed: 0, cursorFrom: '', cursorTo: '' };
  if (!isConnectConfigured(env)) return { skipped: 'not_configured', ...zero };
  const limit = opts.limit ?? CONNECT_SYNC_BATCH;
  const sb = getSupabaseService(env);

  // Cursor — the last doc_no synced; '' starts from the top.
  // company-scope: app_config is a global key/value config table, not per-company data.
  const { data: curRow, error: curErr } = await sb
    .from('app_config').select('value').eq('key', CONNECT_SYNC_CURSOR_KEY).maybeSingle();
  if (curErr) return { skipped: 'cursor_read_failed', ...zero };
  const cursor = String((curRow as { value?: string | null } | null)?.value ?? '').trim();

  // Every company id — the sync covers them all (Houzs + 2990 + ...). The explicit
  // list also keeps the order read company-scoped rather than an unbounded scan.
  const { data: coRows, error: coErr } = await sb.schema('public').from('companies').select('id, code');
  if (coErr) return { skipped: 'companies_read_failed', ...zero, cursorFrom: cursor };
  const companies = (coRows as { id: number; code: string | null }[] | null) ?? [];
  const companyIds = companies.map((co) => co.id);
  const codeByCompany = new Map<number, string>(
    companies.filter((co) => co.code).map((co) => [co.id, String(co.code).toUpperCase()]),
  );
  if (!companyIds.length) return { skipped: 'no_companies', ...zero, cursorFrom: cursor };

  // The next batch of in-window orders after the cursor, by doc_no.
  const floor = todayMyt(-CONNECT_SYNC_WINDOW_DAYS);
  const { data: rowsRaw, error: readErr } = await sb
    .from('mfg_sales_orders')
    .select(SYNC_SO_SELECT)
    .in('company_id', companyIds)
    .not('phone', 'is', null)
    .or(`customer_delivery_date.gte.${floor},amended_delivery_date.gte.${floor}`)
    .gt('doc_no', cursor)
    .order('doc_no', { ascending: true })
    .limit(limit);
  if (readErr) return { skipped: 'orders_read_failed', ...zero, cursorFrom: cursor };
  const rows = (rowsRaw ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) {
    // Window exhausted — wrap so the next run refreshes from the top.
    if (cursor) await writeCursor(sb, '');
    return { ...zero, cursorFrom: cursor, cursorTo: '' };
  }

  // Per-company profile (bank / signature / disposal), parsed once. A FAILED read
  // is not "no profile" (same fail-closed rule as the sender): skip this run and
  // retry next */30 rather than sync a company's contact without its bank block.
  // company-scope: app_config is a global key/value config table, not per-company data.
  const { data: profRow, error: profErr } = await sb
    .from('app_config').select('value').eq('key', CONNECT_COMPANY_PROFILE_KEY).maybeSingle();
  if (profErr) return { skipped: 'profile_read_failed', ...zero, cursorFrom: cursor };
  const profilesById = parseConnectCompanyProfiles((profRow as { value?: string | null } | null)?.value ?? null);

  // Live balance + gross total for the batch (the SO list's own view).
  const docNos = rows.map((r) => String(r.doc_no));
  const { data: balRaw, error: balErr } = await sb
    .from('mfg_sales_orders_with_payment_totals')
    .select('doc_no, balance_sen_live, local_total_sen')
    .in('doc_no', docNos);
  if (balErr) return { skipped: 'balance_read_failed', ...zero, cursorFrom: cursor };
  const balanceByDoc = new Map<string, number>();
  const totalByDoc = new Map<string, number>();
  for (const b of (balRaw ?? []) as { doc_no: string | null; balance_sen_live: number | null; local_total_sen: number | null }[]) {
    if (b.doc_no == null) continue;
    if (b.balance_sen_live != null) balanceByDoc.set(String(b.doc_no), Number(b.balance_sen_live));
    if (b.local_total_sen != null) totalByDoc.set(String(b.doc_no), Number(b.local_total_sen));
  }

  // Group by (phone, company) — one Connect upsert per group, like the sender.
  const groups = new Map<string, { phone: string; companyId: number | null; rows: Array<Record<string, unknown>> }>();
  for (const r of rows) {
    const phone = normalizePhone(r.phone == null ? null : String(r.phone));
    if (!phone) continue;
    const companyId = r.company_id == null ? null : Number(r.company_id);
    const key = `${phone}\u0000${companyId ?? ''}`;
    const g = groups.get(key) ?? { phone, companyId, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }

  const callbackUrl = chatCallbackUrl(env);
  let synced = 0;
  let failed = 0;
  for (const { phone, companyId, rows: groupRows } of groups.values()) {
    const contact = buildContactSyncEvent({
      phone,
      groupRows,
      balanceByDoc,
      totalByDoc,
      companyProfile: profilesById[String(companyId ?? '')] ?? null,
      companyCode: companyId != null ? codeByCompany.get(companyId) ?? null : null,
      callbackUrl,
    });
    const result = await postConnectContact(env, contact, { expectTrigger: false });
    // Logged like a send (per doc, shared batch_id) but source 'connect-sync-cron'.
    const batchId = crypto.randomUUID();
    const groupDocs = groupRows.map((r) => String(r.doc_no));
    try {
      await sb.from('wa_message_log').insert(groupDocs.map((docNo) => ({
        batch_id: batchId,
        company_id: companyId,
        doc_no: docNo,
        phone,
        payload: JSON.stringify(contact),
        http_code: result.httpCode,
        success: result.ok,
        error: result.error,
        source: 'connect-sync-cron',
        created_by: null,
      })));
    } catch (e) {
      console.warn(`[cron connect-sync] log insert failed: ${String((e as Error).message).slice(0, 120)}`);
    }
    if (result.ok) synced += 1;
    else failed += 1;
  }

  const to = nextCursor(docNos, limit);
  await writeCursor(sb, to);
  return { scanned: rows.length, synced, failed, cursorFrom: cursor, cursorTo: to };
}
