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

1. **Apple Developer Program**, organisation enrollment — USD 99/year.
   Requires a **D-U-N-S number** for Houzs Century (free from Dun & Bradstreet,
   typically 5 business days), your legal entity name exactly as registered, and
   authority to bind the company. Enrollment review takes a few days.
2. **Apple Business Manager** account for Houzs Century, and link it to the
   Developer account. This is what makes private distribution possible.
3. In App Store Connect, create the app record and note its **Team ID** and
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
The second is more likely to pass review and is probably right, but it means
accepting that every ERP release the phone surface depends on becomes a
submission. **Decide this before writing the shell, not after.**

### Phase 3 — earn the 4.2 pass (real work, not packaging)

A shell around a website gets rejected. The features that make it a genuine app —
and which are useful regardless — are already half-present in this codebase:

| Native capability | Why Apple accepts it | State here |
|---|---|---|
| **Push notifications** | Cannot be done properly in iOS Safari | Not built. The app polls (see CLAUDE.md, "No WebSockets yet") |
| **Camera** | Hardware access | The mobile mileage capture and OCR upload already take photos — through the web file input, would move to the native plugin |
| **Offline** | Works without a network | `sw.js` exists; genuine offline capture does not |
| **Biometric unlock** | Face ID / Touch ID | Not built |

Push notifications are the strongest single argument to a reviewer, and the fleet
module already has the computation a push would ride on (`GET /reminders` — see
`docs/modules/fleet-maintenance.md` §6).

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
| 3 | **me** | Push notifications — the 4.2 answer, and the thing `GET /reminders` has been computing with nowhere to send it | review, not the build |
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

1. **Guideline 4.2 is the real risk and no amount of tooling removes it.** Every
   account, key and pipeline can be perfect and a bare wrapper still gets
   rejected. This is what phase 3 is for.
2. **The bundled-vs-remote question above is undecided**, and it changes how
   often you have to submit for the rest of the app's life.
3. **The redemption-code mechanics here come from Apple's documentation, not from
   having done it.** The per-country scoping and per-licence batching are real
   but their exact friction is unverified.
4. **Whether the 3PL partners want another app at all**, rather than a link, is
   a question for them.
