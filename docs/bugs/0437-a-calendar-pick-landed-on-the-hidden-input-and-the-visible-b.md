## A calendar pick landed on the hidden input and the visible box never blurred [medium]

<!-- area: Service cases (ASSR) -->

**白话.** Service case 的日期栏（比如 Supplier Pickup Date）如果是点日历小图标选的，
日期会显示在框里，但其实没存进去——刷新回来就没了。手动打字输入的反而能存。原因：这
类栏位是「离开输入框（blur）那一刻才保存」，而日历选择走的是一个隐藏的原生日期输入，
可见的文本框全程没获得过焦点，也就永远不会 blur，保存永远不触发。修法＝日历选完本身
就是一次完整录入，选完直接发出同一个保存信号。

**Symptom.** Nico, 2026-08-20, ASSR/2608-003 (stage Pending Supplier Return):
「这个supplier pickup date不能Save」— the field showed 18/08/2026, picked via
the calendar icon; Customer Pickup Date on the same panel, typed by hand, saved
fine, which is what made one field look broken and its twin look healthy.

**Root cause (traced in source).** `InlineEdit`
(`frontend/src/components/InlineEdit.tsx`) commits on the text input's blur:
`<DateField … onBlur={() => commit()} />`. `DateField`
(`frontend/src/vendor/scm/components/DateField.tsx`) routes the calendar
through a HIDDEN native `<input type="date">` (`showPicker()` anchored to the
icon button, `tabIndex={-1}`); its `onChange` called only `onChange(iso)`. The
visible text input — the only element wired to `onBlur` — never receives focus
on the picker path, so `commit()` never runs. The draft state updates, the date
renders, and nothing is saved.

**Fix.** The hidden input's `onChange` now also fires the completion signal,
deferred one tick (`setTimeout(0)`) so a host that commits its own state
(InlineEdit commits its `draft`) sees this change's state flushed first.
Blur-after-typing is unchanged; a host that passes no `onBlur` is unaffected.
