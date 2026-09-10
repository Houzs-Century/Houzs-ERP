// ---------------------------------------------------------------------------
// /change-log — WHO CHANGED WHICH DOCUMENT, AND WHAT, SINCE WE OPENED.
//
// THE OWNER'S ASK, 2026-09-08, in his words: 「做可以监督到这期间我们打开系统的数据
// 跟之前谁改了东西 谁改了 都根据他们改的数据为最高标准 跟着」— he is opening sales
// orders, delivery orders, purchase orders and goods receipts to his staff, and
// he wants to be able to WATCH what they change. Everything else in this repo
// reads an audit trail one document at a time (the History drawer,
// /entity-audit-log/:type/:id); nothing could answer "what has been changed
// across the company since Monday", which is the only question this one is for.
//
// ── THE TRAP, AND THE WHOLE REASON THIS ENDPOINT EXISTS ──
// The audit trail is NOT a staff signal. The stock-allocation recompute writes
// UPDATE_LINE and UPDATE_STATUS rows with exactly the shape a person's edit
// produces (scm/lib/so-stock-allocation.ts:998 and :1082) — a comment claiming
// otherwise was reasoning, not observation, and a check written on it reported
// "50 staff actions on migrated orders" when all fifty were the cron (#3177).
// So the split between a PERSON and a MACHINE is the product here, not a
// detail, and it is NOT decided in this file: shared/audit-author.ts is its one
// home, shared with scripts/check-so-open-for-new.mjs and
// scripts/sync-ac-delta.mjs.
//
// `version` is not consulted anywhere here either. It is an optimistic-locking
// token bumped by seven automated paths; #3042 measured 80 of 81 "conflicts" as
// the allocation sweep.
//
// ── TWO TABLES, ONE ANSWER ──
// Sales orders record into scm.mfg_so_audit_log (keyed so_doc_no); every other
// SCM document records into scm.entity_audit_log (keyed entity_type/entity_id,
// migration 0139). The column sets are deliberately identical — the migration
// header says so — which is what makes one merged reading honest rather than
// two half-answers stitched together.
//
// ── FOLDED BY DOCUMENT, NEWEST FIRST ──
// The raw rows are not the deliverable. One row per SEND is the mistake the
// AutoCount Sync page already made and corrected: 「为什么在 AutoCount 里面一张
// Sales Order 会出现两次呢?」 So the response is one entry per DOCUMENT carrying
// its changes, and the client renders the document and opens the detail.
//
// READ-ONLY. No POST, PATCH or DELETE — both tables are append-only by intent,
// and an audit trail anyone can write into records nothing.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToCompany } from '../lib/companyScope';
import { canViewScmFinance, hasHouzsPerm } from '../lib/houzs-perms';
import { stripAuditFinance } from '../lib/finance-keys';
import { classifyAuditAuthor, type AuditAuthor } from '../shared/audit-author';

export const changeLog = new Hono<{ Bindings: Env; Variables: Variables }>();
changeLog.use('*', supabaseAuth);

/* WHO MAY READ IT. This endpoint shows every change every colleague made to
   every document in the company, which is a supervision surface and not an
   operational one — so it is limited to the same two keys the AutoCount Sync
   page carries, checked against the REAL caller inside the handler. That is
   stricter than the coarse `scm.access` umbrella /api/scm/* already applies,
   and it has to be. */
const READ_KEYS = ['scm.changelog.read', 'settings.manage'] as const;

/* The four document kinds the owner opened, plus the entity_audit_log values
   that carry them. SO is absent because it lives in the other table entirely.
   A closed map, not a free string: the entity_type column has no check
   constraint, so an unknown key here would silently read nothing. */
const ENTITY_DOC_TYPES = {
  PO: 'PURCHASE_ORDER',
  DO: 'DELIVERY_ORDER',
  GRN: 'GRN',
} as const;

export type ChangeLogDocType = 'SO' | keyof typeof ENTITY_DOC_TYPES;

const ALL_DOC_TYPES: ChangeLogDocType[] = ['SO', 'PO', 'DO', 'GRN'];

/* A window, not a page. The question is "what happened since we opened", and a
   default of everything-ever would read the whole trail on the first paint. */
const DEFAULT_HOURS = 24 * 7;
const MAX_HOURS = 24 * 120;

/* Two ceilings, because they protect different things. ROW_CAP bounds what we
   pull out of Postgres; DOC_CAP bounds what we hand the browser. A truncated
   answer says so in the payload — a change log that quietly stops at 500 rows
   is the "check that answers a different question".

   ROW_CAP IS NOT THE TRUNCATION TEST, and never could be: PostgREST enforces its
   own `db-max-rows` under whatever `.limit()` asks for, so the real ceiling is
   the SERVER's and this number is only an upper bound on our appetite. The
   `truncated` flag is computed from Content-Range instead — see the payload. */
const ROW_CAP = 4000;
const DOC_CAP = 400;

type RawRow = {
  id: string;
  doc_no: string;
  doc_type: ChangeLogDocType;
  entity_id: string | null;
  action: string;
  actor_id: string | null;
  actor_name_snapshot: string | null;
  field_changes: unknown;
  status_snapshot: string | null;
  source: string | null;
  created_at: string;
};

