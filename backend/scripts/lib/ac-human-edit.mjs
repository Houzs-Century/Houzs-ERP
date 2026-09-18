// ----------------------------------------------------------------------------
// ac-human-edit — "did a PERSON change this row, or did the system?"
//
// ONE HOME for the authorship question. Before this file existed, three
// different answers to it lived inside scripts/sync-ac-delta.mjs, and they
// disagreed with each other and with the one check that had actually been RUN
// against production:
//
//   1. `touched`            (lanes desc, pay)  — every audit row counted, no
//                                                actor test at all, plus
//                                                `version > 1`.
//   2. `touchedByAudit`     (lane do)          — every audit row counted, no
//                                                actor test at all.
//   3. the header lane      (lane hdr)         — `!actor_id` read as SYSTEM.
//
// Number 3 is the one that loses data, and this file exists because of it.
//
// THE SIGNAL, AND WHERE IT WAS MEASURED. scripts/check-so-open-for-new.mjs was
// corrected on 2026-09-08 after being run against production (run
// 34183368917): it reported 50 migrated sales orders "touched", and every one
// of them was the stock-allocation cron writing UPDATE_LINE / UPDATE_STATUS
// rows exactly the way a person does. The classification is the audit row's OWN
// attribution, and it is the only honest one available:
//
//     SYSTEM  :=  actor_name_snapshot ILIKE 'system%'
//     PERSON  :=  everything else
//
// THE DECISION IS NOT MADE IN THIS FILE ANY MORE. It lives in
// src/scm/shared/audit-author.ts, because the go-live change log runs in the
// WORKER and a Worker bundle cannot import out of backend/scripts, while a
// script CAN import a .ts (they run under `npx tsx`). One direction, one
// answer, three callers. What stays here is the INDEXING — the field aliasing,
// the per-(document, field) map and the refusal wording — none of which is a
// decision.
//
// THE SECOND ARM IS GONE, AND WHY [2026-09-08, docs/bugs/0703]. This file
// shipped with `actor_id = MIGRATION_ACTOR_ID => SYSTEM` alongside the name
// test. That arm was measured after it landed and it is wrong in the direction
// this whole file exists to prevent:
//
//   - It matches EVERY human sales-order edit. src/scm/middleware/auth.ts PINS
//     that exact uuid onto c.get('user').id for every authenticated SCM caller,
//     and all 21 recordSoAudit call sites in routes/mfg-sales-orders.ts pass
//     `actorId: user.id`. Proven by RUNNING the middleware - the assertion is
//     in src/scm/shared/audit-author.test.ts, not a reading of it.
//   - It matches ZERO migration rows. No script writes actor_id into either
//     audit table. The only two that INSERT - backfill-2990-delivered-dos.mjs:124
//     and repair-so-fee-line-integrity.mjs:317 - both omit the column, so those
//     rows carry NULL and are classified by their NAME like everything else.
//
// So the arm refused nothing it was meant to and skipped everything it was
// meant to catch. `migrationActorId` is therefore no longer a parameter: a
// parameter that decides nothing is worse than no parameter, because the next
// reader assumes it does something.
//
// WHY `actor_id IS NULL` ALONE IS NOT "SYSTEM", WHICH IS THE WHOLE BUG.
// A null actor is a normal shape for a PERSON's row in this schema:
//
//   · src/scm/routes/so-amendments.ts:262 writes `actorId: null` ON PURPOSE
//     ("so nothing implies the pinned system row acted") with the real caller's
//     NAME in actor_name_snapshot.
//   · src/scm/routes/so-handover.ts:191 writes
//     `actorId: user?.id ?? null, actorName: user?.user_metadata?.name ?? null`
//     — both null whenever that session's user object is thin.
//   · src/scm/lib/entity-audit.ts:178 resolves actor_id through
//     resolveCallerStaffId and leaves it NULL when the caller has no staff row.
//
// So "null means the machine did it" is false in this codebase, and reading it
// that way hands a person's edit to the next sync to overwrite.
//
// AN UNATTRIBUTED ROW THAT IS NOT NAMED "system" COUNTS AS A PERSON,
// DELIBERATELY. The permissive direction here is to hide it. Over-refusing
// costs the owner a field that stays stale, which he can see and ask about;
// under-refusing costs him an edit, silently, and nothing ever says so.
//
// `version` IS NOT AN AUTHORSHIP SIGNAL and appears nowhere in this file. It is
// an optimistic-locking token bumped by seven automated paths through
// src/scm/lib/so-generation.ts; check-so-version-provenance.mjs (PR #3042)
// measured 80 of 81 "conflicts" as the automated stock-allocation sweep and
// exactly ONE as a person.
// ----------------------------------------------------------------------------

