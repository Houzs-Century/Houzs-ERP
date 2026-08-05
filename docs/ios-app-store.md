# Putting the Houzs ERP mobile surface on iOS

Owner asked, 2026-08-03: *"是的，我要把我的手机版本上我们的 App Store。你可以帮我
看一下怎么样去弄、怎么样申请，帮我把这整个东西都弄完善吗？然后给我申请直接通过。"*

This document is the honest answer, written so it is still true when you read it.

**DECIDED, 2026-08-03.** The audience is **our own staff PLUS external partners**
(3PL carriers, dealers). That settles the channel: **Custom App through Apple
Business Manager, distributed by redemption-code link.** Why that combination and
not the obvious-sounding alternatives is section 2.

Three things still need saying before the steps.

---

## 1. There is no iOS app today. There is a website that behaves like one.

**SUPERSEDED since this was written:** the Capacitor shell now EXISTS at
`native/` (see `native/README.md`) and `.github/workflows/ios-build.yml` builds
it unsigned in CI. The rest of this section's reasoning still holds; only the
"nothing exists that could be submitted" claim is stale.

`frontend/src/mobile` is a **mobile web surface** of the same React/Vite SPA the
desktop uses, served by the same Cloudflare Worker. The address bar in your own
screenshot reads `erp.houzscentury.com`. There is no Xcode project, no Capacitor,
no React Native anywhere in this repository — nothing exists that could be
submitted.

It **is** already a PWA: `frontend/public/manifest.webmanifest` declares
`display: standalone`, there is a service worker (`sw.js`) and an
`apple-touch-icon.png`. Safari → Share → **Add to Home Screen** gives your staff
an icon, a full-screen app with no address bar, and instant updates with no
review queue. If what you actually want is "it looks and feels like an app on my
staff's phones", **that already works today and costs nothing.**

## 2. The public App Store is probably the wrong channel for this

Two review guidelines apply, and one of them is close to decisive.

**Guideline 3.2 (Business).** Apple states that an app built for a specific
business or organisation should be distributed through **Apple Business Manager**
as a *Custom App*, not on the public App Store. An internal ERP that only your
own staff can log into is exactly the case that guideline describes.

**Guideline 4.2 (Minimum Functionality).** Apple rejects apps that are
substantially a repackaged website. A Capacitor shell around this SPA, with no
native capability, is the textbook example. Passing usually requires real native
integration — push notifications, offline capability, camera/hardware use — not
just a WebView.

There is a third practical obstacle: a login-walled app must be submitted with a
**working demo account** for the reviewer, on your production system.

**What this means.** The build is the same either way — a signed `.ipa`. Only the
distribution channel differs.

| Channel | What it is | Cost / effort | Fit here |
|---|---|---|---|
| **PWA (today)** | Add to Home Screen | none | Works now. Instant updates. No review. |
| **Custom App via Apple Business Manager** | Not in public search; installed from a redemption-code link | $99/yr + build work | **CHOSEN** — see below |
| **TestFlight** | Up to 10,000 testers, builds expire after 90 days | $99/yr + build work | Good for trialling first. Expiry makes it wrong as the permanent channel |
| **Public App Store** | Anyone can download | $99/yr + build work + review risk | Fights 3.2 and 4.2 at once. Not recommended |
| **Apple Developer Enterprise Program** | Self-distribution, no App Store | $299/yr, hard to qualify for | Apple grants this rarely; expect refusal |

### The external-partner problem, and the thing that solves it

Custom Apps are normally distributed **to organisations**: you enter another
company's Apple Business Manager organisation ID and they receive the app. For a
3PL carrier or a dealer, that means asking a small Malaysian transport company to
enrol in Apple Business Manager before they can install your app. That is not
going to happen, and it is the reason "Custom App" sounds wrong for a
mixed audience at first.

**Redemption codes are the way round it.** In Apple Business Manager, under
Custom Apps, set **License Type = Redemption Codes**. Apple returns a link and a
batch of codes. Whoever opens that link installs the app from the App Store —
**they do not need to be in your organisation, and they do not need an Apple
Business Manager account of their own.** An Apple ID is enough. The codes are
free, and **no MDM is required** — managed distribution through an MDM is the
other option, and it is the one that would cost money and administration.

So staff and partners take exactly the same route: you send a link, they tap it,
it installs like any other app.

**Two things to confirm when you get there**, because they are the known edges:
codes are issued per licence (200 people means requesting 200 codes, which is
free but is a batch you top up), and Custom App distribution is **scoped by
country** — fine while everyone is in Malaysia, worth checking before you promise
it to a partner abroad.

