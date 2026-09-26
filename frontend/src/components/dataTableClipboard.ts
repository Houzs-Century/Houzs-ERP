import type { Column } from "./dataTableTypes";

/* Ctrl+C on a table (owner 2026-09-25): the rows as tab-separated text with a
   header line, which Excel and Google Sheets paste straight into cells. The
   values are the EXPORT values (money in ringgit, dates ISO), so a pasted
   column sums in Excel the way an exported one does. */
const clean = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v).replace(/[\t\r\n]+/g, " ").trim();
};

export function rowsToTsv<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  const cols = columns.filter((c) => c.exportValue || c.getValue);
  const lines = [cols.map((c) => clean(c.exportLabel || c.label || c.key)).join("\t")];
  for (const r of rows) {
    lines.push(cols.map((c) => clean(c.exportValue ? c.exportValue(r) : c.getValue?.(r))).join("\t"));
  }
  return lines.join("\n");
}