import { classifyAuditAuthor } from "../../src/scm/shared/audit-author.ts";

/**
 * The uuid src/scm/middleware/auth.ts pins onto EVERY authenticated SCM caller,
 * and the one create-migrated-documents.mjs stamps as created_by.
 *
 * IT IS NOT AN AUTHORSHIP SIGNAL and nothing in this file tests against it - it
 * is exported only so a caller that needs the constant for a created_by or an
 * FK has one place to read it from. See the header for the measurement.
 */
export const MIGRATION_ACTOR_ID = "00000000-0000-4000-8000-000000000001";

const str = (v) => (v == null ? null : String(v).trim() || null);

/**
 * Is this audit row the SYSTEM's rather than a person's?
 *
 * ONE ARGUMENT, because there is one signal. The rule itself is
 * src/scm/shared/audit-author.ts - this is the adapter that maps this file's
 * camelCase row shape onto it, and nothing more.
 *
 * @param {{actorId?: unknown, actorName?: unknown}} row
 * @returns {boolean}
 */
export function isSystemAuditRow(row) {
  return classifyAuditAuthor({ actor_name_snapshot: str(row?.actorName) }) === "machine";
}

/** snake_case -> camelCase, the two spellings an audit row's `field` can carry. */
export const camelOf = (s) => String(s).replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

/**
 * Every spelling of an ERP column that could appear as an audit row's `field`.
 * Lower-cased, so comparison is case-insensitive without re-lowering per row.
 */
export function fieldAliases(erpColumn) {
  const c = String(erpColumn);
  return [c.toLowerCase(), camelOf(c).toLowerCase()];
}

/**
 * `field_changes` as an array of `{ field, from, to }`, whatever shape the
 * driver handed us. postgres.js returns jsonb parsed; a caller that selected
 * `field_changes::text` gets a string; a legacy row may hold neither.
 */
export function normaliseFieldChanges(fc) {
  let v = fc;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x && typeof x === "object").map((x) => ({
    field: x.field == null ? "" : String(x.field),
    from: x.from === undefined ? null : x.from,
    to: x.to === undefined ? null : x.to,
  }));
}

/**
 * WHO, in the sentence a refusal prints. Never "unknown" on its own — an
 * unattributed row is still a person here, and the reader needs to be told
 * that is what it is rather than shown a blank.
 */
export function whoOf(row) {
  const name = str(row?.actorName);
  const id = str(row?.actorId);
  if (name && id) return `${name} (${id})`;
  if (name) return name;
  if (id) return `staff ${id}`;
  return "an unattributed person (no actor recorded — counted as a person, never as the system)";
}

/**
 * Index the audit rows a PERSON wrote, per (document, field).
 *
 * @param {object}   args
 * @param {Array}    args.rows              `{ docNo, actorId, actorName, at, action, fieldChanges }`
 * @param {Array}    args.fields            `[{ key, erp }]` — the fields the caller may write
 * @returns {{
 *   byDocField: Map<string, {who:string, at:any, action:any, from:any, to:any, field:string}>,
 *   byDoc: Map<string, {who:string, at:any, action:any, fields:Set<string>}>,
 *   personRows: number, systemRows: number, rows: number
 * }}
 */
