// Personal Mail Center mailboxes (DEV-03 / PRD T-011 P3). The atomic alias
// helper moved here from routes/users.ts unchanged; invite, accept-invite and
// the user edit screen all provision through it.
import type { Env } from "../types";
import { getBranding } from "../services/branding";
import { resolveDatabaseUrl } from "../db/pg";

// Auto-provision a member's PERSONAL Mail Center mailbox when their email_alias
// is set/changed to a company-domain address (owner: "成员设 alias 就自动建箱").
// Idempotent: ensures one email_addresses row (assigned to the user, active) +
// one email_address_access grant. Fires ONLY for an alias on the company's own
// verified domain — a personal gmail/etc. can't send/receive through our IMAP +
// Resend, so we never mint a dead mailbox. Raw SQL: the mail tables live outside
// the Drizzle schema (managed the same way in routes/mail-center.ts).
export interface PersonalMailboxAliasChange {
  old_alias: string;
  old_mailbox_id: string | null;
  new_alias: string;
  // The canonical id resolved inside the same commit as users.email_alias.
  mailbox_id: string | null;
}

export class AliasMailboxCollisionError extends Error {
  constructor(readonly address: string) {
    super(`Mail alias ${address} is already assigned to another user`);
    this.name = "AliasMailboxCollisionError";
  }
}

export async function companyMailboxDomain(env: Env): Promise<string> {
  const fallback = "houzscentury.com";
  try {
    const branding = await getBranding(env);
    return (branding.email.split("@")[1] || fallback).trim().toLowerCase();
  } catch {
    // Branding is optional during bootstrap. Provisioning writes below remain
    // fail-closed; this is only the established default-domain fallback.
    return fallback;
  }
}

