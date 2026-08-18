// CSV utilities — Google Sheets / Excel compatible.
// - UTF-8 with BOM
// - CRLF line endings
// - Field quoting per RFC 4180

/* Re-exported at the CSV boundary so a caller has one import for "how a cell
   leaves". The rule itself lives beside fmtDate — export is the INVERSE of
   display, and both belong next to each other. */
export { isoForExport } from "@2990s/shared";

export interface CSVColumn<T> {
  key: string;
  label: string;
  getValue: (row: T) => string | number | boolean | null | undefined;
}

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Normalise newlines
  s = s.replace(/\r\n/g, "\n");
  if (/[",\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCSV<T>(rows: T[], columns: CSVColumn<T>[]): string {
  const header = columns.map((c) => escapeField(c.label)).join(",");
  const body = rows
    .map((r) => columns.map((c) => escapeField(c.getValue(r))).join(","))
    .join("\r\n");
  return `${header}\r\n${body}`;
}

export function downloadCSV(filename: string, content: string) {
  // BOM so Excel/Sheets detect UTF-8
  const blob = new Blob(["\ufeff" + content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Parses RFC4180-style CSV. Supports quoted fields, doubled quotes, CRLF/LF.
export function parseCSV(text: string): string[][] {
  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // handle CRLF
      if (text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // Flush trailing field/row (if any non-empty content)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing empty rows (e.g. from trailing newline)
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
    else break;
  }

  return rows;
}

// Convenience: parse a CSV File into an array of objects keyed by header row.
export async function parseCSVFile(file: File): Promise<Array<Record<string, string>>> {
  const text = await file.text();
  const grid = parseCSV(text);
  if (grid.length === 0) return [];
  const headers = grid[0].map((h) => h.trim());
  return grid.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (cells[i] ?? "").trim();
    });
    return obj;
  });
}
