/* company-scope-file: these reads are DELIBERATE. migs 0202/0203/0204 state
   `company_id` on the fleet tables is "STAMPED on insert for provenance but NOT
   used to scope reads" - a lorry is one physical vehicle whichever book paid for
   it, and a company predicate here would HIDE it from the people responsible.
   Not a waiver, a signal separator: 13 of ~20 findings were these every run.
   If the fleet ever needs per-company reads, delete this header and let the
   checker fail. docs/MASTER-DATA-SCOPE-RULE.md. */
// ----------------------------------------------------------------------------
// /lorry-service-records — the per-lorry service / repair history (mig 0121).
//
// Owner 2026-07-17: "把我的维修记录等全部记录下来，这样我之后要查维修记录的时候也
// 比较方便". One row = one visit to a workshop: date, what was done, cost,
// workshop, odometer at the time, and the invoice.
//
// NOT scm.lorry_maintenance. That table (mig 0053) is an AVAILABILITY WINDOW
// (unavailable_from/unavailable_to) and the Lorry Capacity dashboard derives
// repair_days from it — overloading it with cost/odometer/invoice would put two
// unrelated facts in one row and change a live consumer's arithmetic. A lorry
// can be serviced without going off the road, and can be off the road without
// being serviced; they are separate records that happen to share a word.
//
// NOT backend/src/routes/fleet.ts either — that file's docblock says the old
// Fleet module's "lorry maintenance/incidents" was deleted at strip-to-core and
// says "do not re-add it here". This is the SCM module's own concern: lorries
// live in scm.lorries and the live /scm/fleet page reads them via /api/scm/*.
//
// Company scope: rows are STAMPED with the active company on insert and are NOT
// filtered by it on read, mirroring lorries.ts's "UNIFIED FLEET: one shared
// lorry fleet across ALL companies". A lorry visible to both companies must not
// have a service history that half-disappears depending on the top-bar switcher.
//
// Attachment plumbing follows product-models.ts's photo gallery — the newest
// and only row-backed SCM attachment pattern: multipart parseBody, a
// SERVER-MINTED R2 key under SO_ITEM_PHOTOS, and delete-the-object if the DB
// write fails. The invoice download is deliberately BEHIND supabaseAuth (unlike
// the product photo proxy, which is pre-auth so <img> tags work): an invoice is
// a financial document, not a thumbnail, and nothing needs to render it in a
// bare <img>.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId } from '../lib/companyScope';
import { extensionFromMime, type SlipMime } from '../lib/r2';

export const lorryServiceRecords = new Hono<{ Bindings: Env; Variables: Variables }>();
lorryServiceRecords.use('*', supabaseAuth);

const COLS = [
  'id', 'lorry_id', 'service_date', 'description', 'workshop', 'cost_sen',
  'odometer_km', 'invoice_key', 'invoice_name', 'invoice_mime', 'invoice_size',
  'next_service_date', 'next_service_km', 'notes', 'created_at', 'created_by',
].join(', ');

/* Invoices are usually PDFs — the product-model gallery's image-only set would
   reject the common case. Reuses the existing SlipMime vocabulary rather than
   declaring a second copy (this repo's BUG-HISTORY logs hand-copied lists as a
   recurring defect). */
