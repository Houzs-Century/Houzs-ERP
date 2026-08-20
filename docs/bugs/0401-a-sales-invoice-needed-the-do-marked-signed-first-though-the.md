## A Sales Invoice needed the DO "marked signed" first, though the server never required it [medium]

<!-- area: Delivery, DO, returns -->

**白话.** 开销售发票(Sales Invoice)之前,系统逼你先把交货单(DO)按一下「Mark
signed」—— 但后台其实从来没有这个要求。老板 2026-08-19 指出这一步多余,拿掉。现在
只要是已确认的交货单(不是草稿、不是已取消)就能直接开发票,而且两间公司看到的一样。
「Mark signed」按钮保留,当作可选的「已签收」记录,不再是硬门槛。

**Symptom.** In the DO quick-view, a DISPATCHED / IN_TRANSIT delivery order showed
"Transfer to Sales Invoice" DISABLED with "Mark this delivery order signed first —
a Sales Invoice can only be raised once it is signed or delivered." Owner
2026-08-19, on a 2990 DO: this DO does not need mark-signed — remove it.

**Root cause (traced, PROVEN by reading both sides).** The signed/delivered
requirement was FRONTEND-ONLY. `siTransferBlockReason`
(`frontend/src/vendor/scm/lib/do-next-step.ts`) blocked `loaded` / `dispatched` /
`in_transit`. The server that actually creates the SI from a DO
(`backend/src/scm/routes/sales-invoices.ts:1483`) refuses ONLY a CANCELLED source
(`do_cancelled`, 409) — it never checked signed/delivered. So the gate had no
backend rule behind it, and the goods' stock was already deducted at dispatch.
Removing the front-end gate exposes an action the server always permitted; it
changes no stock or money logic.

**Fix.** `SI_TRANSFERABLE_DO_STATUSES` = `loaded, dispatched, in_transit, signed,
delivered` (every confirmed DO). `siTransferBlockReason` returns null for those;
DRAFT still needs Confirm (no committed lines/stock yet); CANCELLED still blocked;
INVOICED / unrecognised → the generic sentence. Because `siTransferBlockReason` is
the ONE shared function all four surfaces use (desktop detail, desktop phone view,
list quick-view drawer, native mobile shell — `MobileModuleDetail.tsx:1362`), the
change reaches desktop and mobile together. "Mark signed" (`doAdvanceStep`) is
untouched and stays as an OPTIONAL delivery-tracking step. `do-next-step.test.ts`
updated to pin the new rule (12 pass).

**Ref.** this PR, 2026-08-19.
