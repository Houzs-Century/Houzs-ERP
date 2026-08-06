# App Store Connect — everything to paste, prepared before the account exists

Written 2026-08-06, while waiting for the D-U-N-S number. When enrolment
completes and App Store Connect opens, the app record gets created from THIS
file — nothing here should need inventing at the keyboard. Keep it in sync with
`/privacy` (the live policy) and with what the app actually does; App Review
compares all three.

## The app record

| Field | Value |
|---|---|
| Platform | iOS |
| Name | **Houzs ERP** |
| Primary language | English (U.S.) |
| Bundle ID | `com.houzscentury.erp` (create in Certificates → Identifiers first, capabilities: Push Notifications) |
| SKU | `houzs-erp-ios` |
| User access | Full Access (it is the company's own account) |

## Distribution — the decided channel

**Custom App via Apple Business Manager, redemption-code link**
(docs/ios-app-store.md, decided 2026-08-03). In App Store Connect this is
Pricing and Availability → **App Distribution Methods → Custom Apps → Apple
Business Manager**, price **Free**, with Houzs Century's own ABM organisation
ID entered. Redemption codes are then requested INSIDE Apple Business Manager
(Custom Apps → License Type = Redemption Codes), not in App Store Connect.

Prerequisite: Apple Business Manager account (business.apple.com, free, same
D-U-N-S) linked to the developer account — do this while the first build
uploads, not after.

## Version information (1.0)

**Promotional text** (170 chars max, editable without review):

> The Houzs Century ERP, in your pocket: deliveries, approvals, scanning and
> fleet — with Face ID unlock and live trip tracking.

**Description:**

> Houzs ERP is the internal operations app for Houzs Century Sdn. Bhd. staff
> and authorised partners (delivery carriers and dealers).
>
> WHAT IT DOES
> - Delivery runs: assigned trips, live location sharing with dispatch while a
>   run is active, proof-of-delivery photos and signatures
> - Sales: orders, approvals and amendments on the move
> - Scanning: document and odometer capture with the camera
> - Fleet: vehicle compliance reminders (road tax, insurance, PUSPAKOM) as
>   push notifications
> - Security: unlock with Face ID or Touch ID; your session stays in the
>   iPhone's secure Keychain
>
> ACCESS
> This app requires a staff or partner account issued by Houzs Century. There
> is no self-service sign-up. If you have not been given an account, the app
> will not be usable — contact your Houzs Century coordinator.
>
> Location is shared only during an assigned delivery trip and stops when the
> trip is completed. See our privacy policy for exactly what is collected and
> why: https://erp.houzscentury.com/privacy

**Keywords** (100 chars): `erp,delivery,fleet,houzs,warehouse,sales order,pod,logistics,furniture`

**Support URL:** `https://erp.houzscentury.com/track`
**Marketing URL:** (leave empty)
**Privacy Policy URL:** `https://erp.houzscentury.com/privacy`
**Copyright:** `© 2026 Houzs Century Sdn. Bhd.`

**Category:** Primary Business; Secondary Productivity.
**Age rating questionnaire:** every content question NO → rating 4+.

## App Privacy (the nutrition label — answer EXACTLY this)

Data collection: **Yes, we collect data.**

| ASC data type | Collected? | Linked to identity? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Contact Info → Name | Yes | Yes | No | App Functionality |
| Contact Info → Email Address | Yes | Yes | No | App Functionality |
| Contact Info → Phone Number | Yes | Yes | No | App Functionality |
| Identifiers → User ID | Yes | Yes | No | App Functionality |
| Location → Precise Location | Yes | Yes | No | App Functionality |
| User Content → Photos or Videos | Yes | Yes | No | App Functionality |
| User Content → Other User Content (orders, cases, messages) | Yes | Yes | No | App Functionality |
| Sensitive Info (IC number, in employment records) | Yes | Yes | No | App Functionality |
| Diagnostics → Crash Data / Performance Data | Yes | No | No | App Functionality |

Everything else: Not collected. **"Used for tracking" is NO on every row** — no
ads, no data brokers, no cross-app identifiers (this matches the policy's "does
not track you across other companies' apps" sentence; keep them agreeing).
Biometric data is NOT collected (Face ID stays on-device in the Secure
Enclave) — do not declare it.

## App Review Information

- **Sign-in required: YES.** Provide the demo account (below).
- **Notes to reviewer** (paste as-is, fill the account):

> This is the internal ERP of Houzs Century Sdn. Bhd. (furniture manufacturing
> and retail, Malaysia), distributed as a Custom App to our staff and
> authorised delivery partners. There is no public sign-up.
>
> The demo account below is a real role on our production system with access
> to the delivery-driver and sales surfaces.
>
> Native capabilities to verify: (1) Face ID/Touch ID unlock — enable it under
> Profile → Password & security after signing in; (2) background location —
> starts only when a delivery trip is assigned and started, and the purpose
> string explains the dispatch/customer sharing; (3) camera — Proof of
> Delivery and document scanning; (4) push notifications — daily fleet
> compliance reminders (the demo account holds the fleet permission).
>
> Privacy policy: https://erp.houzscentury.com/privacy

- **Demo account:** create `appreview@houzscentury.com` on production JUST
  BEFORE submission, with a role granting: mobile access, `fleet.read`, driver
  trip surface, one seeded demo trip, and NO finance permissions. Rotate the
  password after approval; disable between review cycles. (Do not create it
  earlier — an unused live credential is a liability, not a convenience.)

## Screenshots (blocked until a signed build runs on a device/simulator)

Required: 6.9" (iPhone 16 Pro Max class) and 6.5" sets, portrait. Plan: Login
(with the Face ID toggle visible), Delivery run with tracking banner, POD
capture, Sales order list, Fleet Health. Take them from the real app on
TestFlight — App Review rejects screenshots that don't match the binary; the
mobile-web surface is identical in content but the status bar / safe areas
would differ.

## The submission-day checklist, in order

1. Certificates → Identifiers: create `com.houzscentury.erp` with Push
   Notifications capability.
2. Keys: create an **App Store Connect API key** (App Manager role) → four
   GitHub secrets (`APPLE_TEAM_ID`, `APP_STORE_CONNECT_API_KEY_ID`,
   `..._ISSUER_ID`, `..._KEY`) → run **iOS release (signed upload)**.
3. Keys → **APNs auth key** (.p8) → three Worker secrets (`APNS_TEAM_ID`,
   `APNS_KEY_ID`, `APNS_PRIVATE_KEY`) via `wrangler secret put` — push starts
   the next 08:00 MYT after this lands.
4. Create the app record from this file; TestFlight the uploaded build on the
   owner's phone; take screenshots.
5. Apple Business Manager: link, set Custom App availability.
6. Demo account + review notes; submit. Expect 24–72h; answer rejections in
   Resolution Center, never resubmit blind.
