## A phone-only member could never turn 2FA off, which is an unrecoverable lockout [high]

<!-- area: Auth, permissions, sessions -->

**白话.** 同事如果只有手机、没有电脑，他可以用两步验证（2FA）登入，但**没有任何一个
画面**可以让他自己把 2FA 关掉。手机掉了、换机、验证器 App 被误删 —— 他就只能去找一台
电脑，或者去求管理员帮他重设。同一个画面上「还剩几组备用码」也看不到，所以他连自己
还剩多少后路都不知道。顺带一提：手机是唯一有相机的装置，却是唯一不能上传大头照的 ——
连别人在电脑上传好的照片，手机上也看不到，永远只显示两个英文字母。

**Symptom.** Everything about two-factor except the login challenge was desktop
only. A member working from a phone could sign in with 2FA (`MobileLogin`
handles the challenge) but could not enrol, could not see the backup-code count,
and could not DISABLE 2FA after losing the authenticator.

**Said precisely, because the difference matters:** this was not an
*absolutely* unrecoverable account — `POST /api/users/:id/totp/disable`
(`users.manage`) lets an ADMIN reset somebody's 2FA, and `backend/src/routes/totp.ts`
names that as the lost-device path. What did not exist was any SELF-service way
back from a phone. A member on the road with no PC had to find an administrator
and wait, holding a backup code they could not even count. That is the gap; the
title's "unrecoverable" overstates it and is left only because the filename is
the ledger's stable citation key.

**Root cause (traced, not guessed).** The whole TOTP surface — status, setup,
enable, disable, backup codes — was written INSIDE the desktop page component
`frontend/src/pages/Profile.tsx` as a private `TwoFactorSection`. It was never a
shared module, so there was nothing for a second surface to import, and
`grep -ci totp frontend/src/mobile/MobileProfile.tsx` returned `0`. The same
shape hid the profile photo: `uploadPic` / `removePic` were private functions of
the same page component and the blob read was private to
`frontend/src/components/Avatar.tsx`, so `frontend/src/mobile/` contained no
reference to `profile_pic` at all — mobile could neither upload one nor render
one somebody else had uploaded.

This is the duplication-root-cause class the repo already names: a rule written
into one surface's component instead of into a layer both surfaces import.

**Fix.** The state machine and the photo paths moved out of the two desktop
components into `frontend/src/lib/totpEnrollment.ts` and
`frontend/src/lib/profilePicture.ts`; desktop and mobile now both import them,
and neither owns a second copy of an endpoint, a limit or a gate.
`frontend/src/mobile/MobileTwoFactorCard.tsx` and
`frontend/src/mobile/MobileAvatar.tsx` are markup over those modules.

**The disable gate is the desktop's gate, deliberately not a friendlier one.** A
current 6-digit code (or a backup code) must be typed and travel to
`POST /api/totp/disable`, which verifies it. The phone collects it in an inline
field rather than `window.prompt` — a browser prompt is suppressed in several
webviews and unusable in an installed PWA, which is how a "parity" port would
have quietly shipped a disable path that still did not work. Revealing the field
posts nothing; there is no code-less route off that card.

**One swallowed read fixed on the way past, because moving it would have hidden
it.** The status read was `try { … } catch { setStatus({ enabled: false, … }) }`,
so a failed read rendered "Not enabled" plus an "Enable 2FA" button to a member
whose 2FA is ON. The shared hook binds the reason and leaves `status` null; both
surfaces now say the status could not be checked. `Avatar`'s bare
`.catch(() => {})` went with it — `audit:swallowed-reads` counted it, and the
ceiling in `backend/scripts/data/swallowed-read-baseline.json` is lowered
`1 -> 0` in this same commit, which is what makes that ratchet descend rather
than merely hold.

**Nothing about the secret or the codes persists.** The setup key and the backup
codes live in React state and nowhere else — no storage, no cookie, no log. The
codes take over the viewport as a fixed overlay until acknowledged, so the
ordinary way a phone loses a shown-once screen (a stray back-tap) cannot reach
the back button underneath.

**Guards proved RED before being trusted.** On the unfixed tree
`frontend/src/mobile/mobileTotpSurface.test.tsx` and
`frontend/src/mobile/mobileProfilePhoto.test.tsx` fail **7 of 7**, each on the
gap itself — `Unable to find role="button" and name /enable 2fa/i`,
`Unable to find an element with the alt text: /wei siang/i`. Four of the seven
are the security-load-bearing ones: disable demands a code and posts it, the
backup codes survive a re-render and leave only on acknowledgement, and neither
the secret nor a code reaches localStorage / sessionStorage / cookies.

**Ref.** `feat/mobile-2fa-profile-convert`, 2026-08-21.
