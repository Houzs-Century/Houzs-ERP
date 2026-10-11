# 可恢复备份 — 清日期 10 张「2026-09 刚过期」部分送货单 (2026-09-15)

老板 2026-09-15「继续」批准：接着清剩下 10 张 2026-09 刚过期的部分送货单
（ERP 已有真实送货行）。清 processing/customer_delivery/未送行 item 日期，退出 MRP、
可重新 proceed；已送行保留。清日期**可逆**——下表是清前的值。

| doc_no | status | version | processing | delivery | 有日期的行 |
|---|---|---|---|---|---|
| HC-SO-013141 | READY_TO_SHIP | 4 | 2026-08-05 | 2026-09-04 | 9 |
| HC-SO-012819 | READY_TO_SHIP | 4 | 2026-07-15 | 2026-09-05 | 5 |
| HC-SO-012747 | READY_TO_SHIP | 4 | 2026-07-13 | 2026-09-05 | 6 |
| HC-SO-012885 | READY_TO_SHIP | 2 | 2026-08-12 | 2026-09-08 | 5 |
| HC-SO-011983 | READY_TO_SHIP | 4 | 2026-07-29 | 2026-09-08 | 5 |
| HC-SO-011266 | READY_TO_SHIP | 2 | 2026-04-14 | 2026-09-08 | 3 |
| HC-SO-013129 | READY_TO_SHIP | 2 | 2026-08-22 | 2026-09-08 | 4 |
| HC-SO-012286 | READY_TO_SHIP | 4 | 2026-08-11 | 2026-09-11 | 4 |
| HC-SO-013064 | CONFIRMED | 7 | 2026-08-02 | 2026-09-12 | 8 |
| HC-SO-012025 | IN_PRODUCTION | 1 | 2026-05-27 | 2026-09-12 | 8 |

## 恢复方法
逐单把 processing / delivery 写回；已送行、付款、PO、lines 未动。
