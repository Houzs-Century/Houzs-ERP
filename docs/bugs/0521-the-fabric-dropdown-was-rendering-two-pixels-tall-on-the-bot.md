## The fabric dropdown was rendering two pixels tall on the bottom edge of the window [high]

<!-- area: Sales orders + pricing -->

**白话.** 老板：「fabric variant got issues why no drop down?」

**下拉一直都有出来。** 18 个颜色全部在里面。它被放在视窗最底缘，高度 **2px** —— 那
2px 是它自己的上下边框。看起来就跟「下拉打不开」一模一样。

- **发现:** 2026-08-22，在 prod（Houzs Century，新建销售单，SKU `2376-1A(RHF)`，
  fabric 打 `PC151`）量出来的
- **状态:** 已修

### 量到的东西

```
class    position: absolute;  top: 100%;  left: 0;  right: 0;
inline   position: fixed;  left: 295px;  width: 286px;  bottom: 376px;  right: auto;
used     top 816px  (= 100% of the 816px viewport)   height 2px
```

API 是好的 —— `/api/scm/fabric-colours?q=PC151` 回 **200，18 笔**。

### 为什么

`anchoredPanelStyle` 是这样写的：

```ts
top: pos.top,
bottom: pos.bottom,
```

`pos.top` 和 `pos.bottom` 是**互斥**的：面板往上翻的时候只有 `bottom`。于是
`top: undefined` —— 而 **React 会把 undefined 的 style 属性整个省略**。

省略之后，class 自己的 `top: 100%` 就活了下来。对一个 `position: fixed` 的元素，
`100%` 就是整个视窗高度。现在 `top` 和 `bottom` 同时存在、`height` 是 auto：

```
816 (viewport) − 816 (top) − 376 (bottom) = −376   →   压成 0
```

### 什么时候会踩到

**只有面板往上翻的时候** —— 也就是下方空间比上方少的时候。

Fabric 输入框在卡片偏下的位置（y 444–472，视窗 816），下方 344px、上方 444px，所以
一定往上翻。同一张卡片上面的 SKO picker 位置高、往下开，所以永远正常。

**这就是为什么它看起来时好时坏。**

### 一半的 bug 早就被发现过

inline style 里有一行 `right: 'auto'`。

class 的 `right: 0` 会造成同一类问题，而 `SoLineCard.tsx` 和 `DebtorSuggestList.tsx`
**两个呼叫点各自手动补了 `right: 'auto'`** —— 有人踩过这个坑的另一半，在呼叫点补掉，
没有回到共用模组把根因处理掉，所以 `top` 就留在那里等下一个人。

### 修法

`anchoredPanelStyle` 现在**两个边都一定写出来**，没用到的那一边写 `'auto'`：

```ts
top: pos.top ?? 'auto',
bottom: pos.bottom ?? 'auto',
```

`'auto'` 是 CSS 的初始值，所以对本来就没设这些的面板是 no-op。

修在共用模组，**八个消费者一次全部涵盖**：`SoLineCard`、`SearchableSelect`、
`StatePicker`、`DebtorSuggestList`、`MultiSupplierPicker`、`PhoneInput`、
`UserMultiSelect`、`ServiceCases`。

会咬人的 class 有两个：`SoLineCard.module.css` 和 `SalesOrderDetail.module.css` 的
`.suggestList`（两个都是 `position: absolute; top: 100%`）—— 也就是销售单新建和明细
两张画面上的每一个 picker。

### 测试

断言的是那个属性**存在而且等于 `'auto'`**，不是「不存在」—— **「不存在」正是让 class
赢的那个状态**。另外把真实的生产几何（444–472 / 816）当成一个案例钉住。

先证明 RED：4 个新案例全挂，既有 26 个不动。

### 我一开始判错的地方

第一次找的时候，我用「离输入框很近的绝对／固定定位元素」去搜面板，条件是
`top < inputBottom + 200`。面板在 `top: 816`，被我自己的筛选条件排除掉了，所以我得到
「完全没有面板」这个结论，还据此推了别的方向。**是我的搜寻条件预设了答案。**

后来改成「body 里所有 `position: fixed` 的 `<ul>`」，一次就找到了。
