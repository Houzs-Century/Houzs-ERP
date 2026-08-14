/* ============================================================================
   重新导出 ac-so-linked-pos.json.gz —— 这一次带「每一行自己的」收货数量。

   为什么要重导:现在这份档案里的 GrQty 是按 (DocNo + ItemCode) 汇总的,不是每
   行的数量。同一张 PO 上有两行同一个 ItemCode 时,两行都会写成整张单的总数。

   证据(在档案自己身上就能看到):
     - 38 组「同单同 ItemCode 有 2 行以上」的,每一组里每行的 GrQty 完全一样;
     - 59 行的 GrQty 比 Qty 还大(单行不可能),而且全部落在上面那 38 组里;
     - PO-008944 有两行 DSL-8050 SOFA,Qty 分别是 2 和 1,两行都写 GrQty 3
       (= 2 + 1);AutoCount 里真正的 PODTL.TransferedQty 是 2 和 1。

   后果:已经有 65 行 migrated PO 进了正式系统,received_qty 比 qty 还大 —— 永久
   的负数未收量,没有任何报表会提醒。

   下面这段跟 autocount-refetch-po.sql 用的是同一个正确来源:pod.TransferedQty,
   直接取自 PO 明细行本身。筛选条件跟原本那份 SO-linked 档案一致(这张 PO 是为
   了某张 SO 开的),但不再关心 GR 那边怎么汇总。

   用法:
     1. 在 AutoCount 主机用 SSMS 连上 AED_HOUZS 这个 book
     2. 整段执行,右键结果 → Save Results As → JSON
     3. 存成 ac-so-linked-pos.json.gz(gzip 后)盖掉旧档,重跑 DRY-RUN

   注意:这只是「读」,不会改 AutoCount 任何资料。
   ============================================================================ */

USE AED_HOUZS;

SELECT
    po.DocNo,
    po.DocDate,
    po.CreditorCode,
    cr.CompanyName            AS CreditorName,
    po.[Ref],
    po.Cancelled,
    pod.DtlKey,
    pod.ItemCode,
    pod.Description,
    pod.Desc2,
    pod.Qty,
    pod.TransferedQty,        -- 每行自己的收货数量。不要用 GRDTL 汇总出来的 GrQty
    pod.UnitPrice,
    pod.Location,
    pod.DeliveryDate,
    pod.FromDtlKey            AS FromSODtlKey
FROM dbo.PO po
JOIN dbo.PODTL pod  ON pod.DocKey = po.DocKey
LEFT JOIN dbo.Creditor cr ON cr.AccNo = po.CreditorCode
WHERE po.Cancelled <> 'T'
  AND EXISTS (
        SELECT 1
        FROM dbo.SODTL sd
        JOIN dbo.SO so ON so.DocKey = sd.DocKey
        WHERE so.Cancelled <> 'T'
          AND (
                sd.DtlKey = pod.FromDtlKey
             OR CHARINDEX(so.DocNo, ISNULL(pod.FromDocNo, '')) > 0
          )
      )
ORDER BY po.DocNo, pod.DtlKey;

/* ----------------------------------------------------------------------------
   核对用:跑完上面那段之后,这一段会把「汇总值 ≠ 每行值」的行列出来。
   预期结果是 60 行左右 —— 就是被写坏的那些。

   SELECT pod.DocNo, pod.DtlKey, pod.ItemCode, pod.Qty,
          pod.TransferedQty                        AS PerLine,
          SUM(pod.TransferedQty) OVER (PARTITION BY po.DocKey, pod.ItemCode) AS Aggregated
   FROM dbo.PO po
   JOIN dbo.PODTL pod ON pod.DocKey = po.DocKey
   WHERE po.Cancelled <> 'T'
   QUALIFY PerLine <> Aggregated;   -- SQL Server 没有 QUALIFY,包成子查询再筛

   注意 GRDTL.FromDocDtlKey 在这个 book 里是 NULL,所以「用 GR 明细反推 PO 行」
   这条路走不通 —— PODTL.TransferedQty 是唯一正确的来源。
   ---------------------------------------------------------------------------- */