export type ChangeLogChange = {
  id: string;
  at: string;
  author: AuditAuthor;
  who: string | null;
  action: string;
  source: string | null;
  status: string | null;
  fields: Array<{ field: string; from: unknown; to: unknown }>;
};

export type ChangeLogDocument = {
  docType: ChangeLogDocType;
  docNo: string;
  entityId: string | null;
  lastChangeAt: string;
  changeCount: number;
  /** Distinct people credited, newest first. Empty for a machine-only document. */
  people: string[];
  changes: ChangeLogChange[];
};

/** `author` decides which rows come back, so it is REQUIRED to have a value —
 *  the query string may omit it, but the parser always produces one. */
export type ChangeLogAuthorFilter = 'person' | 'machine' | 'all';

function parseAuthor(raw: string | undefined): ChangeLogAuthorFilter {
  return raw === 'machine' || raw === 'all' ? raw : 'person';
}

function parseDocTypes(raw: string | undefined): ChangeLogDocType[] {
  if (!raw || raw === 'all') return ALL_DOC_TYPES;
  const asked = raw.split(',').map((s) => s.trim().toUpperCase());
  const kept = ALL_DOC_TYPES.filter((t) => asked.includes(t));
  /* An unrecognised filter returns everything rather than nothing: an empty
     list would render as "nobody changed anything", which is the single most
     misleading answer this endpoint can give. */
  return kept.length > 0 ? kept : ALL_DOC_TYPES;
}

function parseHours(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HOURS;
  return Math.min(Math.floor(n), MAX_HOURS);
}

/** field_changes is jsonb and has held both shapes over the years. Anything
 *  that is not an array of objects renders as no fields rather than throwing —
 *  a history row with an unreadable diff is still evidence of WHO and WHEN. */
function readFields(raw: unknown): ChangeLogChange['fields'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({ field: String(f.field ?? ''), from: f.from ?? null, to: f.to ?? null }))
    .filter((f) => f.field !== '');
}

/**
 * GET /change-log
 *
 * Query: `hours` (default 168, max 2880), `author` (person | machine | all,
 * default person), `docType` (SO,PO,DO,GRN or all).
 */