// Change the canonical alias and all DERIVED personal-mailbox ownership as one
// commit. A company-domain alias is guaranteed to resolve to one active mailbox
// owned by the user plus one self-grant before users.email_alias can change.
// An inbound-created, unowned mailbox may be claimed; a mailbox owned by another
// user is a hard collision and is never reassigned. The previous mailbox stays
// active and other users' grants survive when this user's ownership moves away.
export async function changePersonalMailboxAliasAtomically(
  env: Env,
  userId: number,
  previousAlias: string | null,
  nextAlias: string | null,
  displayName?: string | null,
): Promise<PersonalMailboxAliasChange | null> {
  const oldAddr = (previousAlias ?? "").trim().toLowerCase();
  const newAddr = (nextAlias ?? "").trim().toLowerCase();
  if (oldAddr === newAddr) return null;

  const domain = await companyMailboxDomain(env);
  const shouldProvision = !!newAddr && newAddr.endsWith(`@${domain}`);
  const now = new Date().toISOString();
  const candidateMailboxId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  let label = displayName?.trim() || null;
  if (displayName === undefined) {
    const user = await env.DB.prepare(`SELECT name FROM users WHERE id = ? LIMIT 1`)
      .bind(userId)
      .first<{ name: string | null }>();
    label = user?.name?.trim() || null;
  }

  const oldMailbox = await env.DB.prepare(
    `SELECT id FROM email_addresses
       WHERE lower(address) = ? AND assigned_user_id = ? LIMIT 1`,
  )
    .bind(oldAddr, userId)
    .first<{ id: string }>();

  if (resolveDatabaseUrl(env)) {
    // PostgreSQL path: one statement is one real transaction. Every mutating
    // CTE is gated by ready_user, so collision or concurrent alias drift writes
    // nothing. d1Compat.batch is intentionally not used on the PG path.
    const result = await env.DB.prepare(
      `WITH target_user AS (
         SELECT id, email_alias
           FROM users
          WHERE id = ? AND lower(COALESCE(email_alias, '')) = ?
          FOR UPDATE
       ), existing_new AS (
         SELECT ea.id, ea.assigned_user_id
           FROM email_addresses ea
          WHERE ? = 1 AND lower(ea.address) = ?
          FOR UPDATE
       ), can_commit AS (
         SELECT cu.id
           FROM target_user cu
          WHERE ? = 0
             OR NOT EXISTS (
               SELECT 1 FROM existing_new en
                WHERE en.assigned_user_id IS NOT NULL
                  AND en.assigned_user_id <> cu.id
             )
       ), inserted_new AS (
         INSERT INTO email_addresses
           (id, address, label, assigned_user_id, assigned_user_name,
            assigned_dept, assigned_position, active, created_at, created_by)
         SELECT ?, ?, ?, cc.id, ?, NULL, NULL, 1, ?, cc.id
           FROM can_commit cc
          WHERE ? = 1 AND NOT EXISTS (SELECT 1 FROM existing_new)
         ON CONFLICT DO NOTHING
         RETURNING id
       ), claimed_new AS (
         UPDATE email_addresses ea
            SET assigned_user_id = cc.id,
                assigned_user_name = ?,
                active = 1
           FROM can_commit cc
          WHERE ? = 1 AND lower(ea.address) = ?
            AND (ea.assigned_user_id IS NULL OR ea.assigned_user_id = cc.id)
         RETURNING ea.id
       ), final_new AS (
         SELECT id FROM inserted_new
         UNION
         SELECT id FROM claimed_new
       ), ready_user AS (
         SELECT cc.id
           FROM can_commit cc
          WHERE ? = 0 OR EXISTS (SELECT 1 FROM final_new)
       ), old_mailbox AS (
         SELECT ea.id
           FROM email_addresses ea
           JOIN ready_user ru ON ea.assigned_user_id = ru.id
          WHERE lower(ea.address) = ? AND ? <> ''
          FOR UPDATE
       ), inserted_grant AS (
         INSERT INTO email_address_access
           (id, address_id, user_id, created_at, created_by)
         SELECT ?, fn.id, ru.id, ?, ru.id
           FROM final_new fn CROSS JOIN ready_user ru
         ON CONFLICT (address_id, user_id) DO NOTHING
         RETURNING address_id
       ), deleted_grant AS (
         DELETE FROM email_address_access a
          USING old_mailbox om, ready_user ru
          WHERE a.address_id = om.id AND a.user_id = ru.id
          RETURNING a.address_id
       ), cleared_owner AS (
         UPDATE email_addresses ea
            SET assigned_user_id = NULL, assigned_user_name = NULL
           FROM old_mailbox om, ready_user ru
          WHERE ea.id = om.id AND ea.assigned_user_id = ru.id
          RETURNING ea.id
       ), updated_user AS (
         UPDATE users u
            SET email_alias = ?
           FROM ready_user ru
          WHERE u.id = ru.id
          RETURNING u.id
       )
       SELECT (SELECT id FROM target_user LIMIT 1) AS current_user_id,
              (SELECT id FROM can_commit LIMIT 1) AS eligible_user_id,
              (SELECT id FROM updated_user LIMIT 1) AS user_id,
              (SELECT id FROM old_mailbox LIMIT 1) AS old_mailbox_id,
              (SELECT id FROM final_new LIMIT 1) AS mailbox_id,
              (SELECT COUNT(*) FROM deleted_grant) AS grants_removed,
              (SELECT COUNT(*) FROM cleared_owner) AS owners_cleared,
              (SELECT COUNT(*) FROM inserted_grant) AS grants_inserted`
    )
      .bind(
        userId,
        oldAddr,
        shouldProvision ? 1 : 0,
        newAddr,
        shouldProvision ? 1 : 0,
        candidateMailboxId,
        newAddr,
        label,
        label,
        now,
        shouldProvision ? 1 : 0,
        label,
        shouldProvision ? 1 : 0,
        newAddr,
        shouldProvision ? 1 : 0,
        oldAddr,
        oldAddr,
        grantId,
        now,
        nextAlias,
      )
      .first<{
        current_user_id: number | null;
        eligible_user_id: number | null;
        user_id: number | null;
        old_mailbox_id: string | null;
        mailbox_id: string | null;
      }>();
    if (result?.current_user_id == null) {
      throw new Error("email alias changed concurrently; reload and try again");
    }
    if (result.eligible_user_id == null) {
      throw new AliasMailboxCollisionError(newAddr);
    }
    if (result.user_id == null || (shouldProvision && result.mailbox_id == null)) {
      throw new Error("mail alias provisioning could not be committed; reload and try again");
    }
    return {
      old_alias: oldAddr,
      old_mailbox_id: result.old_mailbox_id,
      new_alias: newAddr,
      mailbox_id: result.mailbox_id,
    };
  } else {
    // Native D1 path. Cloudflare D1 batch is transaction-bound: any statement
    // failure rolls the whole batch back. This branch is selected only when no
    // PG/HYPERDRIVE URL exists, so d1Compat.batch is never trusted here.
    const expectedUser = `EXISTS (
      SELECT 1 FROM users
       WHERE id = ? AND lower(COALESCE(email_alias, '')) = ?
    )`;
    const statements: D1PreparedStatement[] = [];
    if (shouldProvision) {
      // Existing unowned (inbound-created) mailboxes may be claimed. The guard
      // grant intentionally violates address_id NOT NULL for another owner's
      // mailbox, making D1 roll the entire batch back instead of taking it over.
      statements.push(
        env.DB.prepare(
          `INSERT INTO email_addresses
             (id, address, label, assigned_user_id, assigned_user_name,
              assigned_dept, assigned_position, active, created_at, created_by)
           SELECT ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?
            WHERE ${expectedUser}
           ON CONFLICT DO NOTHING`,
        ).bind(candidateMailboxId, newAddr, label, userId, label, now, userId, userId, oldAddr),
        env.DB.prepare(
          `INSERT INTO email_address_access
             (id, address_id, user_id, created_at, created_by)
           SELECT ?,
                  CASE
                    WHEN (ea.assigned_user_id IS NULL OR ea.assigned_user_id = ?)
                     AND ${expectedUser}
                    THEN ea.id
                    ELSE NULL
                  END,
                  ?, ?, ?
             FROM email_addresses ea
            WHERE lower(ea.address) = ?
           ON CONFLICT DO NOTHING`,
        ).bind(grantId, userId, userId, oldAddr, userId, now, userId, newAddr),
        env.DB.prepare(
          `UPDATE email_addresses
              SET assigned_user_id = ?, assigned_user_name = ?, active = 1
            WHERE lower(address) = ?
              AND (assigned_user_id IS NULL OR assigned_user_id = ?)
              AND ${expectedUser}`,
        ).bind(userId, label, newAddr, userId, userId, oldAddr),
      );
    }

    const revokeOffset = statements.length;
    statements.push(
      env.DB.prepare(
        `DELETE FROM email_address_access
          WHERE user_id = ?
            AND ? <> ''
            AND address_id IN (
              SELECT id FROM email_addresses
               WHERE lower(address) = ? AND assigned_user_id = ?
            )
            AND ${expectedUser}`,
      ).bind(userId, oldAddr, oldAddr, userId, userId, oldAddr),
      env.DB.prepare(
        `UPDATE email_addresses
            SET assigned_user_id = NULL, assigned_user_name = NULL
          WHERE ? <> '' AND lower(address) = ? AND assigned_user_id = ?
            AND ${expectedUser}`,
      ).bind(oldAddr, oldAddr, userId, userId, oldAddr),
      env.DB.prepare(
        `UPDATE users SET email_alias = ?
          WHERE id = ? AND lower(COALESCE(email_alias, '')) = ?`,
      ).bind(nextAlias, userId, oldAddr),
      env.DB.prepare(
        `SELECT id FROM email_addresses
          WHERE ? = 1 AND lower(address) = ? AND assigned_user_id = ?
          LIMIT 1`,
      ).bind(shouldProvision ? 1 : 0, newAddr, userId),
    );

    let results: D1Result[];
    try {
      results = await env.DB.batch(statements);
    } catch (error) {
      if (shouldProvision) {
        const collision = await env.DB.prepare(
          `SELECT assigned_user_id FROM email_addresses WHERE lower(address) = ? LIMIT 1`,
        )
          .bind(newAddr)
          .first<{ assigned_user_id: number | null }>();
        if (collision?.assigned_user_id != null && collision.assigned_user_id !== userId) {
          throw new AliasMailboxCollisionError(newAddr);
        }
      }
      throw error;
    }
    const updateResult = results[revokeOffset + 2];
    if (Number(updateResult?.meta?.changes ?? 0) !== 1) {
      throw new Error("email alias changed concurrently; reload and try again");
    }
    const mailboxResult = results[revokeOffset + 3];
    const finalMailboxId = shouldProvision
      ? ((mailboxResult?.results?.[0] as { id?: string } | undefined)?.id ?? null)
      : null;
    if (shouldProvision && !finalMailboxId) {
      throw new Error("mail alias provisioning committed without an owned mailbox");
    }
    return {
      old_alias: oldAddr,
      old_mailbox_id: oldMailbox?.id ?? null,
      new_alias: newAddr,
      mailbox_id: finalMailboxId,
    };
  }
}

