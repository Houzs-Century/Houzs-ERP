const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const HISTORY_MESSAGE_LIMIT = 2000;
export const HISTORY_RESULT_LIMIT = 500;

export interface RecipientHistoryRow {
  direction: string;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  used_at: string | null;
}

export interface KnownRecipient {
  email: string;
  name: string;
  timesUsed: number;
  lastUsedAt: string;
}

function parseAddressList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function addressesOf(row: RecipientHistoryRow): Array<{ email: string; name: string }> {
  if (row.direction === "inbound") {
    return [{ email: row.from_address ?? "", name: row.from_name ?? "" }];
  }
  return [...parseAddressList(row.to_addresses), ...parseAddressList(row.cc_addresses)].map(
    (email) => ({ email, name: "" }),
  );
}

export function rankRecipientHistory(rows: RecipientHistoryRow[]): KnownRecipient[] {
  const byEmail = new Map<string, KnownRecipient>();
  for (const row of rows) {
    const usedAt = row.used_at ?? "";
    for (const { email, name } of addressesOf(row)) {
      const key = email.trim().toLowerCase();
      if (!EMAIL_SHAPE.test(key)) continue;
      const known = byEmail.get(key) ?? { email: key, name: "", timesUsed: 0, lastUsedAt: "" };
      known.timesUsed += 1;
      if (usedAt >= known.lastUsedAt) {
        known.lastUsedAt = usedAt;
        if (name.trim()) known.name = name.trim();
      } else if (!known.name && name.trim()) {
        known.name = name.trim();
      }
      byEmail.set(key, known);
    }
  }
  return [...byEmail.values()]
    .sort((a, b) => b.timesUsed - a.timesUsed || b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, HISTORY_RESULT_LIMIT);
}

export async function loadRecipientHistory(
  db: D1Database,
  mailboxAddresses: string[],
  companyId: number,
): Promise<RecipientHistoryRow[]> {
  if (mailboxAddresses.length === 0) return [];
  const placeholders = mailboxAddresses.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT m.direction, m.from_address, m.from_name, m.to_addresses, m.cc_addresses,
              COALESCE(m.sent_at, m.received_at, m.created_at) AS used_at
         FROM email_messages m
         JOIN email_threads t ON t.id = m.thread_id
        WHERE m.company_id = ? AND t.company_id = ?
          AND LOWER(t.mailbox_address) IN (${placeholders})
        ORDER BY m.created_at DESC
        LIMIT ?`,
    )
    .bind(companyId, companyId, ...mailboxAddresses.map((a) => a.toLowerCase()), HISTORY_MESSAGE_LIMIT)
    .all<RecipientHistoryRow>();
  return result.results;
}
