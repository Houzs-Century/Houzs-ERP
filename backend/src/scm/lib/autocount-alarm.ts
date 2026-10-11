// ----------------------------------------------------------------------------
// autocount-alarm — the LOUD half of hard rule 4.
//
// The owner's rule, verbatim: "a save that succeeds in the ERP while its sync is
// silently lost MUST BE IMPOSSIBLE — a durable queue plus a LOUD alarm...
// making failure VISIBLE, not distrusting the link."
//
// 0277 built the durable queue. The alarm was a console.error inside a
// Cloudflare Workers cron — visible to whoever happens to be running
// `wrangler tail`, which on a Tuesday afternoon on the shop floor is nobody.
// A divergence that only exists in a log nobody reads is, operationally, a
// divergence nobody knows about.
//
// THIS INVENTS NOTHING. It uses the mechanism this app already runs for
// machine-generated operational notices: postPersonalNotice inserts a PRIVATE
// announcement (target_type USER_IDS) tagged with a `source`, which the
// notification BELL serves at /api/announcements/banner?scope=system on BOTH
// shells. That is the same path the slip-scan results, service-case
// assignments and fleet breakdowns already take. Source tag: 'ac_writeback'.
//
// WHO IT GOES TO. The person whose save it was (outbox.created_by), expanded UP
// their reporting chain by uplineUserIds — the same audience rule assrNotify
// and the fleet-breakdown notice use, so an alarm cannot die with one salesman
// who is on leave. When the row has no author (a cron- or agent-created
// document) it falls back to the administrators, because an alarm with no
// audience is the failure this module exists to prevent.
//
// NEVER THROWS. An alarm that fails must not break the drain that raises it;
// the drain's own job is to keep the queue moving.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import { postPersonalNotice } from '../../services/personalNotice';
import { uplineUserIds } from '../../services/orgScope';

type Sb = SupabaseClient<any, any, any>;

/** Tag on the announcements row. Keeps these out of the office composer list. */
export const AC_ALARM_SOURCE = 'ac_writeback';

/**
 * How long a row may sit 'waiting' for its parent's AutoCount number before it
 * is treated as STALLED and alarmed.
 *
 * A waiting row deliberately does not burn an attempt, because the parent's
 * create is usually one position ahead of it in the same sweep. That is right
 * for seconds and wrong for days: a parent whose create was skipped, refused,
 * or never enqueued at all leaves its child waiting forever, never failing,
 * counted by nothing. Six hours is comfortably past every legitimate wait
 * (the sweep runs every five minutes) and well inside one working day.
 */
export const STALL_ALARM_MS = 6 * 60 * 60 * 1000;

/** How many rows one sweep will alarm about. A flood is still an alarm. */
const ALARM_BATCH = 20;

interface AlarmRow {
  id: string;
  op: string;
  doc_type: string;
  doc_no: string;
  status: string;
  attempts: number | null;
  last_error: string | null;
  created_by: number | null;
  created_at: string | null;
  first_waiting_at: string | null;
}

/**
 * Active users who can act on a write-back failure when the row has no author.
 *
 * `roles.permissions` is a JSON text array (0000_baseline), so the match is on
 * the quoted token rather than a parse — the same shape hasPermission checks,
 * and a LIKE here cannot be fooled by a substring: '"*"' and '"scm.admin"'
 * are only ever whole elements.
 */
async function adminUserIds(env: Env): Promise<number[]> {
  try {
    const res = await env.DB.prepare(
      `SELECT u.id AS id
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.status = 'active'
          AND (r.permissions LIKE '%"*"%' OR r.permissions LIKE '%"scm.admin"%')
        LIMIT 20`,
    ).all<{ id: number }>();
    return (res.results ?? []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[ac-alarm] could not resolve an admin audience:', (e as Error).message);
    return [];
  }
}

async function audienceFor(env: Env, createdBy: number | null): Promise<number[]> {
  const author = Number(createdBy);
  if (Number.isFinite(author) && author > 0) {
    try {
      const up = await uplineUserIds(env, author);
      if (up.length) return up;
    } catch { /* fall through to the admins — never leave an alarm unaddressed */ }
    return [author];
  }
  return adminUserIds(env);
}

const AGE = (iso: string | null): string => {
  if (!iso) return 'an unknown time';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} minutes`;
  if (h < 48) return `${h} hours`;
  return `${Math.floor(h / 24)} days`;
};

/** The human-readable body. Says what is true, and what to do about it. */
function describe(row: AlarmRow, stalled: boolean): { title: string; body: string } {
  const doc = `${row.doc_type} ${row.doc_no}`;
  if (stalled) {
    return {
      title: `AutoCount sync STALLED: ${doc}`,
      body:
        `${doc} has been waiting ${AGE(row.first_waiting_at)} to be written to AutoCount, because the `
        + `document it converts from still has no AutoCount counterpart. It has NOT been sent and it `
        + `is NOT retrying — it is waiting. Until the parent document reaches AutoCount, ${doc} exists `
        + `in the ERP and does not exist in AutoCount. Ask IT to check the AutoCount write-back queue `
        + `(operation ${row.op}).`,
    };
  }
  return {
    title: `AutoCount sync FAILED: ${doc}`,
    body:
      `${doc} was saved in the ERP but could NOT be written to AutoCount after ${row.attempts ?? 0} `
      + `attempts, so it exists in the ERP and does not exist in AutoCount. AutoCount's own answer was: `
      + `${(row.last_error ?? 'no message recorded').slice(0, 400)}. Nothing further will be retried `
      + `automatically. Ask IT to check the AutoCount write-back queue (operation ${row.op}).`,
  };
}

