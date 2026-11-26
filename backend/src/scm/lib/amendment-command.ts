
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import { getSupabaseService } from '../../db/supabase';
import {
  actionTargetStatus,
  statusSatisfies,
  type AmendAction,
  type AmendStatus,
} from '../shared';
import {
  readBridgeCommandConfig,
  patchAmendmentGate,
  fetchAmendmentStatus,
  BridgeCommandError,
  type BridgeCommandConfig,
} from './bridge-2990-command';

export const AMENDMENT_ENTITY = 'so_amendment';

const MAX_ATTEMPTS = 10;

const SENT_STALE_MS = 2 * 60 * 1000;

const DRAIN_BATCH = 25;

export interface SyncCommandRow {
  id: string;
  entity: string;
  entity_key: string;
  action: AmendAction;
  target_status: AmendStatus | null;
  payload: Record<string, unknown> | null;
  idempotency_key: string;
  status: string;
  requested_by: number | null;
  company_id: number | null;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

/** DB kill switch (D8). Fail-CLOSED: a missing table, a cold PostgREST cache, a
 *  missing row and any value other than 'true' all mean disabled. Mirrors
 *  maintenance-push's pushEnabled — same table, different key. */
export async function commandsEnabled(sb: SupabaseClient<any, any, any>): Promise<boolean> {
  const { data, error } = await sb
    .from('sync_config')
    .select('v')
    .eq('k', 'mirror_commands_enabled')
    .maybeSingle();
  if (error) return false;
  return (data as { v?: string } | null)?.v === 'true';
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function idempotencyKey(entityKey: string, action: AmendAction, target: AmendStatus): Promise<string> {
  return sha256Hex(`${AMENDMENT_ENTITY}|${entityKey}|${action}|${target}`);
}

export interface EnqueueInput {
  entityKey: string;
  action: AmendAction;
  payload: Record<string, unknown>;
  requestedBy: number | null;
  companyId: number | null;
}

export interface EnqueueResult {
  row: SyncCommandRow;
  created: boolean;
}

/**
 * Enqueue (or find the existing) command for a decision. Idempotent by the unique
 * index on idempotency_key: a duplicate insert returns the row already there, so
 * a double-click or a retried request never creates a second command.
 */
export async function enqueueAmendmentCommand(
  sb: SupabaseClient<any, any, any>,
  input: EnqueueInput,
): Promise<EnqueueResult> {
  const target = actionTargetStatus(input.action);
  const key = await idempotencyKey(input.entityKey, input.action, target);

  const { data: inserted, error } = await sb
    .from('sync_command')
    .insert({
      entity: AMENDMENT_ENTITY,
      entity_key: input.entityKey,
      action: input.action,
      target_status: target,
      payload: input.payload,
      idempotency_key: key,
      status: 'PENDING',
      requested_by: input.requestedBy,
      company_id: input.companyId,
    })
    .select('*')
    .single();

  if (!error && inserted) return { row: inserted as SyncCommandRow, created: true };

  const { data: existing } = await sb
    .from('sync_command')
    .select('*')
    .eq('idempotency_key', key)
    .maybeSingle();
  if (existing) return { row: existing as SyncCommandRow, created: false };

  throw new BridgeCommandError('command_enqueue_failed', 'Could not queue the change for 2990.', 500, error?.message);
}

function isTerminal(status: string): boolean {
  return status === 'DONE' || status === 'CONVERGED' || status === 'FAILED';
}

async function mark(
  sb: SupabaseClient<any, any, any>,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await sb.from('sync_command').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
}

function refusalMessage(body: Record<string, unknown> | null, fallback: string): string {
  const reason = body?.reason ?? body?.message;
  return typeof reason === 'string' && reason.trim() ? reason.trim() : fallback;
}

/**
 * Dispatch ONE command to 2990. Owns both idempotency layers' consequences:
 *   • 2xx                     → DONE
 *   • 409 bad_transition      → read status back; at/past target → CONVERGED,
 *                               else FAILED (2990 took it somewhere else, e.g.
 *                               REJECTED)
 *   • 409 received_floor / 400 / 403 / 404 → FAILED (a retry cannot fix these)
 *   • network / 5xx           → retryable (stays PENDING until attempts exhaust)
 *
 * Guards against acting on a terminal or missing config so it is safe to call
 * from both the inline waitUntil and the cron sweep on the same row.
 */
export async function dispatchOne(
  sb: SupabaseClient<any, any, any>,
  cfg: BridgeCommandConfig,
  row: SyncCommandRow,
): Promise<void> {
  if (isTerminal(row.status)) return;
  if (row.entity !== AMENDMENT_ENTITY) return;
  const target = row.target_status;
  if (!target) {
    await mark(sb, row.id, { status: 'FAILED', last_error: 'Command has no target status.', completed_at: new Date().toISOString() });
    return;
  }

  const attempts = (row.attempts ?? 0) + 1;
  await mark(sb, row.id, { status: 'SENT', attempts });

  const failed = (msg: string) =>
    mark(sb, row.id, { status: 'FAILED', last_error: msg, completed_at: new Date().toISOString() });
  const done = (status: 'DONE' | 'CONVERGED') =>
    mark(sb, row.id, { status, last_error: null, completed_at: new Date().toISOString() });
  const retryable = async (msg: string) => {
    if (attempts >= MAX_ATTEMPTS) {
      await mark(sb, row.id, { status: 'FAILED', last_error: `Gave up after ${attempts} attempts. Last error: ${msg}`, completed_at: new Date().toISOString() });
    } else {
      await mark(sb, row.id, { status: 'PENDING', last_error: msg });
    }
  };

  let resp: { status: number; body: Record<string, unknown> | null };
  try {
    resp = await patchAmendmentGate(cfg, row.entity_key, row.action, row.payload ?? {});
  } catch (e) {
    await retryable(e instanceof BridgeCommandError ? e.message : e instanceof Error ? e.message : 'Unknown dispatch error.');
    return;
  }

  if (resp.status >= 200 && resp.status < 300) {
    await done('DONE');
    return;
  }

  if (resp.status === 409 && resp.body?.error === 'bad_transition') {
    const current = await fetchAmendmentStatus(cfg, row.entity_key);
    if (current && statusSatisfies(current as AmendStatus, target)) {
      await done('CONVERGED');
      return;
    }
    await failed(
      current === 'REJECTED'
        ? 'This amendment was already rejected in 2990, so it can no longer be approved.'
        : `2990 could not apply this change from its current state${current ? ` (${current})` : ''}.`,
    );
    return;
  }

  if (resp.status === 409 && resp.body?.error === 'received_floor') {
    await failed(refusalMessage(resp.body, 'A revised quantity is below what has already been received on the bound PO, so 2990 refused it.'));
    return;
  }

  if (resp.status === 403) {
    await failed('The 2990 bridge account is not permitted to perform this action. It needs an approve-capable role (coordinator / showroom lead / admin).');
    return;
  }

  if (resp.status === 400 || resp.status === 404) {
    await failed(refusalMessage(resp.body, `2990 rejected the request (${resp.status}).`));
    return;
  }

  await retryable(refusalMessage(resp.body, `2990 responded with status ${resp.status}.`));
}

/**
 * Cron sweep (§3.2 "backstop sweep"). Drains retryable amendment commands oldest
 * first. No-op when the flag is off or the bridge is unconfigured — so it is safe
 * to wire unconditionally into the existing every-5-min cron. Returns a small summary for
 * the cron log.
 */
export async function drainCommands(env: Env): Promise<{
  skipped?: string;
  processed: number;
  done: number;
  converged: number;
  failed: number;
  retried: number;
}> {
  const sb = getSupabaseService(env);
  const zero = { processed: 0, done: 0, converged: 0, failed: 0, retried: 0 };

  if (!(await commandsEnabled(sb))) return { skipped: 'disabled', ...zero };

  const cfg = readBridgeCommandConfig(env);
  if (!cfg.ok) return { skipped: 'bridge_not_configured', ...zero };

  const { data, error } = await sb
    .from('sync_command')
    .select('*')
    .eq('entity', AMENDMENT_ENTITY)
    .in('status', ['PENDING', 'SENT'])
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(DRAIN_BATCH);
  if (error || !data) return { skipped: error ? 'query_failed' : undefined, ...zero };

  const now = Date.now();
  const rows = (data as SyncCommandRow[]).filter((r) => {
    if (r.status === 'SENT') {
      const age = now - new Date(r.updated_at).getTime();
      return age >= SENT_STALE_MS;
    }
    return true;
  });

  const summary = { ...zero };
  for (const row of rows) {
    summary.processed += 1;
    await dispatchOne(sb, cfg.config, row);
    const { data: after } = await sb.from('sync_command').select('status').eq('id', row.id).maybeSingle();
    const st = (after as { status?: string } | null)?.status;
    if (st === 'DONE') summary.done += 1;
    else if (st === 'CONVERGED') summary.converged += 1;
    else if (st === 'FAILED') summary.failed += 1;
    else summary.retried += 1;
  }
  return summary;
}
