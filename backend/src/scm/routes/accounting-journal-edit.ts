// ----------------------------------------------------------------------------
// PUT /accounting/journal-entries/:id — a manual journal edited in one step.
//
// Owner, 2026-09-15, on a POSTED manual journal: 我无法 edit. A posted entry
// is immutable by design — the books never lose what was once posted — so
// until now a correction was three moves by hand: Copy, fix the draft, Post,
// then Reverse the old one. This route is those three moves as one, in the
// order that leaves the books whole at every step:
//
//   1. the corrected entry is VALIDATED (the same gate a new journal passes —
//      shape, balance, the chart, no control account) before anything is
//      written, so a bad edit reverses nothing;
//   2. the corrected entry is written as a DRAFT, so if the reversal below
//      fails the draft is deleted and the books are exactly as they were;
//   3. the old entry is REVERSED by a contra dated the OLD entry's own day (its
//      month nets to zero — the payment re-post's rule, acc/payment-repost.ts),
//      whose narration names the entry that replaces it;
//   4. the draft is POSTED. If this last step fails the old entry is already
//      reversed and the corrected one is a draft — the response says so by
//      number, and the draft's own Post button finishes the job.
//
// A DRAFT manual journal has booked nothing, so it is rewritten in place —
// same number, no contra: the header and the lines are replaced. A document's
// entry (SI, PV, SOPAY …) is never edited here: correct the document and its
// own flow re-posts. A reversed entry is history; copy it instead.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { dateOrNull } from '../lib/date-coerce';
import { postJournal, reverseJournal, validateJournal, type EngineLine } from '../../acc/engine';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

type LineIn = {
  accountCode?: unknown;
  debitSen?: unknown;
  creditSen?: unknown;
  partyType?: unknown;
  partyCode?: unknown;
  partyName?: unknown;
  notes?: unknown;
};

type Header = {
  id: string;
  je_no: string;
  entry_date: string;
  source_type: string;
  narration: string | null;
  posted: boolean | null;
  reversed: boolean | null;
};

const text = (v: unknown): string | null => (v == null ? null : String(v).trim() || null);

/** The body's lines as the engine reads them — every figure a whole number of
    sen (a string "1920698" from a client is a number here; "19,206.98" is not,
    and the engine's `bad_line` says so). */
const linesOf = (raw: unknown): EngineLine[] =>
  (Array.isArray(raw) ? (raw as LineIn[]) : []).map((l) => ({
    accountCode: String(l.accountCode ?? '').trim(),
    debitSen: Number(l.debitSen ?? 0),
    creditSen: Number(l.creditSen ?? 0),
    partyType: text(l.partyType),
    partyCode: text(l.partyCode),
    partyName: text(l.partyName),
    notes: text(l.notes),
  }));

/* The same key the create, post and reverse routes ask for (accounting.ts:
   requireGlPost) — an edit is a post and a reversal in one. */
const GL_POST = 'scm.payment_voucher.post';

