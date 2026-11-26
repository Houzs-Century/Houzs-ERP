
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
      // eslint-disable-next-line no-console
      console.error("[totp] could not seal a plain secret for user", userId, e);
    }
  }
  return true;
}
