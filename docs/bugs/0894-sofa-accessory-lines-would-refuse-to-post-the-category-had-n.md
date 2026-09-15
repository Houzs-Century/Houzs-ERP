## Sofa Accessory lines would refuse to post: the category had no accounting item group [high]

**Symptom.** None seen by staff yet. Found while planning the owner's move of
the custom pillows and seven cushion/arm-rest models to Sofa Accessory
(2026-09-14): the first purchase or sales invoice carrying such a line would have
been refused at posting with "FABRIC_ACCESSORY is not bound to a purchase
account for this company".

**Root cause (traced).** An invoice posts each line to the account bound to the
line's product group — `splitByItemGroup` in `backend/src/acc/item-group-split.ts`
reads `scm.acc_item_group_accounts` by `upper(item_group)` and refuses any group
with no binding. Migration `20260914T1800_mfg_category_fabric_accessory.sql`
(PR #3857) added `FABRIC_ACCESSORY` to both category enums directly, copying the
DINING precedent, and so skipped `scm.acc_register_item_group`, the path that
also registers the group in `scm.acc_item_groups`. The enum knew the category;
the ledger registry did not. No production line carried the group yet (probe
run 34840719699: every line of these SKUs is still `accessory`), so nothing was
refused.

**Fix.** Migration `20260914T2000_acc_item_group_fabric_accessory.sql` registers
the group as "Sofa Accessory" and binds it, per company, to the same four
accounts ACCESSORY is bound to — the books stay exactly as they are today, since
every line moving to the new group was an Accessory. Rebindable on Accounting ->
Item Groups.

**Lesson.** A new product category has THREE homes, not two: the enums, the
code lists, and the accounting registry. `acc_register_item_group` exists to do
the first and third in one call; a migration that adds a category should use it
or insert the registry row itself.

**Ref.** fix/sofa-accessory-label, 2026-09-14.
