// ----------------------------------------------------------------------------
// pms-checklist-source.ts — a payment request raised from a PMS checklist row
// (owner 2026-10-08: 我的bd 会upload rental invoice 在这里，可以让他连过来for
// request payment 吗 … 就在这里加request payment … 做). The row is an event's
// CONTRACT › Agreement / Quotation, the BD's own; its files become the request's
// bill and the request remembers the row (acc_payment_requests.checklist_item_id),
// so the row can show the request and its 欠正式单 state.
//
// The row is a public.project_checklist item: the scm supabase client cannot
// reach the public schema, so the read goes through `env.DB`, company-scoped by
// the caller's `activeCompanySql` fragment — the whole tenant boundary, as in
// lib/event-tags.ts.
// ----------------------------------------------------------------------------

import { activeCompanySql } from './companyScope';
import type { EventDb } from './event-tags';

/** The checklist sections a payment may be asked from — the BD's contract row. */
export const PAYABLE_SECTIONS: readonly string[] = ['CONTRACT'];
export const isPayableSection = (name: unknown): boolean =>
  PAYABLE_SECTIONS.includes(String(name ?? '').trim().toUpperCase());

export type ChecklistSource = { id: number; projectId: number; title: string; section: string | null; status: string | null };

/* Lower-case aliases, read both ways: the pg driver and the D1 mirror disagree
   on result-column casing (lib/event-tags.ts). */
const pick = (r: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (r[k] != null) return r[k];
  return null;
};

/** A row id as the API sends it: absent, null or blank is none; a positive
    integer is that row; anything else is refused. */
export function parseChecklistItemId(raw: unknown): number | null | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'number' && !(typeof raw === 'string' && /^\s*\d+\s*$/.test(raw))) return 'invalid';
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 'invalid';
}

/** The checklist row under the active company, with its section — null when
    the company has no such row. */
export async function loadChecklistItem(db: EventDb, companySql: string, id: number): Promise<ChecklistSource | null> {
  const res = await db
    .prepare(
      'SELECT c.id AS id, c.project_id AS projectid, c.title AS title, c.status AS status, s.name AS section '
      + 'FROM project_checklist c LEFT JOIN project_checklist_sections s ON s.id = c.section_id '
      + `WHERE c.id = ?${companySql}`,
    )
    .bind(id)
    .all<Record<string, unknown>>();
  const rows = (res.results ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  const projectId = Number(pick(r, 'projectid', 'projectId', 'project_id'));
  if (!Number.isInteger(projectId) || projectId <= 0) return null;
  const section = pick(r, 'section');
  const status = pick(r, 'status');
  return {
    id: Number(pick(r, 'id')),
    projectId,
    title: String(pick(r, 'title') ?? 'the row'),
    section: section == null ? null : String(section),
    status: status == null ? null : String(status),
  };
}

/** May a request come from this row, for this event? The row must be the
    active company's, in a payable section, not marked N/A, and of the event the
    request names (none named = the row's own). A failed read refuses too: a
    link nobody could check is not written. `c` is the route's context. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function checklistSourceCheck(c: any, itemId: number, projectId: number | null): Promise<{ ok: true; item: ChecklistSource } | { ok: false; resp: Response }> {
  let item: ChecklistSource | null;
  try {
    item = await loadChecklistItem(c.env.DB, activeCompanySql(c, 'c.company_id'), itemId);
  } catch (e) {
    return { ok: false, resp: c.json({ error: 'checklist_read_failed', message: 'The PMS row could not be read — try again.', reason: e instanceof Error ? e.message : String(e) }, 500) };
  }
  if (!item) {
    return { ok: false, resp: c.json({ error: 'checklist_item_not_found', message: 'That PMS row is not in the company you are working in.' }, 400) };
  }
  if (!isPayableSection(item.section)) {
    return { ok: false, resp: c.json({ error: 'checklist_item_not_payable', message: `A payment is asked from an event's ${PAYABLE_SECTIONS.join(' / ')} row — not from ${item.title}.` }, 400) };
  }
  if (item.status === 'na') {
    return { ok: false, resp: c.json({ error: 'checklist_item_na', message: `${item.title} is marked N/A on this event — mark it applicable first.` }, 409) };
  }
  if (projectId != null && projectId !== item.projectId) {
    return { ok: false, resp: c.json({ error: 'checklist_event_mismatch', message: `This bill comes from ${item.title} of another event — keep the row's own event.` }, 400) };
  }
  return { ok: true, item };
}