/** "first.last" from a display name (ASCII letters and digits only); one word
 *  stays one word. null when nothing usable is left. */
export function defaultPersonalLocalPart(name: string | null | undefined): string | null {
  const words = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.length === 1 ? words[0] : `${words[0]}.${words[words.length - 1]}`;
}

/** Another person's alias or login, a mailbox someone else owns, or a
 *  department mailbox. An unowned inbound-created row is free to claim. */
export async function isPersonalAddressTaken(db: D1Database, address: string, userId: number | null): Promise<boolean> {
  const lc = address.trim().toLowerCase();
  const me = userId ?? 0;
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM users
        WHERE id <> ? AND (lower(COALESCE(email_alias, '')) = ? OR lower(email) = ?)
       UNION ALL
       SELECT 1 FROM email_addresses
        WHERE lower(address) = ?
          AND ((assigned_user_id IS NOT NULL AND assigned_user_id <> ?)
               OR (assigned_dept IS NOT NULL AND trim(assigned_dept) <> ''))
       LIMIT 1`,
    )
    .bind(me, lc, lc, lc, me)
    .first<{ hit: number }>();
  return !!row;
}

/** The first free first.last@domain, then first.last2 … first.last9. */
export async function freePersonalAddress(env: Env, userId: number | null, name: string | null | undefined): Promise<string | null> {
  const local = defaultPersonalLocalPart(name);
  if (!local) return null;
  const domain = await companyMailboxDomain(env);
  for (let n = 1; n <= 9; n++) {
    const candidate = `${local}${n === 1 ? "" : n}@${domain}`;
    if (!(await isPersonalAddressTaken(env.DB, candidate, userId))) return candidate;
  }
  return null;
}

/** A newly provisioned address waits until someone adds it in Google
 *  Workspace (R2); one that has already received mail is live. */
export async function markMailHostPending(db: D1Database, mailboxId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE email_addresses
          SET mail_host_status = CASE WHEN EXISTS (
                SELECT 1 FROM email_threads t
                 WHERE lower(t.mailbox_address) = lower(email_addresses.address)
                   AND t.last_inbound_at IS NOT NULL) THEN 'live' ELSE 'pending' END
        WHERE id = ? AND mail_host_status IS NULL`,
    )
    .bind(mailboxId)
    .run();
}

/** Invite / accept-invite: give the person their address through the atomic
 *  helper. No `requested` = keep the current address, else the default first.last. */
export async function provisionPersonalMailbox(
  env: Env,
  userId: number,
  requested?: string,
): Promise<string | null> {
  const user = await env.DB.prepare(`SELECT name, email_alias FROM users WHERE id = ? LIMIT 1`)
    .bind(userId)
    .first<{ name: string | null; email_alias: string | null }>();
  if (!user) return null;
  const current = user.email_alias?.trim().toLowerCase() || null;
  let next: string | null;
  if (requested) {
    next = requested.trim().toLowerCase();
  } else {
    if (current) return current;
    next = await freePersonalAddress(env, userId, user.name);
  }
  if (!next || next === current) return current;
  const change = await changePersonalMailboxAliasAtomically(env, userId, current, next, user.name);
  if (change?.mailbox_id) await markMailHostPending(env.DB, change.mailbox_id);
  return next;
}
