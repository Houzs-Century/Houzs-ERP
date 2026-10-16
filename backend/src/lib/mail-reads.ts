// Mail Center per-person read state (DEV-03 / PRD T-011 P2, R9 / A4).
//
// email_thread_reads holds one row per (thread, person). Opening a shared
// mailbox's thread writes only the opener's row; colleagues keep their own
// state. A person with no row yet sees the old shared email_threads.unread
// flag, so the cutover changes nothing until each person opens a thread.
//
// company-scope: every query here is keyed on a thread id the caller already
// resolved inside its company (getMailScope + activeCompanySql), or on the
// caller's own user id.

/** Unread for the person bound as `r.user_id` in the LEFT JOIN below. */
export const MY_UNREAD_SQL = `CASE
    WHEN r.user_id IS NULL THEN t.unread
    WHEN r.read_at IS NULL THEN 1
    WHEN t.last_inbound_at IS NOT NULL AND t.last_inbound_at > r.read_at THEN 1
    ELSE 0 END`;

/** Bind the person's user id first, before the WHERE binds. */
export const MY_READ_JOIN = "LEFT JOIN email_thread_reads r ON r.thread_id = t.id AND r.user_id = ?";

/** read_at null = this person marked the thread unread. */
export async function setThreadRead(
  db: D1Database,
  threadId: string,
  userId: number,
  read: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_thread_reads (thread_id, user_id, read_at) VALUES (?, ?, ?)
       ON CONFLICT (thread_id, user_id) DO UPDATE SET read_at = excluded.read_at`,
    )
    .bind(threadId, userId, read ? new Date().toISOString() : null)
    .run();
}

/** This person's unread state for one thread. */
export async function isThreadUnreadFor(db: D1Database, threadId: string, userId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT ${MY_UNREAD_SQL} AS my_unread FROM email_threads t ${MY_READ_JOIN} WHERE t.id = ?`)
    .bind(userId, threadId)
    .first<{ my_unread: number | string | null }>();
  return Number(row?.my_unread ?? 0) === 1;
}

export type Reader = { userId: number; name: string; readAt: string | null };
export type ThreadReaders = { members: Reader[]; others: Reader[] };

/** Who has read the newest inbound mail on this thread. `members` are the
 *  mailbox's owner and the people granted it (the "of 5"); `others` read it
 *  through a department or company view. A member's readAt is null until they
 *  have read the latest inbound message. */
export async function threadReaders(
  db: D1Database,
  thread: { id: string; mailbox_address: string | null; last_inbound_at?: string | null },
  companyId: number | null,
): Promise<ThreadReaders> {
  const co = companyId != null ? " AND a.company_id = ?" : "";
  const coBind = companyId != null ? [companyId] : [];
  const memberRows = await db
    .prepare(
      `SELECT u.id, u.name, u.email FROM users u
        WHERE u.status = 'active' AND u.id IN (
          SELECT a.assigned_user_id FROM email_addresses a
           WHERE lower(a.address) = lower(?) AND a.active = 1 AND a.assigned_user_id IS NOT NULL${co}
          UNION
          SELECT g.user_id FROM email_address_access g
            JOIN email_addresses a ON a.id = g.address_id
           WHERE lower(a.address) = lower(?) AND a.active = 1${co})`,
    )
    .bind(thread.mailbox_address ?? "", ...coBind, thread.mailbox_address ?? "", ...coBind)
    .all<{ id: number; name: string | null; email: string | null }>();
  const readRows = await db
    .prepare(
      `SELECT r.user_id, r.read_at, u.name, u.email FROM email_thread_reads r
         JOIN users u ON u.id = r.user_id
        WHERE r.thread_id = ? AND r.read_at IS NOT NULL`,
    )
    .bind(thread.id)
    .all<{ user_id: number; read_at: string; name: string | null; email: string | null }>();
  const latest = thread.last_inbound_at ?? "";
  const readAt = new Map<number, string>();
  const names = new Map<number, string>();
  for (const r of readRows.results) {
    names.set(Number(r.user_id), r.name || r.email || String(r.user_id));
    if (r.read_at >= latest) readAt.set(Number(r.user_id), r.read_at);
  }
  const memberIds = new Set<number>();
  const members: Reader[] = memberRows.results.map((m) => {
    memberIds.add(Number(m.id));
    return { userId: Number(m.id), name: m.name || m.email || String(m.id), readAt: readAt.get(Number(m.id)) ?? null };
  });
  const others: Reader[] = [...readAt]
    .filter(([id]) => !memberIds.has(id))
    .map(([id, at]) => ({ userId: id, name: names.get(id) ?? String(id), readAt: at }));
  return { members, others };
}
