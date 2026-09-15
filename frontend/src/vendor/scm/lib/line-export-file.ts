/* The document-independent half of a list's line export in the browser: check
   the server's answer and write the sheet. Each document keeps its own module
   (grn-list-export.ts, pi-list-export.ts, si-list-export.ts) for the request it
   sends and the column contract it expects; the Purchase Order module
   (po-list-export.ts) predates this file and is left as it is.

   A read the server had to stop is REFUSED here, never written: a short file
   that looks complete is exactly the defect these exports replace
   (docs/bugs/0916). */

import { ExportTruncatedError } from './po-list-export';

export type LineExportCell = string | number | null;

export type LineExportBody = {
  columns: string[];
  rows: LineExportCell[][];
  lineCount: number;
  truncated: boolean;
};

/** Refuse a stopped read, and a server whose columns are not this page's
 *  contract (an older or newer deployment) — the header row IS what an import
 *  reads back. */
export function checkLineExportBody<B extends LineExportBody>(body: B, columns: readonly string[], what: string): B {
  if (body.truncated) throw new ExportTruncatedError(what);
  if (body.columns.join('|') !== columns.join('|')) {
    throw new Error('The server sent a different set of export columns than this page expects. Reload the page and export again.');
  }
  return body;
}

export async function writeLineExportXlsx(
  columns: readonly string[],
  numberFormats: Partial<Record<string, string>>,
  rows: LineExportCell[][],
  sheetName: string,
  fileName: string,
): Promise<void> {
  const XLSX = await import('../../../lib/xlsx-runtime');
  const ws = XLSX.utils.aoa_to_sheet([[...columns], ...rows]) as Record<string, unknown>;
  columns.forEach((col, c) => {
    const fmt = numberFormats[col];
    if (!fmt) return;
    for (let r = 1; r <= rows.length; r += 1) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as { t?: string; z?: string } | undefined;
      if (cell && cell.t === 'n') cell.z = fmt;
    }
  });
  ws['!cols'] = columns.map((col) => ({ wch: Math.min(42, Math.max(10, col.length + 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFileXLSX(wb, fileName);
}

/** Ask a per-id endpoint for many ids, `size` at a time and `concurrency`
 *  requests at once, merging each answer's map. The list enrichment endpoints
 *  cap ids per request, and each request runs one company-wide MRP. */
export async function fetchByIdChunks<V>(
  ids: string[],
  size: number,
  concurrency: number,
  fetchChunk: (chunk: string[]) => Promise<Record<string, V> | undefined>,
): Promise<Map<string, V>> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  const out = new Map<string, V>();
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++]!;
      for (const [k, v] of Object.entries((await fetchChunk(chunk)) ?? {})) out.set(k, v);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return out;
}