I cannot promise "申请直接通过". Nobody can — approval is Apple's decision.
Choosing the Custom App route is what makes approval *likely*, because it is the
route Apple's own guideline points at for an app like this.

## 3. What is blocked, and on whom

**CORRECTED, 2026-08-03.** An earlier version of this document said the work was
"blocked on this machine" because there is no Xcode here. That was too absolute
and the owner was right to push on it.

`xcode-select -p` does return `/Library/Developer/CommandLineTools` — no Xcode,
no CocoaPods, no simulators, so nothing can be built *locally*. But local is not
the only place a build can happen:

**GitHub Actions `macos-15` runners ship with Xcode.** With **fastlane** plus an
**App Store Connect API key** (a `.p8` file), CI can sign, archive and upload
straight to App Store Connect — no local Xcode, and no interactive two-factor
prompt, which is the thing that normally forces a human at a keyboard.

That is a better fit than a local build anyway, because **this repo already works
that way**. The API key becomes three GitHub secrets —
`APP_STORE_CONNECT_API_KEY_ID`, `..._ISSUER_ID`, `..._KEY` — exactly the shape
`secrets.DATABASE_URL` already has. Signing certificates go through
`fastlane match`, which keeps them encrypted in a private repo the runner checks
out.

**The credential boundary stays exactly where it was, and it is a good one.** You
generate the key in App Store Connect and paste it into GitHub secrets yourself.
I never see it, the same way I never see the database DSN.

Installing Xcode locally is still worth doing eventually — iterating on a native
plugin against CI alone is slow — but it is **not on the critical path** and it
should not hold anything up.

**Blocked on you, and not delegable.** Every step below marked **[owner]** needs
your Apple ID, your company's legal details, or a payment card. I do not handle
credentials, and I will not ask you to paste any here.

---

## The actual steps

### Phase 0 — decided

Audience: staff **and** external partners (3PL, dealers).
Channel: **Custom App via Apple Business Manager, redemption-code link.**

### Phase 1 — accounts (days to weeks, [owner])

**STATUS, 2026-08-06: D-U-N-S request SUBMITTED.** Via Apple's lookup form,
signed in as the owner's Apple ID (`weisiang329@gmail.com` — the company-Apple-ID
question below is NOT yet settled by this; a D-U-N-S belongs to the company, not
the Apple ID that requested it). D&B had no existing record for the company, so a
new request went in with the SSM particulars: HOUZS CENTURY SDN. BHD.,
202201031135 (1476832-W), registered address 42-1, Jalan Prima 2, Pusat Niaga
Metro Prima Kepong, 52100 Kuala Lumpur (the 19/12/2024 Section 46(3) address —
NOT the Balakong business address), phone +60 11-1888 8289. Confirmation email
and the number go to `hello@houzscentury.com`; up to 5 business days. D&B may
telephone the listed number to verify — someone should answer it.

**0. The company Apple ID comes FIRST.** Verified by opening the page on
2026-08-03: `developer.apple.com/enroll/duns-lookup/` redirects straight to
`idmsa.apple.com` — **the D-U-N-S lookup itself is behind an Apple sign-in.** An
earlier version of this document had the Apple ID as step 2, which would have had
the owner sitting at a lookup form he could not reach.

Create it on a **company-domain address** (`it@houzscentury.com`), never a
personal Apple ID or a Gmail: this identity becomes the **Account Holder**, the
single owner of the developer account, and moving it later is painful. Turn on
two-factor authentication — Apple requires it.

1. **D-U-N-S number** — free, requested through Apple's own lookup page once
   signed in (it both searches and requests). Up to 5 business days. The legal
   name and address must match the SSM certificate **exactly**; a mismatch is the
   most common cause of a wasted week.
2. **Apple Developer Program**, organisation enrollment — USD 99/year. Choose
   **Organization**, not Individual — the choice cannot be changed later. Requires
   the D-U-N-S, the legal entity name, and a declaration that you have authority
   to bind the company. Review takes a day to about a week, and **Apple often
   telephones the company's publicly listed number to verify** — make sure
   somebody there is expecting the call.
3. **Apple Business Manager** account for Houzs Century (`business.apple.com`,
   free, same D-U-N-S), then link it to the Developer account under Settings →
   Apps and Books. This is what makes Custom App distribution and redemption
   codes possible.
4. In App Store Connect, create the app record and note its **Team ID** and
   **bundle identifier** (suggest `com.houzscentury.erp`).

