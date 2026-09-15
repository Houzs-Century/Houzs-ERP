# Account Self-Service

What a signed-in member can change about their OWN account — display name, password, two-factor, profile photo — on either device. Admin actions on someone ELSE's account (invite, reset password, force-disable 2FA) are a different module: `docs/modules/team-members.md`. There is no permission gate here; the subject is always the caller, and every endpoint is `/me`-shaped or derives the user from the session.

## Statuses and flow

- `PATCH /api/auth/me` — display name only; everything else on the HR record is admin-owned.
- `POST /api/auth/me/password` `{current, next}` — verifies the current password and signs out every OTHER session; the caller stays signed in.
- `GET /api/totp/status`, `POST /api/totp/setup` (returns a PENDING enrolment, enables nothing), `POST /api/totp/enable` `{code}` (returns backup codes — the only time they're ever sent), `POST /api/totp/disable` `{code}` (a current 6-digit code or a backup code, server-verified).
- `PUT`/`DELETE /api/users/me/profile-pic`, and `GET /api/users/:id/profile-pic` for any user (this is what renders a teammate's avatar).
- Both desktop and mobile share the exact same logic through two modules — `useTotpEnrollment()` (the whole TOTP state machine) and `useProfilePicUrl()`/`useProfilePicture()` (photo fetch, compress, upload, delete, and the size limits). Neither surface owns a second copy of an endpoint, a limit, or a gate. A capability added to only one surface is the defect this module exists to prevent — add it to the shared module first, render it twice.

## Rules that must not break

- Disabling 2FA is gated identically on both surfaces, and the gate is the SERVER's — a code must always be posted to `/api/totp/disable`. The two surfaces may differ only in how they collect that code (desktop: an in-app prompt dialog; mobile: an inline field, since a browser `prompt()` is suppressed in several webviews and an installed PWA). A disable control that doesn't carry a code is a downgrade, not a simplification.
- The TOTP secret and backup codes exist in React state and NOWHERE else — no localStorage, sessionStorage, cookie, console, or query string. The setup key is rendered once because the member must copy it into an authenticator app; that is its only appearance.
- Backup codes are shown once and leave the screen only on explicit acknowledgment — never persisted (that would violate the rule above). On mobile they render as a full-viewport overlay specifically to survive a stray back-tap.
- A failed 2FA status read must render as "could not be checked", never default to "off" — defaulting to disabled would offer an Enable button to an account whose 2FA is already on.
- The profile-photo size/dimension limits live only in the shared module and are checked AFTER compression, so the refusal reflects what would actually be uploaded — never re-declare either number at a call site.

## Gotchas

- `profile_pic_r2_key` is a cache-buster, not just a flag — it carries a timestamp prefix that must be appended as a query param on the image URL, or the browser keeps showing the old photo after a fresh upload. An upload must also reload the auth user so the new key reaches every avatar on screen.
- Mobile's avatar component shares the DATA path with desktop but not the markup — that split is intentional (different visual treatment); don't copy the fetch logic into the mobile file as a "fix".
- The mobile Security sub-screen unmounts on Back — anything meant to render only once inside it (like backup codes) needs the same full-viewport overlay treatment, or a back-tap silently loses it.
- `MobileLogin`'s TOTP challenge screen (answering 2FA at sign-in) is a different surface from this module (managing 2FA once signed in) — a fix to one does not touch the other.

## Where the code is

- `frontend/src/lib/totpEnrollment.ts` — shared TOTP state machine.
- `frontend/src/lib/profilePicture.ts` — shared photo fetch/compress/upload logic and size limits.
- `frontend/src/pages/Profile.tsx`, `frontend/src/mobile/MobileProfile.tsx` — desktop/mobile page shells.
- `frontend/src/mobile/MobileTwoFactorCard.tsx`, `frontend/src/mobile/MobileAvatar.tsx` — mobile 2FA and avatar components.
- `frontend/src/components/Avatar.tsx` — desktop avatar component.
