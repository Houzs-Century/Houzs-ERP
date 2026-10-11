# 可恢复备份 — 删除 17 行 qty-0 DO 行 (2026-09-16)

老板 2026-09-16「纠正回来」批准：这些是错误操作（没出货却把 SO 行 convert 成 DO、再把数量改成 0），
迁移时从 AutoCount 逐行照抄进来。删掉后对应 SO 行正确变回「未送、可重开」。

**安全前提（已核）**：每张 DO 都还有真实送货行（删后 `remaining>0`，完整性锁 `fn_do_line_integrity_lock` 不触发）；
这 17 行无发票/退货引用（SET NULL 无副作用）；删 DO 行不触发 AutoCount 写回。

## 已删的 17 行（qty 全为 0）

| DO | SO | item_code | linked_ac_dtlkey | do_item_id |
|---|---|---|---|---|
| HC-DO-000608 | HC-SO-000524 | SIMPLE-(Q) | 84756 | 61e99fe2-ad97-4d4b-9ace-717a2fe13041 |
| HC-DO-000608 | HC-SO-000524 | TRION (A)-(K) | 84752 | 14dbccfa-7e93-4245-83eb-f9efd64b75bc |
| HC-DO-000608 | HC-SO-000524 | VALKYRIE-(Q) | 84754 | b58b8093-e077-403f-a4a2-97d8d171f405 |
| HC-DO-001526 | HC-SO-001030 | AK-SK CT MEM FOAM PIL | 193869 | e8ed8ad8-6181-49c3-b1e7-768b246565b7 |
| HC-DO-001953 | HC-SO-003186 | AK-SLEEP ESSENTIAL 7 HOLES | 234486 | 72ce8a4a-452d-4a58-a442-271febf20324 |
| HC-DO-001953 | HC-SO-003186 | AKEMI ULTIMATE MATT (K) | 234484 | bb1ee4ab-6d09-4169-86da-f534a8b68794 |
| HC-DO-002456 | HC-SO-000751 | BACKSHIRE MATT (K) | 494899 | de63a50c-c1d5-4bf8-8b82-601871c4b1dc |
| HC-DO-002544 | HC-SO-001319 | HB109M-CC | 282777 | bdcc099b-53f9-42fc-9d64-1cc39709ecb7 |
| HC-DO-002544 | HC-SO-001319 | HB109NL | 282775 | a86ae0fe-7752-48e4-b18f-cd0411e38d63 |
| HC-DO-002817 | HC-SO-002792 | AK-CS AIRLOFT COMFY PIL | 301042 | aaf26458-ab8b-4f74-b573-27d759787147 |
| HC-DO-002817 | HC-SO-002792 | AKEMI ULTIMATE MATT (K) | 301040 | 9d2fe304-13af-46c1-8ef4-9cae06522268 |
| HC-DO-002984 | HC-SO-000951 | AKEMI ULTIMATE MATT (K) | 313219 | d03c0a0c-bec5-4c94-88ea-7a6c21ef4ee2 |
| HC-DO-003871 | HC-SO-003977 | AERO-MP (K) | 378007 | cb1da802-4cc8-446b-8ddc-de33bfd9efc6 |
| HC-DO-004574 | HC-SO-000013 | DIVAN ONLY-(K) | 437219 | 1ad0f57f-2722-40e2-9ccb-e36da86a1682 |
| HC-DO-008624 | HC-SO-008652 | AKEMI IMMORTAL MATT (Q) | 715011 | d86abbbe-e6fa-4849-856a-19340d1c71ea |
| HC-DO-008833 | HC-SO-009600 | AMN-SOFA PILLOW | 724419 | 65d9a830-076f-41f4-ab37-37bbca7ebed6 |
| HC-DO-011518 | HC-SO-012828 | DISPOSE | 924642 | 924642 → f4382559-efcc-46c2-9ed6-272e3c084a82 |

12 张 DO、~14 张 SO。完整行数据（含 variants/description2/photo_urls）在本 session DELETE 的 RETURNING 输出里。
`linked_ac_dtlkey` 可回溯到 AutoCount 原行。恢复＝按上表 + 完整行重新 INSERT（但那是错误数据，恢复仅供审计/回退）。

## 复核
删后：全系统 qty<=0 的 DO 行应为 0；各 DO 保留真实行；对应 SO 行不再挂 DO（正确显示未送）。
