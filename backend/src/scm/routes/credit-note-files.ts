// ----------------------------------------------------------------------------
// Credit note attachments — the note's paper lives with the note (owner
// 2026-10-01: supplier 给我 cn，我要做 ocr for cn — the scanned supplier credit
// note is attached to the Supplier Credit Note it became).
//
//   POST   /credit-notes/:id/files          {fileName, mime, dataBase64}
//   GET    /credit-notes/:id/files          the index rows
//   GET    /credit-notes/:id/files/:fileId  streams the bytes from R2
//   DELETE /credit-notes/:id/files/:fileId  while DRAFT — a POSTED note's
//          evidence stays; a CANCELLED note takes no more.
//
// Keys: credit-note-files/<company>/<note>/<uuid>.<ext> in the SLIPS R2 bucket;
// index scm.acc_credit_note_files (20261001T2355). Handlers come from the shared
// factory (lib/doc-files.ts) — only this spec is the credit note's.
// ----------------------------------------------------------------------------

import { scopeToCompany } from '../lib/companyScope';
import { makeDocFileHandlers, type DocFilesSpec } from '../lib/doc-files';

type Row = Record<string, any>;

export const CREDIT_NOTE_FILES: DocFilesSpec = {
  table: 'acc_credit_note_files',
  fkColumn: 'note_id',
  keyPrefix: 'credit-note-files',
  /* The keys that raise a note (routes/credit-notes.ts create) attach to it. */
  writePerms: ['scm.payment_voucher.create', 'scm.payment_voucher.write'],
  load: async (c: any) => {
    const sb = c.get('supabase');
    const { data, error } = await scopeToCompany(
      sb.from('acc_credit_notes').select('id, note_number, status, company_id').eq('id', c.req.param('id')), c,
    ).maybeSingle();
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    if (!data) return { resp: c.json({ error: 'not_found', message: 'That note is not in the company you are working in.' }, 404) };
    const note = data as Row;
    return { doc: { id: String(note.id), closed: note.status === 'CANCELLED', locked: note.status === 'POSTED' } };
  },
  closedRefusal: { error: 'note_cancelled', message: 'A cancelled note takes no more evidence.' },
  lockedRefusal: { error: 'evidence_locked', message: 'The note is posted — its evidence stays.' },
};

const handlers = makeDocFileHandlers(CREDIT_NOTE_FILES);
export const uploadCreditNoteFileHandler = handlers.upload;
export const listCreditNoteFilesHandler = handlers.list;
export const streamCreditNoteFileHandler = handlers.stream;
export const deleteCreditNoteFileHandler = handlers.remove;
