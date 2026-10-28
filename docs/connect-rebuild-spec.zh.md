# Connect 重建规格（WS-A 发送端）

> **决定 B（2026-10-03）**：Connect 的客户消息流程 **重建一套**，不沿用之前从 Seampify 迁过来的 11 条草稿。
> 一次性吸收：**Seampify 最新内容 + 接 ERP + 分公司变量 + 新费用/锁定规则**。
> 状态：WS-A 发送端目前暂停；本规格是重建时的唯一依据，等启动。所有公司专属值、规则、设计选择已敲定（见 §5 / §7 / §10）。

---

## 0. 一句话

把客户「送货日期确认 / 改期 / 催单 / 余额 / 司机信息」这套 WhatsApp 对话，从第三方 **Seampify** 搬到自建的 **Connect**（chat.houzscentury.com），并把触发和回调接到 **ERP**，弃掉中间的 Google Sheet / Apps Script。

---

## 1. 现状（重建前）

| 组件 | 说明 |
|---|---|
| **Seampify** | 第三方 WhatsApp SaaS，**现在还在跑 / 天天编辑**（~33 条 automation，含大量旧版 / 测试 / webhook 接收版）。连旧 Google Sheet + Apps Script。 |
| **Connect** | 自建：`houzs-connect`（Next.js / Cloudflare Workers，和 ERP **同一个 Supabase** 的 `connect` schema）。WhatsApp Cloud API 已接 Houzs 号 **+60 11-1110 8822**。有 **11 条**从 Seampify 迁来的草稿，**全 DRAFT / 未启用**，`call_rest_api` 还指旧 Apps Script。 |
| **ERP 侧** | `backend/src/services/connect.ts` 已建（#4336），`delivery-messages.ts` 的 `/send` 已切 Connect 但 **INERT**（`CONNECT_WEBHOOK_URL` / `CONNECT_WEBHOOK_KEY` 未设 → 503）。入站 `chatCallback.ts`（`/api/chat-callback`）已上线，`CHAT_CALLBACK_KEY` 已设（09-27）。 |

---

## 2. 架构（重建后）

- 客户消息改由 **Connect 发**（WhatsApp Cloud API）。
- **ERP → Connect**：`POST /api/webhooks/erp` `{ phone, name, automation, attributes:{...} }` → upsert 联系人 + 属性 → 按 `automation` 名触发对应流程。带 `X-Connect-Key`。
- **Connect → ERP**：客户点 Confirm/Amend → Connect 的 `call_rest_api` → ERP `/api/chat-callback`（`X-Chat-Key`），记录为**请求**（`applied:false`，真正改单由人工在看板落地）。
- **弃掉** Google Sheet / Apps Script：`call_rest_api` 不再指 `script.google.com`。
- **2990**：不开新号。`resolveCompany(undefined)` = 最老的公司 = Houzs，所以 2990 订单默认走 Houzs 号 + `hc_order_*` 模板；发送时 ERP 可显式传 `companySlug: "houzs-century"` 更稳。

---

## 3. 要重建的流程（基于 Seampify 现版 + 本规格改动）

- **New Delivery**（Single Order + 多订单：order_total 路由 → 每 3 张一批 → Confirm All / 逐张 Amend → 循环 → 余额/住宅/处理尾段）
- **New Amend**（改期版，多订单，同样的批次/确认/改期逻辑）
- **Reminders 1 / 2 / 3**（催单，模板已含订单号；**先手动发，跑顺后自动**，见 §10）
- **单次发送**：Confirmation、Balance（收款）、Driver Info、Postpone
- **辅助**：Opt-in/out、After-hours away、Reassign、Replied-Check

> 不搬 Seampify 的「webhook 接收版」那一整组（New Delivery HC / New Amend HC … Webhook Received）——那部分改由 **ERP 直接触发** `/api/webhooks/erp`。

---

## 4. 消息内容

以 **Seampify 现版**为准（逐条见 Automation Review）。两处必改：

- **必改 ①：确认感谢语**（三条流程都换成）
  `Thank you for confirming! We will contact you again exactly *one* day before your delivery to confirm the driver information and expected arrival time.`
  （旧版是「a few days before / the exact time」）
- **必改 ②：Property Details 表单**
  确认后用一个 WhatsApp **表单**一次收 `house_type / new_house / disposal / disposal_item`（读 `callback_payload_*`），取代按钮一步步问。需新节点能力（见 §6）。**三条流程都用表单（已定 2026-10-03）**。

