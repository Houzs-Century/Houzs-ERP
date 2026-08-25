# Module: Account self-service — profile, password, two-factor, photo

> **Line numbers are INDICATIVE.** Paths, endpoints and permission keys here are
> authoritative; `:NNN` drifts with every merge. Resolve a route with the
> generated artifact, which is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

What a signed-in member can change about their OWN account, on either device.
Everything an ADMIN does TO somebody else's account — invite, reset password,
impersonate, force-disable another member's 2FA — is a different module and
lives in `docs/modules/team-members.md`.

There is no permission gate on this module. The subject is always the caller;
every endpoint is `/me`-shaped or derives the user from the session.

---

## 1. The two surfaces, and the layer they share

| Concern | Desktop | Mobile |
|---|---|---|
| Page shell | `frontend/src/pages/Profile.tsx` | `frontend/src/mobile/MobileProfile.tsx` |
| Display name | Identity section | `PersonalScreen` |
| Password | `PasswordSection` | `SecurityScreen` |
| Two-factor | `TwoFactorSection` | `frontend/src/mobile/MobileTwoFactorCard.tsx` |
| Profile photo | `frontend/src/components/Avatar.tsx` + the camera badge | `frontend/src/mobile/MobileAvatar.tsx` |

**The shared layer is the point of this module.** Two files hold the logic and
both surfaces import them; neither surface owns a second copy of an endpoint, a
limit, or a gate.

| Shared module | What it owns |
|---|---|
| `frontend/src/lib/totpEnrollment.ts` | `useTotpEnrollment()` — the whole TOTP state machine: status, setup, enable, disable, the one-time backup codes, and every refusal message. |
| `frontend/src/lib/profilePicture.ts` | `useProfilePicUrl()` (the authed blob read + object-URL lifetime) and `useProfilePicture()` (compress → weigh → PUT, and delete). Also the two limits, as exported constants. |

### Why it is shaped this way

Until 2026-08-21 all of it was private to the desktop components. The bill was a
**self-service lockout**: a member with only a phone could ANSWER the 2FA
challenge at login (`MobileLogin`) but had no screen anywhere that could turn 2FA
off again. An ADMIN could always reset it (`POST /api/users/:id/totp/disable`,
`users.manage` — see `docs/modules/team-members.md`), so the account was never
absolutely lost; what a phone-only member had was no way back without another
person, and no way to see how many backup codes were left while deciding. The photo
had the mirror-image gap — the one device with a camera could neither upload nor
even display a photo. Both had the same cause: a rule written into one surface's
component instead of into a layer both can import.
Full trace:
`docs/bugs/0484-a-phone-only-member-could-never-turn-2fa-off-which-is-an-unr.md`.

**If you add an account-level capability, it goes in the shared module first and
gets rendered twice.** A capability that exists on one surface only is the defect
this module was created to record.

---

## 2. API surface

| Method + path | Used by | Notes |
|---|---|---|
| `PATCH /api/auth/me` | both | Display name only. Everything else on the HR record is admin-owned. |
| `POST /api/auth/me/password` | both | `{ current, next }`. Verifies the current password and signs out OTHER sessions; the caller stays signed in. Strength checked client-side by `lib/passwordStrength` on both surfaces. |
| `GET /api/totp/status` | both | `{ enabled, backup_codes_remaining }`. |
| `POST /api/totp/setup` | both | Returns `{ secret, otpauth_uri }` for a PENDING enrolment. Does not enable anything. |
| `POST /api/totp/enable` | both | `{ code }`. Returns `{ backup_codes }` — the only time they are ever sent. |
| `POST /api/totp/disable` | both | `{ code }`. A CURRENT 6-digit code or a backup code; the server verifies it. |
| `PUT /api/users/me/profile-pic?name=` | both | Binary body via `api.putBinary`. |
| `DELETE /api/users/me/profile-pic` | both | |
| `GET /api/users/:id/profile-pic` | both | Authed blob read, any user — this is what renders a teammate's avatar. |

---

## 3. Rules that are security-load-bearing

**1. Disabling 2FA is gated identically on both surfaces, and the gate is the
server's.** A code must be supplied and posted to `/api/totp/disable`. The two
surfaces differ ONLY in how they collect it: desktop uses the in-app prompt
dialog (`useDialog().prompt` from `hooks/useDialog`, danger-toned, required —
a naked `window.prompt` until 2026-08-25, which an installed PWA suppresses, so
the desktop disable path could silently no-op there; `docs/bugs/0539-the-last-two-naked-prompts-2fa-disable-and-pos-pin-entry-spo.md`), mobile
uses an inline field, because a browser prompt is suppressed in several webviews
and unusable in an installed PWA — porting a prompt verbatim would have shipped
a disable path that still did not work on a phone. Revealing the mobile field
posts nothing. **A Disable control that does not carry a code is a downgrade, not
a simplification.**

**2. The secret and the backup codes exist in React state and nowhere else.** No
localStorage, no sessionStorage, no cookie, no console, no query string. The
setup key is RENDERED because the member has to copy it into an authenticator;
that is the only place it appears. Pinned by the
`never writes a secret or a backup code to storage` case in
`frontend/src/mobile/mobileTotpSurface.test.tsx`.

**3. Backup codes are shown once, so nothing may take them away by accident.**
They leave the screen only when the member acknowledges them. On mobile they are
a fixed full-viewport overlay, which covers the sub-screen's back button — a
stray back-tap is the ordinary way a phone loses a shown-once screen. They are
NOT persisted to survive a closed tab; that would violate rule 2, and the honest
trade is stated here rather than solved wrongly.

**4. A failed STATUS read must not render as "off".** `useTotpEnrollment` leaves
`status` null and binds `statusError`. Both surfaces then say the status could
not be checked. The old desktop code swallowed the failure into
`{ enabled: false }`, which offered an "Enable 2FA" button to an account whose
2FA was already on.

**5. The photo limits are the shared module's, not each surface's.**
`PROFILE_PIC_MAX_DIMENSION` (1000) and `PROFILE_PIC_MAX_BYTES` (5 MB), weighed
AFTER `prepareImageForUpload` compresses — so the refusal is about what would
actually be sent. Do not re-type either number at a call site.

---

## 4. Traps

- **`profile_pic_r2_key` is the cache-buster, not just a flag.** R2 keys carry a
  `Date.now()` prefix, so a fresh upload yields a new key. `useProfilePicUrl`
  appends it as `?k=`; without it the browser keeps the old blob and the upload
  looks like it did nothing. This is also why an upload must `reload()` the auth
  user — the new key has to reach `user` or every avatar on screen stays stale.
- **Mobile keeps its own paint, deliberately.** `components/Avatar` is a Tailwind
  component and the mobile shell is inline-styled `mobile.css` with a specific
  58px teal/gold token. `MobileAvatar` shares the DATA path and not the markup.
  That is the correct seam; copying the fetch into the mobile file is not.
- **The mobile Security sub-screen unmounts on Back.** Anything one-time rendered
  inside it needs the overlay treatment described in rule 3, or a back-tap loses
  it.
- **`MobileLogin` handles the TOTP CHALLENGE and is not part of this module.**
  Signing in with 2FA and managing 2FA are different surfaces; only the second
  one lives here.

---

## See also

- `docs/modules/team-members.md` — the admin side, including
  `POST /:id/totp/disable` (an admin disabling somebody ELSE's 2FA).
- `docs/ACCOUNT-SECURITY-SETUP.md` — the owner's platform-level MFA (Supabase,
  GitHub, Cloudflare). Different subject: that is our vendors, this is our app.
