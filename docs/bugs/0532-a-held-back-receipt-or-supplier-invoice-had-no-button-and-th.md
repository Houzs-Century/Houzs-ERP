## A held-back receipt or supplier invoice had no button, and the reason on it was false [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 老板：「我的 GR PO 所有文件都要有 Send Now 的 button，不是跟你说了吗？」、
「点击 Send Now 的话，如果它之前上面的 documentation 没有进去，它就要补调进去」。

八张单（四张收货单、四张采购发票）在 AutoCount Sync 页上写着 **HELD BACK**，理由是
「There is no earlier document to carry across」，而且**没有按钮可以按**。

**那句话是假的。** 那八张单的行明明连着采购单 —— 是建单当时的程式没有去看
（0524）。0524 修好了建单，但它修不到**已经建好的那八张**：它们身上的纪录早就写死
了，而系统的规则是「没有母单的纪录不给按钮」，所以它们永远长不出按钮，也永远不会有
人发现那句话是错的。

**没有按钮 = 那个错误变成永久且看不见的。**

**改成两件事。** 一、被记成「没有母单」的转档单**照样给按钮**。二、按下去的时候
**重新去问这张单有没有母单**（跟建单走同一支 `convert-parent`，不是另外写一份会跟它
吵架的判断），有的话就当场组一张真的转档送出去，并且照原本的规则把上游依序补齐。

真的手键入、上面本来就没有母单的那种，按下去会拿到同一句拒绝 —— 但是**是一句话**，
不是一颗灰掉的按钮。

**为什么不是写一支脚本去补那八笔。** 脚本补完这八笔，下一批还是会有；而且脚本对
production 是写入。放在按钮里，判断只有一份、走的是已经在跑的那条路，而且是老板自己
按、自己看结果。

重复送的那道关卡一个都没有拿掉：已经进帐本的（`linked_ac_docno` 有值）拒绝，已经有
一张活着的排队列拒绝。AutoCount 对 ERP 单号**没有防重复**，而且进了帐本的单不能说删
就删。

```enumeration
backend/src/scm/lib/autocount-outbox-status.ts — 转档单 skipped 也给按钮
backend/src/scm/lib/convert-parent.ts — reresolveConvertSource，重新读母单
backend/src/scm/lib/autocount-requeue.ts — parentedAfterAll + requeued-with-parent
```
