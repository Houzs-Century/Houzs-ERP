// UTC "now" as 'YYYY-MM-DD HH:MM:SS', the shape SQLite's datetime('now') writes.
// Bind it as a value instead of writing datetime('now') into the SQL: on Postgres
// that function is rewritten to to_char(...), which is TEXT, and Postgres refuses
// to store text in a timestamptz column. A bound value takes the column's type.
export function utcNowText(now: Date = new Date()): string {
  return now.toISOString().slice(0, 19).replace("T", " ");
}