const INVOICE_MIME = new Set<string>(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const INVOICE_MAX_BYTES = 10 * 1024 * 1024;
const KEY_PREFIX = 'lorry-service/';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateField(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? { ok: true, value: s } : { ok: false };
}

/* Non-negative integer or null. The table CHECKs cost_sen >= 0 and
   odometer_km >= 0 — validate here so a typo returns a named 400 rather than a
   raw constraint-violation 500. */
function intField(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

// ── list ─────────────────────────────────────────────────────────────────────
// GET /lorry-service-records?lorryId=<uuid> — newest first (idx_lorry_service_
// records_lorry_date). lorryId is REQUIRED: an unfiltered fleet-wide dump has no
// caller today, and the index is on (lorry_id, service_date) so it would be a
// seq scan the moment the history grows.
lorryServiceRecords.get('/', async (c) => {
  const lorryId = c.req.query('lorryId');
  if (!lorryId) return c.json({ error: 'lorry_id_required' }, 400);
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('lorry_service_records')
    .select(COLS)
    .eq('lorry_id', lorryId)
    .order('service_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ records: data ?? [] });
});

// ── create ───────────────────────────────────────────────────────────────────
lorryServiceRecords.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const lorryId = String(body.lorryId ?? '').trim();
  if (!lorryId) return c.json({ error: 'lorry_id_required' }, 400);
  const description = String(body.description ?? '').trim();
  if (!description) return c.json({ error: 'description_required' }, 400);

  const serviceDate = dateField(body.serviceDate);
  if (!serviceDate.ok || serviceDate.value === null) {
    return c.json({ error: 'invalid_date', reason: 'serviceDate is required and must be YYYY-MM-DD' }, 400);
  }
  const nextDate = dateField(body.nextServiceDate);
  if (!nextDate.ok) return c.json({ error: 'invalid_date', reason: 'nextServiceDate must be YYYY-MM-DD' }, 400);

  const cost = intField(body.costSen);
  if (!cost.ok) return c.json({ error: 'invalid_amount', reason: 'costSen must be a non-negative integer (cents)' }, 400);
  const odo = intField(body.odometerKm);
  if (!odo.ok) return c.json({ error: 'invalid_odometer', reason: 'odometerKm must be a non-negative whole number' }, 400);
  const nextKm = intField(body.nextServiceKm);
  if (!nextKm.ok) return c.json({ error: 'invalid_odometer', reason: 'nextServiceKm must be a non-negative whole number' }, 400);

  const sb = c.get('supabase');
  const { data, error } = await sb.from('lorry_service_records').insert({
    company_id: activeCompanyId(c),
    lorry_id: lorryId,
    service_date: serviceDate.value,
    description,
    workshop: (body.workshop as string)?.trim() || null,
    cost_sen: cost.value ?? 0,
    odometer_km: odo.value,
    next_service_date: nextDate.value,
    next_service_km: nextKm.value,
    notes: (body.notes as string)?.trim() || null,
    // The real person, not the pinned scm.staff system uuid — see the column
    // comment in mig 0121.
    created_by: c.get('houzsUser')?.id ?? null,
    // invoice_* is server-owned: it arrives via PUT /:id/invoice.
  }).select(COLS).single();
  if (error) {
    if (error.code === '23503') return c.json({ error: 'lorry_not_found' }, 404);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ record: data }, 201);
});

