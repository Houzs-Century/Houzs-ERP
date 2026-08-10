/* ============================================================================
   在 AutoCount 主机上跑这一段,把「已收货、但客人还没拿到货」的 PO 导出来。

   为什么要补:现在用的 ac-outstanding-po.json.gz 是按「PO 还没收货」筛的,
   所以整张已经收完货的 PO 根本没被导出来。但按 owner 的规则,只要它对应的
   沙发 SO 还没转成 DO,这张 PO 就必须进 ERP —— 货已经在仓,客人还没拿到。

   目前缺口:沙发 61 行 / 57 张 SO(清单见「待补PO的沙发单.csv」)。

   用法:
     1. 在 AutoCount 主机用 SSMS 连上 AED_HOUZS 这个 book
     2. 整段执行,右键结果 → Save Results As → JSON(或 CSV 也行)
     3. 把档案发回来,我直接接到现有的导入通道上,不用改任何程式

   注意:这只是「读」,不会改 AutoCount 任何资料。
   ============================================================================ */

USE AED_HOUZS;

SELECT
    po.DocKey,
    po.DocNo,
    po.DocDate,
    po.CreditorCode,
    cr.CompanyName            AS CreditorName,
    po.[Ref],
    pod.DtlKey,
    pod.ItemCode,
    pod.Description,
    pod.Desc2,
    pod.Qty,
    pod.TransferedQty,        -- 已收货数量(可以等于 Qty,照样要)
    pod.UnitPrice,
    pod.Location,
    pod.DeliveryDate,
    pod.FromDocNo             AS FromSODocList,
    pod.FromDtlKey            AS FromSODtlKey
FROM dbo.PO po
JOIN dbo.PODTL pod  ON pod.DocKey = po.DocKey
LEFT JOIN dbo.Creditor cr ON cr.AccNo = po.CreditorCode
WHERE po.Cancelled <> 'T'
  /* 关键条件:这张 PO 是为了某一张「还没转 DO」的 SO 明细开的 —— 不管 PO 自己
     收货了没有。SO 那边的判断跟 ERP 完全一致:SO 明细 Qty > TransferedQty。  */
  AND EXISTS (
        SELECT 1
        FROM dbo.SODTL sd
        JOIN dbo.SO so ON so.DocKey = sd.DocKey
        WHERE so.Cancelled <> 'T'
          AND sd.Qty > ISNULL(sd.TransferedQty, 0)     -- SO 还没送货 = 仍 outstanding
          AND (
                sd.DtlKey = pod.FromDtlKey                       -- PO 行直接连到 SO 行
             OR CHARINDEX(so.DocNo, ISNULL(pod.FromDocNo, '')) > 0   -- 或只记了 SO 单号
          )
      )
ORDER BY po.DocNo, pod.DtlKey;

/* 只想先看沙发那 61 行的话,在 WHERE 后面加这一句:
       AND pod.ItemCode LIKE '%SOFA%'
   想核对数量,先跑这个:
       SELECT COUNT(*) FROM ... (同一段,把 SELECT 栏位换成 COUNT(*))
*/