---

## 5. 公司专属值 → 做成变量（ERP 按公司填）

| 值 | Houzs | 2990 | 处理 |
|---|---|---|---|
| 处理费（disposal） | RM50 | RM80 | **变量** |
| 收款银行 | Maybank · Houzs Century Sdn Bhd · 5644 1861 0346 | Hong Leong Bank · 2990 Home Sdn Bhd · 2360 0602 788 | **变量** |
| 署名 | Houzs Century | 2990s Home | **变量** |
| 仓储费 RM150/月 | 同 | 同 | 不变 |
| 免费床架促销 | 同 | 同 | 不变（署名随公司，如「Houzs Century Special」→「2990s Home Special」） |

> 收款账号是公司收款信息（印在给客户的余额消息里）。做成变量由 ERP 按公司填入余额消息的银行块，不写死在 Connect 模板。

---

## 6. 新能力（`houzs-connect` 程序开发，不是流程配置）

Connect 现有节点：`trigger / send_text / ask_buttons / collect_input / criteria_router / set_attribute / add_tag / delay / call_rest_api / google_sheets`。缺两样：

- **WhatsApp 表单节点**（Property Details form）—— 现在只有按钮 + 收文本，没有结构化表单。
- **Jump-to-automation 节点**（跳转到另一条 automation）—— 现在没有。

→ 这两个要改 Connect 代码才能支持，是开发项。

---

## 7. 新规则（Seampify 上没有，重建时加）

- **Late Cancellation Fee RM150**：客户**确认交货日期后** —— 提前 3 天以上改期免费；**确认后 3 天内任何变动（改期或取消），或未付款被取消 → RM150**。写进改期/确认相关文案。与「仓储费 RM150/月（推迟超 30 天）」是两笔不同费用。
- **确认后锁定文案（定稿）**：确认后再点 Amend → 查 `button_status=Confirm` → 回下面这句并停住，不重开选日期、不自动改日期：
  > Your delivery date is already confirmed and locked in. 🔒
  > To make any changes, please reply here and our team will assist you — kindly note that a change within 3 days of the confirmed date may incur an RM150 late cancellation fee.
  > Thank you for your understanding!

  前提：确认那一步必须**可靠写入** `button_status=Confirm`，之后任何 Amend 才必被拒。

---

## 8. ERP 侧要做

- 设 `CONNECT_WEBHOOK_URL=https://chat.houzscentury.com` + `CONNECT_WEBHOOK_KEY`（Connect worker 和 ERP worker **同值**）→ 解除 `/send` 的 503。
- `connect.ts` 的 `buildDeliveryFollowUp` 已 bundle `ref_1..N / delivery_date_1..N / brand_1..N + order_total + full_name`；要加：**per-company**（处理费 / 银行 / 署名）、**postage**（`delivery_address` + `customer_phone`）、新费用相关字段。
- `CHAT_CALLBACK_KEY` 已设；`ref` 用 ERP `doc_no`（如 HC-SO-011427），不是 AutoCount `linked_ac_docno`，否则 404。

---

## 9. 启用 & 测试

1. Connect 新流程 **Publish**（现全 DRAFT）。
2. 先发**单订单**到内部号测试；多订单 / 表单待模板 + 流程齐。
3. 确认 ERP `/send` 不再 503；`chat-callback` 回 `{ok:true, recorded:true, applied:false}`。
4. 确认 2990 订单默认走 Houzs 号 + 正确的 per-company 值。

---

## 10. 设计选择（已定 2026-10-03）

- **改期原因步骤 → 保留**：客户改期先选原因（Renovation Delay / Date Unavailable）再选日期，原因进 `amend_date_reason`。
- **Property 表单 → 三条都用**：Single + Tag + Amend 都改成一个表单收 住宅 / 用途 / 处理。
- **催单时机 → 先手动**：员工按需发，跑顺了再切自动（省钱 + 避免乱发）。

---

*配套参考：Automation Review（消息逐条 + 公司专属值 + 费用 + 锁定 + Seampify↔Connect 漂移清单）；三个对话模拟器（单一 / 多订单改期 / 多订单确认）。这些是 review 用的 Artifact，本文件是仓库里的开发依据。*