export function humanEditIndex({ rows, fields }) {
  if (!Array.isArray(rows)) throw new TypeError("humanEditIndex: rows must be an array");
  if (!Array.isArray(fields)) throw new TypeError("humanEditIndex: fields must be an array");

  /* alias -> field key. Built once. A field with no ERP column cannot be
     written, so it cannot be vetoed either — it is not in this map. */
  const byAlias = new Map();
  for (const f of fields) {
    if (!f || !f.erp) continue;
    for (const a of fieldAliases(f.erp)) byAlias.set(a, f.key);
  }

  const byDocField = new Map();
  const byDoc = new Map();
  let personRows = 0;
  let systemRows = 0;

  for (const r of rows) {
    if (isSystemAuditRow(r)) { systemRows++; continue; }
    personRows++;
    const who = whoOf(r);
    const doc = String(r.docNo);
    for (const ch of normaliseFieldChanges(r.fieldChanges)) {
      const key = byAlias.get(String(ch.field).toLowerCase());
      if (!key) continue;
      const dk = `${doc}|${key}`;
      // First writer wins so a repeated edit does not keep re-labelling the
      // refusal; the OLDEST person edit is the one that explains the divergence.
      if (!byDocField.has(dk)) {
        byDocField.set(dk, { who, at: r.at ?? null, action: r.action ?? null, from: ch.from, to: ch.to, field: key });
      }
      let d = byDoc.get(doc);
      if (!d) { d = { who, at: r.at ?? null, action: r.action ?? null, fields: new Set() }; byDoc.set(doc, d); }
      d.fields.add(key);
    }
  }

  return { byDocField, byDoc, personRows, systemRows, rows: rows.length };
}

/**
 * Index of documents a person touched, WITHOUT a field map — for the lanes
 * whose SQL already narrowed the rows to the fields they write (desc, pay, do,
 * recv, dedi). Same authorship rule, same `who`.
 *
 * @returns {{ byDoc: Map<string, {who:string, at:any, action:any, fields:string[]}>,
 *            personRows:number, systemRows:number }}
 */
export function humanTouchedDocs({ rows }) {
  if (!Array.isArray(rows)) throw new TypeError("humanTouchedDocs: rows must be an array");
  const byDoc = new Map();
  let personRows = 0;
  let systemRows = 0;
  for (const r of rows) {
    if (isSystemAuditRow(r)) { systemRows++; continue; }
    personRows++;
    const doc = String(r.docNo);
    if (byDoc.has(doc)) continue;
    byDoc.set(doc, {
      who: whoOf(r),
      at: r.at ?? null,
      action: r.action ?? null,
      fields: normaliseFieldChanges(r.fieldChanges).map((c) => c.field).filter(Boolean),
    });
  }
  return { byDoc, personRows, systemRows };
}

const show = (v) => (v === undefined ? "(absent)" : JSON.stringify(v ?? null));

/**
 * The refusal sentence. The owner's standing requirement for a conflict is
 * that it names the DOCUMENT, the LINE, BOTH VALUES and WHO — a count of
 * refusals tells nobody which order to go and look at.
 *
 * `line` is `string | null` and NOT optional: a header field genuinely has no
 * line, and saying so is different from forgetting to pass one.
 *
 * @param {{doc:string, line:string|null, field:string, erp:any, book:any,
 *          who:string, at?:any}} c
 */
export function formatHumanRefusal(c) {
  if (!c || typeof c !== "object") throw new TypeError("formatHumanRefusal: c is required");
  if (!("line" in c)) {
    throw new TypeError("formatHumanRefusal: `line` is required — pass null for a header field, never omit it");
  }
  const where = c.line == null ? "(header)" : `line ${c.line}`;
  const when = c.at ? ` on ${new Date(c.at).toISOString()}` : "";
  return `${c.doc}  ${where}  ${c.field}: ERP ${show(c.erp)} <- BOOK ${show(c.book)}`
       + `  REFUSED, ${c.who} edited it${when}`;
}
