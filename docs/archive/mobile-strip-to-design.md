> **ARCHIVED 2026-08-13.** The strip was carried out — `MobileLineEditor.tsx`, `MobileStockOps.tsx` and `MobileSupplierBindings.tsx` are all deleted from the tree. Current mobile surface: `docs/CODEBASE-MAP.md` §7. Kept for history; do not follow it as a current instruction.

# Mobile strip-to-design (2026-07-02)

Owner decision: mobile scope = the phone prototype (docs/mobile-prototype.html), NOT desktop.
DELETE features built beyond the design; keep only what's in the design.
Audit evidence: docs/mobile-depth-gaps.md [gone] is SCRAPPED; the authoritative verdicts are below.
The prototype's only rich editable screens are SO, PMS Project, Service Case. Every other
module is a generic read-only list+detail with non-functional Edit/Print buttons.

## DELETE (fully OUT — not in the prototype at all)
- **Doc line editing** on DO/SI/PO/GRN/PI/Sales-Return/Purchase-Return detail (add/edit/delete lines, GRN received-qty). → remove `MobileEditableLines` usage from MobileModuleDetail; DELETE file `MobileLineEditor.tsx`.
- **Create Sales Return / Purchase Invoice / Purchase Return** (convert wizard targets dr/pi/pr). → remove from MobileConvertWizard + MobileApp MODULE_TO_CONVERT. KEEP the pre-existing SO→DO / DO→SI / SO→PO / PO→GRN convert flows (those predate this + Issue-DO is in the design).
- **Print / Share PDF** on doc details. → remove from MobileModuleDetail (+ MobileSODetail if it has a standalone Print button that's not in the design — SO detail footer in design = Issue DO / Edit / Cancel only).
- **Document header Edit/Save** on generic docs (DO/SI/PO/GRN/PI/PR). → remove from MobileModuleDetail. (SO header edit via MobileNewSO stays — IN.)
- **Products create/edit**. → remove `FORM_PRODUCTS` + the `form` on the products config in MobileModuleList; products back to read-only list+detail.
- **Inventory stock ops** (adjustment / transfer / take). → DELETE file `MobileStockOps.tsx`; remove the InventoryHub + routing from MobileApp; Inventory back to read-only balances list.
- **Supplier SKU bindings** add/edit/delete. → DELETE file `MobileSupplierBindings.tsx`; remove its use in MobileModuleDetail; suppliers back to read-only.
- **PMS**: defects, project chat, sales-entry VOID, checklist submit/amend/comment, checklist add/delete item + section CRUD, finance line edit/delete + receipt upload, stock-transfer RETURN/confirm/unconfirm/delete, project create, generic attachments manager.
- **Service**: logistics scheduling CRUD, generate-PO, resolve-creditor, attachment customer-visibility, case UNARCHIVE.
- **Profile**: 2FA/TOTP, profile photo upload/remove.
- **Announcements**: edit / delete / deactivate / expiry.
- **Mail**: thread assign-to-user.

## KEEP (IN the design)
- **SO**: real SKU picker + editable line items (create/edit), SO header Edit/Save, payments — all IN (MobileNewSO / MobileSODetail / MobileSkuPicker). Do NOT touch.
- **Announcements**: audience targeting (Send-to), compose. KEEP.
- **PMS**: quick-log / new-sale buttons (functional ok), setup/dismantle DRIVER + LORRY + START-TIME, floor-plan tiles (clickable) + setup/dismantle photo uploads + stock-transfer UPLOAD, archive, checklist tick/approve, PIC, sales-attendees, payment pill — KEEP. Remove ONLY: helper field, end-time, outsource, the extra CRUD listed above.
- **Service**: full case detail + stages + sections + notes + attachments (upload) + print copies + archive + PIC — KEEP. Remove ONLY the OUT sub-actions above.
- **v4 page-check (#175)** + lifecycle cancelled-visual (#171) + reskin — KEEP.

## Method
Forward surgical removal (not git-revert — later PRs interleave the files). Remove OUT code +
clean up dangling imports/refs. Preserve IN features + all shipped SO work. Each file: `tsc -b` clean.