Nothing technical can proceed to submission before this exists.

### Phase 2 — the native shell (mine; CI builds it, not this Mac)

Capacitor is the right wrapper for a Vite SPA — a thin native host with a plugin
bridge, leaving the web build as it is today.

Built on a `macos-15` GitHub Actions runner with fastlane. Local Xcode optional.

Roughly:

```bash
npm --prefix frontend i -D @capacitor/cli
npm --prefix frontend i @capacitor/core @capacitor/ios
npx --prefix frontend cap init "Houzs ERP" com.houzscentury.erp --web-dir=dist
npx --prefix frontend cap add ios
```

**AN OPEN QUESTION, NOT YET DECIDED.** There are two shapes and they trade off
against each other:

| | Point at the live site (`server.url`) | Bundle the web build |
|---|---|---|
| ERP changes ship | instantly, as today | need a new build **and a new review** |
| Guideline 4.2 | worse — it is visibly a wrapper | better — the app has real content |
| Apple's attitude | dislikes remote `server.url` in App Store builds | the normal shape |
| Offline | none | possible |

The first is what an earlier draft of this document assumed without saying so.

**The phase 3 requirements largely settle it.** Once the native layer owns
background location, the Keychain and push, the app is not a wrapper whichever
way the web content is served — so the remaining question is only about release
cadence. The honest resolution is that the earlier framing confused two different
things:

- **ERP DATA** is served from the API and is live either way. Bundling changes
  nothing about it.
- **UI CODE** is what a bundle freezes. Only a change to the phone-facing screens
  needs a new build and a new review.

So bundle it. The phone surface is a small part of this repo and it does not
change weekly, while a remote `server.url` buys instant UI updates at the cost of
the review posture and of any offline capability. **Still worth confirming with
the owner before the shell is written**, because it is his release cadence.

### Phase 3 — the native subsystems (this is the real work)

**STATUS, 2026-08-06: all four are CODE-COMPLETE.** Biometric + Keychain
session (nativeSession.ts + a Security-screen toggle), background location
(native-location.ts + trip-locations-queries + Info.plist), camera (WKWebView
file inputs + purpose strings), and push (mig-pg 0266 push_devices,
routes/push.ts, services/apns.ts + pushFleetReminders.ts on the 08:00 MYT cron,
@capacitor/push-notifications in the shell, entitlements + AppDelegate
forwarding). Push ships dark until the owner adds the `APNS_TEAM_ID` /
`APNS_KEY_ID` / `APNS_PRIVATE_KEY` Worker secrets — which exist only after
enrolment. The signed-upload workflow is `.github/workflows/ios-release.yml`
(four GitHub secrets, listed in its header). The privacy policy page ships at
`https://erp.houzscentury.com/privacy` (an explicit `_redirects` rule — Pages'
clean-URL redirect otherwise feeds it to the SPA fallback; see BUG-HISTORY
2026-08-06). Remaining before submission: Apple accounts
(phase 1), the APNs key + API key secrets, screenshots, App Privacy answers,
and a demo account.

**Owner's requirement, 2026-08-03:** *"我要可以用到指纹解锁、面部解锁，然后他们的
ESS 是 permanent 的"* and *"地点access permanent camera等等"*.

That list settles Guideline 4.2 — four native capabilities is comfortably past
"minimum functionality" — but it also means **this is no longer a wrapper with a
few plugin calls.** Background location has to keep running when the WebView is
gone, the Keychain and the biometric gate are native storage, and push needs APNs
certificates. These are native subsystems, and the scope should be understood as
such before anyone commits a date.

| Capability | Why Apple accepts it | What it actually fixes here |
|---|---|---|
| **Background location** | A website cannot do it, at all | `MobileTrackingBanner`'s own comment: tracking *"stops when the trip completes or the page is backgrounded"*. A driver locking their phone stops the GPS feed today. This is a hole in a shipped feature, not a new want |
| **Biometric unlock + Keychain** | Hardware-backed secure storage | The auth token lives in **localStorage** (`lib/authToken.ts:65`). A lost phone is a logged-in session. Moving it to the iOS Keychain behind Face ID / Touch ID is a real security gain |
| **Push notifications** | Not properly available in iOS Safari | `GET /reminders` already computes the payload (§6) and nothing sends it. The app polls — see CLAUDE.md, "No WebSockets yet" |
| **Camera** | Hardware access | The mileage capture and the OCR upload go through a web file input today |

