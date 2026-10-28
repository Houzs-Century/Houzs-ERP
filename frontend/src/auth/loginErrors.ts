/* The ONE place the sign-in failure wording lives. Desktop (AuthScreens) and
   mobile (MobileLogin) both read from here — the two screens previously carried
   their own copy of the string and had already drifted in wording.
 *
 * WHY IT IS DELIBERATELY VAGUE — do not "improve" this by splitting it.
 *
 * Both screens used to render "Password incorrect." on any 401. The backend
 * returns the same 401 whether the EMAIL is unknown or the PASSWORD is wrong,
 * so that sentence was two things at once:
 *
 *  1. A security hole if it were ever made accurate. Telling a visitor which
 *     half was wrong lets anyone holding a list of email addresses discover
 *     which ones are real staff accounts, one request each, without guessing a
 *     single password. That is the opening move of a credential attack. The
 *     owner asked for the split on 2026-07-19, was shown this, and accepted the
 *     combined message.
 *
 *  2. A plain falsehood in the common case. Someone who mistyped their email
 *     address was told their password was wrong, and went off resetting a
 *     password that was never the problem.
 *
 * The matching backend change (routes/auth.ts) closes the same distinction in
 * the status code and in response TIMING, so the vagueness here is real and not
 * merely cosmetic. */
export const SIGN_IN_FAILED = "Email or password is incorrect.";

/** Message for a failed sign-in attempt. A 401 is the combined
 *  wrong-email-or-password answer; anything else already arrives humanised from
 *  the API client, so it is passed through. */
export function signInErrorMessage(e: unknown): string {
  const status = (e as { status?: number } | null | undefined)?.status;
  if (status === 401) return SIGN_IN_FAILED;
  const msg = e instanceof Error ? e.message : "";
  return msg || "We couldn't sign you in. Please check your connection and try again.";
}
