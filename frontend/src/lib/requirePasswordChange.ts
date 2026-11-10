import { api } from "../api/client";

/* Team > member > "Require password change" — desktop TeamMemberProfile and
   mobile MemberAccountActions share this so the wording of what happens to the
   member cannot drift between the two surfaces. */

export function requirePasswordChangeConfirmText(email: string): string {
  return (
    `Require ${email} to choose a new password?\n\n` +
    "They are signed out on every device now. At their next sign-in their current " +
    "password opens only a \"choose a new password\" screen; after that they carry on as normal. " +
    "Crew PIN sign-in is not affected."
  );
}

export function requirePasswordChangeDoneText(email: string, sessionsEnded: number): string {
  const ended = sessionsEnded === 1 ? "1 session" : `${sessionsEnded} sessions`;
  return `${email} will be asked for a new password at next sign-in (${ended} ended).`;
}

export async function requirePasswordChange(userId: number | string): Promise<number> {
  const res = await api.post<{ ok: boolean; sessions_ended?: number }>(
    `/api/users/${userId}/require-password-change`,
  );
  return Number(res.sessions_ended ?? 0);
}
