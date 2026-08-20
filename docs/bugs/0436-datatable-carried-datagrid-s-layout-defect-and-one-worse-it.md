## DataTable carried DataGrid's layout defect — and one worse: it overwrote the saved layout [medium]

<!-- area: Frontend + mobile -->

**白话.** 修 DataGrid「布局每次打开都重置」时(#2463)发现 DataTable(SO 列表这类表格)底层的 `useLocalStorage` 有同一个病:挂载时读一次 key,公司解析出来、key 换成带公司前缀的那一刻,它不重读——而且更糟,它的写回逻辑会立刻把旧 key 的值写进新 key,**把用户存好的布局盖掉**。SO 列表今天没病发,是因为这条路径挂载时公司通常已经解析好,外加服务器端布局水合兜底;但这是运气不是保障。owner 验证 SO 列表时拍板「DataTable 也加上」。

**Root cause.** `useLocalStorage` seeds with a one-shot `useState` initialiser and
its write effect runs on `[key, value]`. When the key MOVES after mount (DataTable
layout keys gain a `c<company>:` prefix once `/auth/me` resolves the active
company), the state keeps the OLD key's value and the write effect immediately
copies it over the NEW key's saved value. DataGrid's twin defect (previous entry,
#2463) only failed to re-read; this one also **destroys the saved arrangement**.

**Fix.** In the hook itself, where DataTable's layout facets (hidden/shown/order/
sort/widths/mview) inherit it: on a genuine key change, re-read (with the legacy
fallback, so pre-scoping carry-over still works) and skip that pass's write; a
same-key re-render never re-reads, so an on-screen edit is never clobbered.

**Proven, not assumed.** With the fix stashed, 4 of the 6 new tests fail
(`useLocalStorage.test.ts`, `DataTableLayoutCompanyKey.test.tsx` — the latter is
DataGrid's company-key suite ported to the real DataTable); restored, 56/56 across
the three suites including DataTable's existing one.

**Ref.** PR (branch `fix/uselocalstorage-key-reread`), 2026-08-20. Sibling of #2463/#2471.
