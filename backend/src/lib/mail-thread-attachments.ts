export const THREAD_ATTACHMENT_PREVIEW_LIMIT = 3;

export interface ThreadAttachmentPreview {
  id: string;
  filename: string;
  contentType: string;
}

export interface ThreadAttachmentSummary {
  hasAttachment: boolean;
  attachmentCount: number;
  attachments: ThreadAttachmentPreview[];
}

interface RankedAttachmentRow {
  thread_id: string;
  id: string;
  filename: string | null;
  content_type: string | null;
  attachment_count: number | string;
}

const NO_ATTACHMENTS: ThreadAttachmentSummary = { hasAttachment: false, attachmentCount: 0, attachments: [] };

async function loadThreadAttachmentSummaries(
  db: D1Database,
  threadIds: string[],
  messageCompanySql: string,
): Promise<Map<string, ThreadAttachmentSummary>> {
  const summaries = new Map<string, ThreadAttachmentSummary>();
  if (threadIds.length === 0) return summaries;
  const placeholders = threadIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT thread_id, id, filename, content_type, attachment_count FROM (
         SELECT m.thread_id, a.id, a.filename, a.content_type,
                ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY a.created_at, a.id) AS position,
                COUNT(*) OVER (PARTITION BY m.thread_id) AS attachment_count
           FROM email_attachments a JOIN email_messages m ON m.id = a.message_id
          WHERE m.thread_id IN (${placeholders})${messageCompanySql}
       ) ranked
       WHERE position <= ?
       ORDER BY thread_id, position`,
    )
    .bind(...threadIds, THREAD_ATTACHMENT_PREVIEW_LIMIT)
    .all<RankedAttachmentRow>();
  for (const row of result.results ?? []) {
    const summary = summaries.get(row.thread_id) ?? {
      hasAttachment: true,
      attachmentCount: Number(row.attachment_count),
      attachments: [],
    };
    summary.attachments.push({
      id: row.id,
      filename: row.filename ?? "file",
      contentType: row.content_type ?? "application/octet-stream",
    });
    summaries.set(row.thread_id, summary);
  }
  return summaries;
}

export async function withThreadAttachments<Thread extends { id: string }>(
  db: D1Database,
  threads: Thread[],
  messageCompanySql: string,
): Promise<Array<Thread & ThreadAttachmentSummary>> {
  const summaries = await loadThreadAttachmentSummaries(db, threads.map((thread) => thread.id), messageCompanySql);
  return threads.map((thread) => ({ ...thread, ...(summaries.get(thread.id) ?? NO_ATTACHMENTS) }));
}