// ── update ───────────────────────────────────────────────────────────────────
lorryServiceRecords.patch('/:id', async (c) => {
  // company-scope: UNIFIED FLEET — deliberate, not an oversight. lorries.ts:132
  // and drivers.ts:24-26,48 declare one shared fleet/roster across ALL companies
  // ("every company's TMS page shows the same lorries/drivers"), and driver_code
  // carries a bare UNIQUE so per-company minting would collide across tenants.
  // scm.lorry_service_records' own DDL (mig 0121) spells out the consequence:
  // company_id is stamped on insert but "NOT used to scope reads", because a
  // lorry's history must be visible wherever the lorry is. Verified 2026-08-13
  // against the DDL and both route declarations before deciding NOT to change
  // this handler.
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const updates: Record<string, unknown> = {};

  if (body.description !== undefined) {
    const d = String(body.description).trim();
    if (!d) return c.json({ error: 'description_required' }, 400);
    updates.description = d;
  }
  if (body.serviceDate !== undefined) {
    const d = dateField(body.serviceDate);
    if (!d.ok || d.value === null) return c.json({ error: 'invalid_date', reason: 'serviceDate must be YYYY-MM-DD' }, 400);
    updates.service_date = d.value;
  }
  if (body.nextServiceDate !== undefined) {
    const d = dateField(body.nextServiceDate);
    if (!d.ok) return c.json({ error: 'invalid_date', reason: 'nextServiceDate must be YYYY-MM-DD' }, 400);
    updates.next_service_date = d.value;
  }
  if (body.costSen !== undefined) {
    const v = intField(body.costSen);
    if (!v.ok) return c.json({ error: 'invalid_amount', reason: 'costSen must be a non-negative integer (cents)' }, 400);
    updates.cost_sen = v.value ?? 0;
  }
  if (body.odometerKm !== undefined) {
    const v = intField(body.odometerKm);
    if (!v.ok) return c.json({ error: 'invalid_odometer', reason: 'odometerKm must be a non-negative whole number' }, 400);
    updates.odometer_km = v.value;
  }
  if (body.nextServiceKm !== undefined) {
    const v = intField(body.nextServiceKm);
    if (!v.ok) return c.json({ error: 'invalid_odometer', reason: 'nextServiceKm must be a non-negative whole number' }, 400);
    updates.next_service_km = v.value;
  }
  if (body.workshop !== undefined) updates.workshop = (body.workshop as string)?.trim() || null;
  if (body.notes !== undefined) updates.notes = (body.notes as string)?.trim() || null;
  // lorry_id is NOT re-assignable and invoice_* is server-owned — moving a
  // record to another lorry would rewrite two lorries' histories at once, and a
  // client-settable invoice_key would let a caller point the row at any object
  // in the shared bucket.

  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);

  const sb = c.get('supabase');
  const { data, error } = await sb.from('lorry_service_records').update(updates).eq('id', id).select(COLS).maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'record_not_found' }, 404);
  return c.json({ record: data });
});

// ── delete ───────────────────────────────────────────────────────────────────
// Removes the R2 object too — an orphaned invoice in a shared bucket is a leak
// nobody would ever go looking for.
lorryServiceRecords.delete('/:id', async (c) => {
  // company-scope: UNIFIED FLEET — deliberate, not an oversight. lorries.ts:132
  // and drivers.ts:24-26,48 declare one shared fleet/roster across ALL companies
  // ("every company's TMS page shows the same lorries/drivers"), and driver_code
  // carries a bare UNIQUE so per-company minting would collide across tenants.
  // scm.lorry_service_records' own DDL (mig 0121) spells out the consequence:
  // company_id is stamped on insert but "NOT used to scope reads", because a
  // lorry's history must be visible wherever the lorry is. Verified 2026-08-13
  // against the DDL and both route declarations before deciding NOT to change
  // this handler.
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { data: row } = await sb.from('lorry_service_records').select('id, invoice_key').eq('id', id).maybeSingle();
  if (!row) return c.json({ error: 'record_not_found' }, 404);
  const { error } = await sb.from('lorry_service_records').delete().eq('id', id);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  const key = (row as { invoice_key: string | null }).invoice_key;
  // Best-effort, and AFTER the row is gone: a failed object delete must not
  // resurrect a record the operator was told is deleted.
  if (key && c.env.SO_ITEM_PHOTOS) await c.env.SO_ITEM_PHOTOS.delete(key).catch(() => {});
  return c.json({ ok: true });
});