export const changeLogHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  if (!READ_KEYS.some((k) => hasHouzsPerm(c, k))) {
    return c.json(
      {
        error: 'forbidden',
        message:
          'The change log shows what every colleague changed on every document, '
          + `so it is limited to ${READ_KEYS.join(' or ')}.`,
      },
      403,
    );
  }

  const hours = parseHours(c.req.query('hours'));
  const author = parseAuthor(c.req.query('author'));
  const docTypes = parseDocTypes(c.req.query('docType'));

  const until = new Date();
  const since = new Date(until.getTime() - hours * 3600_000);
  const sinceIso = since.toISOString();

  const sb = c.get('supabase');
  const rows: RawRow[] = [];
  /* Did EITHER read stop short of the window it was asked for? Accumulated per
     read, from the server's own exact total — see the `truncated` note below. */
  let readStoppedEarly = false;
  const stoppedEarly = (total: number | null | undefined, got: number): boolean =>
    (total ?? got) > got;

  if (docTypes.includes('SO')) {
    let q = sb.from('mfg_so_audit_log')
      .select(
        'id, so_doc_no, action, actor_id, actor_name_snapshot, field_changes, status_snapshot, source, created_at',
        { count: 'exact' },
      )
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(ROW_CAP);
    q = scopeToCompany(q, c);
    const { data, error, count } = await q;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    const soRows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    readStoppedEarly ||= stoppedEarly(count, soRows.length);
    for (const r of soRows) {
      rows.push({
        id: String(r.id),
        doc_no: String(r.so_doc_no ?? ''),
        doc_type: 'SO',
        entity_id: null,
        action: String(r.action ?? ''),
        actor_id: (r.actor_id as string | null) ?? null,
        actor_name_snapshot: (r.actor_name_snapshot as string | null) ?? null,
        field_changes: r.field_changes,
        status_snapshot: (r.status_snapshot as string | null) ?? null,
        source: (r.source as string | null) ?? null,
        created_at: String(r.created_at),
      });
    }
  }

  const entityTypes = docTypes
    .filter((t): t is keyof typeof ENTITY_DOC_TYPES => t !== 'SO')
    .map((t) => ENTITY_DOC_TYPES[t]);
  if (entityTypes.length > 0) {
    let q = sb.from('entity_audit_log')
      .select(
        'id, entity_type, entity_id, entity_doc_no, action, actor_id, actor_name_snapshot, field_changes, status_snapshot, source, created_at',
        { count: 'exact' },
      )
      .in('entity_type', entityTypes)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(ROW_CAP);
    q = scopeToCompany(q, c);
    const { data, error, count } = await q;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    const entityRows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    readStoppedEarly ||= stoppedEarly(count, entityRows.length);
    const backToKey = new Map<string, ChangeLogDocType>(
      Object.entries(ENTITY_DOC_TYPES).map(([k, v]) => [v as string, k as ChangeLogDocType]),
    );
    for (const r of entityRows) {
      const key = backToKey.get(String(r.entity_type));
      if (!key) continue;
      rows.push({
        id: String(r.id),
        /* entity_doc_no is nullable — a create can record before its number is
           minted. Falling back to the uuid keeps the row visible; dropping it
           would hide the creation of a document from a change log. */
        doc_no: String(r.entity_doc_no ?? r.entity_id ?? ''),
        doc_type: key,
        entity_id: (r.entity_id as string | null) ?? null,
        action: String(r.action ?? ''),
        actor_id: (r.actor_id as string | null) ?? null,
        actor_name_snapshot: (r.actor_name_snapshot as string | null) ?? null,
        field_changes: r.field_changes,
        status_snapshot: (r.status_snapshot as string | null) ?? null,
        source: (r.source as string | null) ?? null,
        created_at: String(r.created_at),
      });
    }
  }

  /* The finance strip runs on the SAME blob shape both other audit readers use
     — stripping the detail while leaving the history just moves the leak one
     endpoint over (lib/finance-keys). It mutates in place. */
  if (!canViewScmFinance(c)) {
    stripAuditFinance(rows as unknown as Array<Record<string, unknown>>);
  }

  /* Classify EVERY row before filtering, so the denominators are honest: the
     owner is told how many machine changes there were even when he is looking
     only at people. */
  let personRows = 0;
  let machineRows = 0;
  const classified = rows.map((r) => {
    const a = classifyAuditAuthor(r);
    if (a === 'person') personRows++; else machineRows++;
    return { row: r, authorClass: a };
  });

  const kept = author === 'all' ? classified : classified.filter((x) => x.authorClass === author);

  const byDoc = new Map<string, ChangeLogDocument>();
  for (const { row, authorClass } of kept) {
    if (!row.doc_no) continue;
    const key = `${row.doc_type}|${row.doc_no}`;
    let doc = byDoc.get(key);
    if (!doc) {
      doc = {
        docType: row.doc_type,
        docNo: row.doc_no,
        entityId: row.entity_id,
        lastChangeAt: row.created_at,
        changeCount: 0,
        people: [],
        changes: [],
      };
      byDoc.set(key, doc);
    }
    doc.changeCount++;
    if (row.created_at > doc.lastChangeAt) doc.lastChangeAt = row.created_at;
    if (authorClass === 'person' && row.actor_name_snapshot && !doc.people.includes(row.actor_name_snapshot)) {
      doc.people.push(row.actor_name_snapshot);
    }
    doc.changes.push({
      id: row.id,
      at: row.created_at,
      author: authorClass,
      who: row.actor_name_snapshot,
      action: row.action,
      source: row.source,
      status: row.status_snapshot,
      fields: readFields(row.field_changes),
    });
  }

  const documents = [...byDoc.values()].sort((a, b) => (a.lastChangeAt < b.lastChangeAt ? 1 : -1));
  const shown = documents.slice(0, DOC_CAP);
  for (const d of shown) d.changes.sort((a, b) => (a.at < b.at ? 1 : -1));

  const people = new Set<string>();
  for (const { row, authorClass } of classified) {
    if (authorClass === 'person' && row.actor_name_snapshot) people.add(row.actor_name_snapshot);
  }

  return c.json({
    window: { since: sinceIso, until: until.toISOString(), hours },
    filters: { author, docTypes },
    totals: {
      /* Both halves of the denominator, always — reporting only the filtered
         number is how "50 staff actions" got printed for 0 staff actions. */
      changesByPerson: personRows,
      changesBySystem: machineRows,
      documents: documents.length,
      documentsShown: shown.length,
      people: people.size,
      /* TRUE when a read came back with fewer rows than the window holds, so
         no total above is complete.

         MEASURED AGAINST THE SERVER'S OWN EXACT COUNT, per read — never against
         ROW_CAP. `rows.length >= ROW_CAP` was the previous test and it could
         not fire: PostgREST caps a response at `db-max-rows` whatever `.limit()`
         asks for, so each of the two reads returns at most that ceiling and
         `rows` is their SUM. With the ceiling this repo assumes (1000,
         `lib/paginate-all.ts` PAGE — still unmeasured, docs/bugs/0447) the sum
         tops out at 2,000 against a 4,000 threshold. It was also wrong in the
         other direction for any larger ceiling, because a two-read SUM was
         being compared with a ONE-read cap: 3,000 + 1,500 untruncated rows
         would have reported truncated. Content-Range answers the question
         directly and needs no ceiling to be known — the same device
         `so-handover.ts` /preview already uses. */
      truncated: readStoppedEarly,
    },
    documents: shown,
  });
};

/* The handler is EXPORTED and the route is a one-line registration, so
   changeLogRoute.test.ts can mount it behind a fake supabase client — the
   supabaseAuth bridge cannot run in that harness. Same shape as
   routes/autocount-outbox.ts. */
changeLog.get('/', changeLogHandler);

export default changeLog;
