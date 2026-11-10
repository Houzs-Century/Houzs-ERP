// ── Accepting a TOTP code: once, and only once ────────────────
//
// A code is valid for its own 30-second step and, for clock drift, the step on
// either side — about 90 seconds in all. Before 2026-11-10 nothing remembered a
// code once accepted, so a code read over a shoulder or out of a log could be
// used again inside that window. users.totp_last_step now holds the step of the
// last code accepted, and a code is accepted only if its step is LATER. The
// write is a compare-and-set on that column, so two requests racing with the
// same code cannot both win.

import type { Env } from "../types";
import { matchTotpStep } from "./totp";
import { isSealedTotpSecret, openTotpSecret, sealTotpSecret } from "./totpSecret";

export type TotpCheckRow = {
  totp_secret: string | null;
  totp_last_step: number | string | null;
};

export async function acceptTotpCode(
  env: Env,
  userId: number,
  row: TotpCheckRow,
  code: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!row.totp_secret) return false;
  const secret = await openTotpSecret(env, userId, row.totp_secret);
  if (!secret) {
    // eslint-disable-next-line no-console
    console.error("[totp] a sealed secret could not be opened for user", userId);
    return false;
  }
  const step = await matchTotpStep(secret, code, 1, nowMs);
  if (step === null) return false;
  const won = await env.DB.prepare(
    `UPDATE users SET totp_last_step = ?
      WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)
      RETURNING id`,
  )
    .bind(step, userId, step)
    .first<{ id: number }>();
  if (!won) return false;

  if (!isSealedTotpSecret(row.totp_secret)) {
    try {
      const sealed = await sealTotpSecret(env, userId, secret);
      if (sealed !== row.totp_secret) {
        await env.DB.prepare(`UPDATE users SET totp_secret = ? WHERE id = ? AND totp_secret = ?`)
          .bind(sealed, userId, row.totp_secret)
          .run();
      }
    } catch (e) {
      // The code was right and is now spent; sealing is retried on the next sign-in.
      // eslint-disable-next-line no-console
      console.error("[totp] could not seal a plain secret for user", userId, e);
    }
  }
  return true;
}
