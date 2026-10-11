# 可恢复备份 — Cancel 6 张「AutoCount 全送、ERP 无 DO」的 SO (2026-09-15)

老板 2026-09-15 决定：这 6 张在 AutoCount 已整张送货完成（账本每行 BOOK_DELIVERED），
ERP 从未开出对应 DO。为免补 DO 重复扣库存，改用 **Cancel**（不删），保留付款/PO/历史，
使其退出 MRP。付款 method 全是 `imported`（08-28 迁移拷贝，AutoCount 有原件）。

## Cancel 前状态（恢复用）

| doc_no | 原 status | version | processing | delivery | 客户 | AC链接 | 付款(RM) | payment_id |
|---|---|---|---|---|---|---|---|---|
| HC-SO-003945 | READY_TO_SHIP | 2 | 2026-06-16 | 2026-09-01 | LEE LEE | SO-003945 | 3,200 | 85d98d5c-a489-4f66-9f6e-1d795d0e31cc |
| HC-SO-007144 | READY_TO_SHIP | 2 | 2026-07-22 | 2026-09-07 | sum keng cheng | SO-007144 | 2,199 | 1f4bd183-2113-438f-baf2-03b85227c712 |
| HC-SO-011850 | READY_TO_SHIP | 4 | 2026-05-15 | 2026-09-04 | Dr Ranjeet Singh | SO-011850 | 25,000 | a143b5de-cbc3-49a9-8584-b16742831f39 |
| HC-SO-012629 | READY_TO_SHIP | 2 | 2026-07-30 | 2026-09-04 | KONG KIT YING | SO-012629 | 4,190 | 7fc8b366-7b18-4e3e-b115-e5fd5680521a |
| HC-SO-013181 | READY_TO_SHIP | 4 | 2026-08-11 | 2026-09-08 | Saw Siew Chen | SO-013181 | 8,099 | 26cfc72c-4a22-499c-828d-279c3527ed08 |
| HC-SO-013276 | READY_TO_SHIP | 4 | 2026-08-17→交期09-11 | 2026-09-11 | JRENE KOO | SO-013276 | 2,000 | d645c0f2-a48a-4cd7-8bec-f4aee4b78e08 |

## 恢复方法（若需回退）

```sql
UPDATE scm.mfg_sales_orders SET status='READY_TO_SHIP', version=version+1, updated_at=now()
WHERE company_id=1 AND doc_no = ANY(ARRAY['HC-SO-003945','HC-SO-007144','HC-SO-011850','HC-SO-012629','HC-SO-013181','HC-SO-013276']);
DELETE FROM scm.mfg_so_audit_log WHERE so_doc_no = ANY(ARRAY['HC-SO-003945','HC-SO-007144','HC-SO-011850','HC-SO-012629','HC-SO-013181','HC-SO-013276']) AND action='CANCELLED' AND source='script' AND created_at::date='2026-09-15';
```

付款/PO/lines 在 Cancel 时**未删**（Cancel ≠ Delete），无需恢复。
