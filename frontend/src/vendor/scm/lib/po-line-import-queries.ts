/* PO line import — the logic both surfaces share (owner ruling 2026-09-15).
 *
 * Read the exported file, ask the server what it would change (preview), send
 * the confirmed change set (apply). The screens only render what this returns:
 * the desktop list's dialog today, and the phone if it ever grows an import menu
 * (it has none as of 2026-09-15) — R93, one logic layer.
 *
 * The column mapping and the date parsing are po-line-import.ts, the
 * byte-identical twin of the server's copy, so the dialog and the server cannot
 * disagree about what a cell means. The SERVER re-parses every value anyway. */
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { authedFetch, humanApiError } from './authed-fetch';
import { invalidateModuleShared } from '../../../mobile/sharedInvalidate';
import {
  readPoLineImportSheet,
  type PoLineImportApplyBody,
  type PoLineImportApplyResult,
  type PoLineImportConflict,
  type PoLineImportPreview,
  type PoLineImportSheet,
} from './po-line-import';

export const PO_LINE_IMPORT_ACCEPT = '.xlsx,.xls,.csv';

/** Read the first sheet that has a Line ID header. Dates stay as Excel serials or text; the shared parser reads both. */
export async function readPoLineImportFile(file: Blob): Promise<PoLineImportSheet> {
  const XLSX = await import('../../../lib/xlsx-runtime');
  let wb: ReturnType<typeof XLSX.read>;
  try {
    wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true });
  } catch {
    return { ok: false, error: 'This file could not be read as a spreadsheet. Import the .xlsx file exported from the Purchase Order lines.' };
  }
  let first: PoLineImportSheet | null = null;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
    const sheet = readPoLineImportSheet(matrix);
    if (sheet.ok) return sheet;
    first ??= sheet;
  }
  return first ?? { ok: false, error: 'This file has no sheets.' };
}

export function applyBodyOf(preview: PoLineImportPreview): PoLineImportApplyBody {
  return {
    lineChanges: preview.lineChanges,
    poChanges: preview.poChanges.map(({ poId, docNo, field, old, new: next, lineValues }) => ({ poId, docNo, field, old, new: next, lineValues })),
  };
}

/* authedFetch rejects with the raw status + body; the conflict list rides the body. */
const errorOf = (e: unknown): { message: string; conflicts: PoLineImportConflict[] } => {
  const err = (e ?? {}) as { status?: number; body?: string; message?: string };
  let conflicts: PoLineImportConflict[] = [];
  if (typeof err.body === 'string') {
    try {
      const j = JSON.parse(err.body) as { conflicts?: PoLineImportConflict[]; message?: string };
      if (Array.isArray(j.conflicts)) conflicts = j.conflicts;
      if (typeof j.message === 'string' && j.message.length > 0 && typeof err.status === 'number' && conflicts.length > 0) {
        return { message: j.message, conflicts };
      }
    } catch { /* not JSON: fall through to the plain sentence */ }
  }
  const message = typeof err.status === 'number' && typeof err.body === 'string'
    ? humanApiError(err.status, err.body)
    : err.message ?? 'Something went wrong. Please try again.';
  return { message, conflicts };
};

export type PoLineImportState =
  | { step: 'pick'; error: string | null }
  | { step: 'reading'; fileName: string }
  | { step: 'preview'; fileName: string; ignoredHeaders: string[]; missingHeaders: string[]; preview: PoLineImportPreview; applying: boolean; error: string | null; conflicts: PoLineImportConflict[] }
  | { step: 'done'; fileName: string; result: PoLineImportApplyResult };

export function usePoLineImport() {
  const qc = useQueryClient();
  const [state, setState] = useState<PoLineImportState>({ step: 'pick', error: null });

  const reset = useCallback(() => setState({ step: 'pick', error: null }), []);

  const chooseFile = useCallback(async (file: File) => {
    setState({ step: 'reading', fileName: file.name });
    try {
      const sheet = await readPoLineImportFile(file);
      if (!sheet.ok) { setState({ step: 'pick', error: sheet.error }); return; }
      if (sheet.rows.length === 0) { setState({ step: 'pick', error: 'The file has a header row but no lines under it.' }); return; }
      const preview = await authedFetch<PoLineImportPreview>('/mfg-purchase-orders/line-import/preview', {
        method: 'POST',
        body: JSON.stringify({ rows: sheet.rows }),
      });
      setState({ step: 'preview', fileName: file.name, ignoredHeaders: sheet.ignoredHeaders, missingHeaders: sheet.missingHeaders, preview, applying: false, error: null, conflicts: [] });
    } catch (e) {
      setState({ step: 'pick', error: `${errorOf(e).message} Nothing was changed.` });
    }
  }, []);

  const confirm = useCallback(async () => {
    if (state.step !== 'preview' || state.applying) return;
    const current = state;
    setState({ ...current, applying: true, error: null, conflicts: [] });
    try {
      const result = await authedFetch<PoLineImportApplyResult>('/mfg-purchase-orders/line-import/apply', {
        method: 'POST',
        body: JSON.stringify(applyBodyOf(current.preview)),
      });
      /* The one list of PO cache roots both surfaces refresh after a PO write. */
      invalidateModuleShared(qc, 'mfg-purchase-orders');
      setState({ step: 'done', fileName: current.fileName, result });
    } catch (e) {
      const { message, conflicts } = errorOf(e);
      setState({ ...current, applying: false, error: `${message}${conflicts.length > 0 ? '' : ' Nothing was changed.'}`, conflicts });
    }
  }, [state, qc]);

  return { state, chooseFile, confirm, reset };
}