**Background location is the strongest single argument to a reviewer**, and the
only one of the four that is impossible rather than merely awkward on the web.

#### Two risks that come WITH these features

1. **Apple reviews "Always" location hard.** Fleet and delivery is a recognised
   legitimate use, so it passes — but it needs an explicit purpose string and the
   reviewer will ask what it is for. Budget a round of questions.
2. **PDPA (Malaysia).** Continuous location tracking of staff needs clear
   consent; tracking **external partners' drivers** — who are another company's
   employees, not ours — is more sensitive again. This needs a written consent
   clause in the carrier agreement. Not a legal opinion, but the gap is too large
   to leave unwritten.

#### What an app does NOT give you

Owner asked for it *"后台控制、操控啥的都比较方便，set permission 那些"*. Worth
being exact, because it affects the decision:

**Installing an app grants no additional authority over users.** Permissions are
server-side (`backend/src/services/permissions.ts`) and identical whether the ERP
is opened in Safari or in the app. What the app adds is **device capability**, not
**authorisation**.

Remote wipe, forced install, or restricting what a device may run is **MDM** — a
separate product with its own licence cost. And it cannot be applied to a 3PL
partner's personal phone: nobody enrols their own handset in another company's
device management. For external partners, server-side ACL is the only control
there will ever be, app or no app.

### Phase 4 — submission ([owner], with my help on everything but the credentials)

1. A **demo account** on production with a real role, given to App Review.
2. Privacy policy URL, support URL, App Privacy answers (this app collects staff
   names, phone numbers and IC numbers — that must be declared accurately).
3. Screenshots at the required device sizes.
4. Archive in Xcode → upload → submit for review, selecting **Custom App**
   distribution and your Apple Business Manager organisation.

**Custom Apps are still reviewed.** Going private skips the public listing, not
App Review. Around 90% of submissions are reviewed within 24 hours; complex ones
take 24–72. A rejection on a first submission is normal and is answered in the
Resolution Center, not by resubmitting blindly.

**Every version is reviewed**, not just the first — which is the strongest
practical argument for keeping the shell thin and the web content served from
`erp.houzscentury.com`: a change to the ERP ships the way it does today, and only
a change to the native layer needs a new build and a new review.

Two more hard requirements as of 2026: the build must be compiled with the
**iOS 26 SDK or later** (mandatory since 2026-04-28), and the privacy policy URL
must be live and real at submission time.

---

## The order to do it in

The three tracks are independent, so run them in parallel — the D-U-N-S wait is
the long pole and nothing technical unblocks it.

| # | Who | What | Blocks |
|---|---|---|---|
| 1 | **owner** | D-U-N-S number for Houzs Century, then Apple Developer Program (organisation), then Apple Business Manager, then link the two | everything |
| 2 | **owner** | Generate an App Store Connect API key and paste it into GitHub secrets (I never see it). Local Xcode is optional and not on the critical path | CI builds |
| 3 | **me** | The four native subsystems — background location, biometric + Keychain session, push, camera. This is the bulk of the work and the actual 4.2 answer | review, not the build |
| 4 | **me** | Capacitor shell + the macOS Actions workflow, native camera for the OCR upload, App Store Connect metadata, privacy answers, screenshots | needs 1 for signing |
| 5 | **owner** | Submit; provide a working demo account on production | needs 1–4 |

**Ship the PWA to everyone now, regardless.** It costs nothing, it needs no
approval, and it is what your staff and partners can use during the weeks that
tracks 1 and 2 take. If it turns out to be enough, you have lost nothing.

### What I cannot do, and it is not negotiable

Enrolling requires **creating/signing into an Apple account, entering a password,
and entering a payment card**. I do not do any of those three for anyone, so that
part is yours — it is a few minutes at a keyboard. Everything either side of it
is mine, including the CI that does the actual building.

### What is still genuinely uncertain

Recorded so it is not mistaken for a solved problem:

1. **Guideline 4.2 is largely answered** by the phase 3 requirements — four
   native capabilities, one of them impossible on the web. What replaces it as
   the top risk is the **"Always" location justification** and the **PDPA consent
   position** for tracking partner drivers.
2. **The bundled-vs-remote question above is undecided**, and it changes how
   often you have to submit for the rest of the app's life.
3. **The redemption-code mechanics here come from Apple's documentation, not from
   having done it.** The per-country scoping and per-licence batching are real
   but their exact friction is unverified.
4. **Whether the 3PL partners want another app at all**, rather than a link, is
   a question for them.
