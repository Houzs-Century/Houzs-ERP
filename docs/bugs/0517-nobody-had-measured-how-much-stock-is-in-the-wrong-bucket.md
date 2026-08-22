## Nobody had measured how much stock is already in the wrong bucket [high]

<!-- area: Inventory, costing, FIFO -->

**白话.** `docs/bugs/0514` 修好了「以后不会再进错桶」，但**已经进去的没有搬**。老板
的指示很清楚：先量，他再决定怎么补。这支就是那个量测 —— **它不搬任何东西**。

它问的不是「这一行看起来像不像沙发」（那是把猜测包装成规则），而是唯一能决定事情的
那个问题：**这一行如果类别是对的，钥匙会不会不一样？**

**Symptom.** `docs/bugs/0514` 的最后一段写着「已经用空钥匙进去的库存不会自动搬 —
要先量有多少笔，那是老板的决定」。这个数字一直是 UNKNOWN，而 UNKNOWN 的东西没有人
能拿来做决定。

**Root cause (traced, in 0514).** `item_group` 空掉 → `computeVariantKey` 只用
料号 → 货进「没分类」的桶 → 任何一张沙发订单都拿不到。写入路径已修（PR #2660）；
帐本里已经写好的那些是不可变的。

**Fix.** `backend/scripts/probe-misbucketed-stock.mjs` +
`.github/workflows/probe-misbucketed-stock.yml`（唯读，手动触发）。三节：

1. **不带任何条件的普查** —— 每张表几行。放在最前面，因为一个「0 笔受影响」的答案
   和一个「这张表根本读不到」的答案长得一模一样。这条是上一支 probe 用一次绿色的
   假答案换来的（`docs/bugs/0511`、`0512`）。
2. **钥匙会变的行** —— 两边都用 `src/` 里**真正的** `computeVariantKey` 算：一次
   用存下来的类别，一次用产品主档的类别。自己抄一份规则去量自己，只会量出自己想看的
   答案。
3. **两个不同的族群，分开数**：
   - 钥匙是空的、但主档说它是沙发／床架的**在库存货**（件数＋金额）
   - **没有批号的沙发** —— 这不是进错桶，是进对了桶还是动不了：分配和出货都只看
     有批号的批次（`sofa-set-coverage.ts:65`），而批号只有在收货行接到采购单行时
     才盖得上去（`grns.ts:565`）。不同的病，不同的补法。

**刻意不做的.** 它不决定怎么补。就地换钥匙、还是开一对冲销调整，是两种不同的取舍，
稽核痕迹也不同 —— 那是老板的决定，而他需要先有这些数字。

**Ref.** UNTESTED against a database — 本机没有连线字串，合并后第一次 dispatch 就是
第一次真的执行。表名和栏位都对着 `migrations-pg` 查过，`node --check` 过，没有
`DATABASE_URL` 的那条路跑过并且退出码 1。