export const journalEntryEdit = async (c: Ctx) => {
  if (!hasHouzsPerm(c, GL_POST)) return c.json({ error: "You don't have permission to post to the general ledger." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = c.req.param('id');
  const sb = c.get('supabase');

  let body: { entryDate?: unknown; narration?: unknown; lines?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const { data: found, error: loadErr } = await scopeToCompanyId(
    sb.from('journal_entries').select('id, je_no, entry_date, source_type, narration, posted, reversed').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (loadErr) return c.json({ error: 'load_failed', reason: loadErr.message }, 500);
  if (!found) return c.json(NOT_THIS_COMPANY, 404);
  const je = found as Header;
  if (je.source_type !== 'MANUAL') {
    return c.json({ error: 'not_manual', message: 'Only a manual journal is edited here — correct the source document and its entry follows.' }, 409);
  }
  if (je.reversed === true) {
    return c.json({ error: 'already_reversed', message: `${je.je_no} was reversed — it is history now. Copy it into a new journal instead.` }, 409);
  }

  /* The corrected entry, as the engine will see it. A blank date keeps the
     entry's own day — an edit of the figures is not a move to today. */
  const entryDate = dateOrNull(body.entryDate) ?? String(je.entry_date).slice(0, 10);
  const narration = body.narration === undefined ? je.narration : text(body.narration);
  const lines = linesOf(body.lines);
  const draft = { companyId: co.companyId, entryDate, sourceType: 'MANUAL', sourceDocNo: null, narration, lines };

  /* 1 — validated before a single write: a bad edit reverses nothing. */
  const v = await validateJournal(sb, draft);
  if (!v.ok) {
    const client = v.status === 'min_2_lines' || v.status === 'bad_line' || v.status === 'unbalanced'
      || v.status === 'zero_total' || v.status === 'account_invalid' || v.status === 'control_account_manual';
    return c.json({ error: v.status, reason: v.reason }, client ? 400 : 500);
  }

  /* A draft has booked nothing: rewrite it in place, same number. */
  if (je.posted !== true) {
    const { data: oldLines, error: oldErr } = await sb.from('journal_entry_lines')
      .select('journal_entry_id, line_no, account_code, debit_sen, credit_sen, party_type, party_code, party_name, notes, company_id')
      .eq('journal_entry_id', je.id);
    if (oldErr) return c.json({ error: 'load_failed', reason: oldErr.message }, 500);
    const { error: headErr } = await scopeToCompanyId(
      sb.from('journal_entries').update({ entry_date: entryDate, narration, total_debit_sen: v.totalSen, total_credit_sen: v.totalSen }).eq('id', je.id),
      co.companyId,
    );
    if (headErr) return c.json({ error: 'update_failed', reason: headErr.message }, 500);
    const { error: delErr } = await sb.from('journal_entry_lines').delete().eq('journal_entry_id', je.id);
    if (delErr) return c.json({ error: 'update_failed', reason: delErr.message }, 500);
    const { error: insErr } = await sb.from('journal_entry_lines').insert(lines.map((l, i) => ({
      company_id: co.companyId,
      journal_entry_id: je.id,
      line_no: i + 1,
      account_code: l.accountCode,
      debit_sen: l.debitSen,
      credit_sen: l.creditSen,
      party_type: l.partyType ?? null,
      party_code: l.partyCode ?? null,
      party_name: l.partyName ?? null,
      notes: l.notes ?? null,
    })));
    if (insErr) {
      /* The old lines go back so the draft is never a header alone. */
      if (oldLines.length > 0) await sb.from('journal_entry_lines').insert(oldLines);
      return c.json({ error: 'update_failed', reason: insErr.message }, 500);
    }
    /* The draft IS rewritten at this point — a failed read-back degrades the
       response body, never the outcome (the create route's own rule). */
    const { data: after, error: afterErr } = await sb.from('journal_entries').select('*').eq('id', je.id).maybeSingle();
    const header = afterErr ? null : after;
    return c.json({ journalEntry: header ?? { id: je.id, je_no: je.je_no }, lineCount: lines.length, replaced: null });
  }

  /* 2 — the corrected entry as a draft: nothing in the books moves yet. */
  const made = await postJournal(sb, { ...draft, postNow: false });
  if (!made.ok) return c.json({ error: made.status, reason: made.reason }, 500);

  /* 3 — the old entry reversed on its own day, the contra naming its successor. */
  const undone = await reverseJournal(sb, {
    sourceType: 'MANUAL',
    jeId: je.id,
    companyId: co.companyId,
    entryDate: String(je.entry_date).slice(0, 10),
    narration: (orig) => `Reversal of ${orig.je_no} — edited, replaced by ${made.jeNo}`,
  });
  if (!undone.ok) {
    /* The books are untouched; the draft that would have replaced the entry
       is paperwork that never happened. */
    await sb.from('journal_entry_lines').delete().eq('journal_entry_id', made.jeId);
    await sb.from('journal_entries').delete().eq('id', made.jeId);
    return c.json({ error: 'reverse_failed', reason: `${undone.status}${undone.reason ? `: ${undone.reason}` : ''}` }, 500);
  }
  const contraJeNo = undone.status === 'reversed' ? undone.jeNo : null;

  /* 4 — the corrected entry posted. */
  const { data: posted, error: postErr } = await scopeToCompanyId(
    sb.from('journal_entries').update({ posted: true }).eq('id', made.jeId),
    co.companyId,
  ).select('*').maybeSingle();
  if (postErr) {
    return c.json({
      error: 'post_failed',
      reason: postErr.message,
      message: `${je.je_no} was reversed${contraJeNo ? ` by ${contraJeNo}` : ''}, but the corrected entry ${made.jeNo} could not be posted — it is saved as a draft; post it from the list.`,
      draftJeNo: made.jeNo,
      draftJeId: made.jeId,
    }, 500);
  }
  return c.json({
    journalEntry: posted ?? { id: made.jeId, je_no: made.jeNo },
    lineCount: lines.length,
    replaced: { originalJeNo: je.je_no, originalJeId: je.id, contraJeNo },
  });
};