// ── invoice upload ───────────────────────────────────────────────────────────
lorryServiceRecords.put('/:id/invoice', async (c) => {
  // company-scope: UNIFIED FLEET — deliberate, not an oversight. lorries.ts:132
  // and drivers.ts:24-26,48 declare one shared fleet/roster across ALL companies
  // ("every company's TMS page shows the same lorries/drivers"), and driver_code
  // carries a bare UNIQUE so per-company minting would collide across tenants.
  // scm.lorry_service_records' own DDL (mig 0121) spells out the consequence:
  // company_id is stamped on insert but "NOT used to scope reads", because a
  // lorry's history must be visible wherever the lorry is. Verified 2026-08-13
  // against the DDL and both route declarations before deciding NOT to change
  // this handler.
  const id = c.req.param('id');
  if (!c.env.SO_ITEM_PHOTOS) return c.json({ error: 'photo_bucket_not_configured' }, 500);

  const sb = c.get('supabase');
  const { data: row } = await sb.from('lorry_service_records').select('id, invoice_key').eq('id', id).maybeSingle();
  if (!row) return c.json({ error: 'record_not_found' }, 404);

  let file: File | undefined;
  try {
    const body = await c.req.parseBody();
    file = body.file as File | undefined;
  } catch { return c.json({ error: 'invalid_upload' }, 400); }
  if (!file || typeof file.arrayBuffer !== 'function') return c.json({ error: 'file_required' }, 400);
  if (!INVOICE_MIME.has(file.type)) {
    return c.json({ error: 'unsupported_type', reason: 'Attach a PDF, JPG, PNG or WebP invoice.' }, 400);
  }
  if (file.size > INVOICE_MAX_BYTES) {
    return c.json({ error: 'too_large', reason: 'The invoice must be 10MB or smaller.' }, 413);
  }

  const ext = extensionFromMime(file.type as SlipMime);
  const r2Key = `${KEY_PREFIX}${id}/${crypto.randomUUID()}.${ext}`;
  await c.env.SO_ITEM_PHOTOS.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });

  const previousKey = (row as { invoice_key: string | null }).invoice_key;
  const { data, error } = await sb.from('lorry_service_records').update({
    invoice_key: r2Key,
    invoice_name: (file.name || 'invoice').slice(0, 200),
    invoice_mime: file.type,
    invoice_size: file.size,
  }).eq('id', id).select(COLS).maybeSingle();
  if (error || !data) {
    // Roll the object back so a failed DB write doesn't leak storage — the
    // idiom product-models.ts:1141 established.
    await c.env.SO_ITEM_PHOTOS.delete(r2Key).catch(() => {});
    return c.json({ error: 'update_failed', reason: error?.message ?? 'record_not_found' }, 500);
  }
  // Replacing an invoice: drop the old object only AFTER the row points at the
  // new one, so a crash leaves an orphan (recoverable) rather than a row
  // pointing at a deleted key (a broken download).
  if (previousKey && previousKey !== r2Key) await c.env.SO_ITEM_PHOTOS.delete(previousKey).catch(() => {});
  return c.json({ record: data });
});

// ── invoice download ─────────────────────────────────────────────────────────
// Authed (the whole router is). The key is read from the ROW, never from the
// request — all four R2 bindings share one physical bucket (wrangler.toml:
// 72-102), so accepting a caller-supplied key would be a read primitive over
// every other module's objects.
lorryServiceRecords.get('/:id/invoice', async (c) => {
  const id = c.req.param('id');
  if (!c.env.SO_ITEM_PHOTOS) return c.json({ error: 'photo_bucket_not_configured' }, 500);

  const sb = c.get('supabase');
  const { data: row } = await sb
    .from('lorry_service_records')
    .select('invoice_key, invoice_name, invoice_mime')
    .eq('id', id)
    .maybeSingle();
  const r = row as { invoice_key: string | null; invoice_name: string | null; invoice_mime: string | null } | null;
  if (!r?.invoice_key) return c.json({ error: 'invoice_not_found' }, 404);

  const obj = await c.env.SO_ITEM_PHOTOS.get(r.invoice_key);
  if (!obj) return c.json({ error: 'invoice_not_found_in_r2' }, 404);

  return new Response(obj.body, {
    headers: {
      'content-type': r.invoice_mime ?? obj.httpMetadata?.contentType ?? 'application/octet-stream',
      // inline so a PDF opens in the browser's viewer instead of forcing a save.
      'content-disposition': `inline; filename="${(r.invoice_name ?? 'invoice').replace(/"/g, '')}"`,
      // Private: an invoice must not land in a shared/CDN cache.
      'cache-control': 'private, max-age=300',
    },
  });
});

export default lorryServiceRecords;