export interface AlarmSummary {
  /** Rows an alarm was raised for on this pass. */
  raised: number;
  /** Rows that are failed or stalled and were ALREADY alarmed. */
  outstanding: number;
}

/**
 * Raise a human-visible alarm for every row that is undeliverable and has not
 * been alarmed yet, and count the ones already alarmed but still unresolved.
 *
 * TWO undeliverable shapes, and they are not the same thing:
 *
 *   failed  — the attempts are spent (or AutoCount refused). Terminal.
 *   stalled — pending, waiting on a parent that never arrived, older than
 *             STALL_ALARM_MS. NOT terminal: it stays pending and will send
 *             itself the moment its parent lands. Alarmed anyway, because until
 *             then the document is in the ERP and not in AutoCount, which is
 *             precisely the divergence the whole mechanism exists to prevent.
 *
 * alerted_at is the receipt. It is stamped whether or not the notice insert
 * succeeded, because postPersonalNotice swallows its own errors and a retry
 * loop on an unknowable outcome would badger the audience every five minutes.
 * The row itself stays in the queue either way, and the read-only health check
 * counts undelivered rows independently of whether anyone was told.
 */
export async function raiseOutboxAlarms(env: Env, sb: Sb): Promise<AlarmSummary> {
  const out: AlarmSummary = { raised: 0, outstanding: 0 };
  try {
    const stallCutoff = new Date(Date.now() - STALL_ALARM_MS).toISOString();
    const cols = 'id, op, doc_type, doc_no, status, attempts, last_error, created_by, created_at, first_waiting_at';

    const { data: failed } = await sb.from('autocount_outbox')
      .select(cols).eq('status', 'failed').is('alerted_at', null)
      .order('created_at', { ascending: true }).limit(ALARM_BATCH);
    const { data: stalled } = await sb.from('autocount_outbox')
      .select(cols).eq('status', 'pending').is('alerted_at', null)
      .lt('first_waiting_at', stallCutoff)
      .order('created_at', { ascending: true }).limit(ALARM_BATCH);

    const { count: alreadyFailed } = await sb.from('autocount_outbox')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed').not('alerted_at', 'is', null);
    out.outstanding = Number(alreadyFailed ?? 0);

    const rows: Array<{ row: AlarmRow; stalled: boolean }> = [
      ...((failed ?? []) as AlarmRow[]).map((row) => ({ row, stalled: false })),
      ...((stalled ?? []) as AlarmRow[]).map((row) => ({ row, stalled: true })),
    ];

    for (const { row, stalled: isStalled } of rows) {
      const audience = await audienceFor(env, row.created_by);
      const { title, body } = describe(row, isStalled);
      /* Logged as well as posted. The notice is what a human sees; the log line
         is what an engineer greps for afterwards, and it must survive the notice
         path failing. */
      // eslint-disable-next-line no-console
      console.error(`[ac-alarm] ${title} -> users ${audience.join(',') || '(NOBODY — no author and no admins resolved)'}`);
      if (audience.length) {
        await postPersonalNotice(env, {
          userIds: audience,
          category: 'WARNING',
          title,
          body,
          source: AC_ALARM_SOURCE,
          /* Longer than the 14-day default: an unsent document is not a piece
             of news that goes stale, it is a divergence that is still there. */
          expiresDays: 60,
        });
      }
      await sb.from('autocount_outbox')
        .update({ alerted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', row.id);
      out.raised += 1;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[ac-alarm] alarm pass failed:', e instanceof Error ? e.message : String(e));
  }
  return out;
}
