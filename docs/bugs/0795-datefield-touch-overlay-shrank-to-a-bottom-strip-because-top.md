## DateField touch overlay shrank to a bottom strip because top/right/left auto overrode the inset shorthand [high]

**Symptom.** Owner, 2026-09-11: 「有时能点到，有时点不到」 on the mobile /
DevTools-mobile calendar field. After the force-calendar rollout (PR #3582)
the touch overlay was supposed to cover the WHOLE field — tap anywhere,
picker opens. What actually shipped was `inset: auto auto 0px auto` on the
deployed CSS (checked in the browser 2026-09-11): the overlay hugged the
BOTTOM edge of the wrap with no top / left / right anchor. A tap in the top
half of the field passed straight through to the visible read-out text
below the overlay and did nothing — 「calender no reaction」.

**Root cause (PROVEN in the browser).** The coarse-pointer rule inside
`frontend/src/vendor/scm/components/DateField.module.css` read:

```css
.nativeIconTarget {
  inset: 0;
  top: auto;
  right: auto;
  left: auto;
  transform: none;
  width: 100%;
  height: 100%;
}
```

The intent was «four-sides zero, then reset unwanted sides». That is not
what CSS does. `top / right / left` are declared AFTER the `inset`
shorthand and therefore OVERRIDE the sides `inset: 0` had just set.
`bottom` was not overridden, so the computed rule was
`top: auto; right: auto; bottom: 0; left: auto` — a bottom-anchored strip.
Chrome's DevTools compressed it as `inset: auto auto 0px` (which is what
we found in the deployed sheet).

**Fix.** Set every side explicitly and drop the redundant `transform` /
`inset` shorthand:

```css
.nativeIconTarget {
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 100%;
  transform: none;
}
```

The `width/height: 100%` are belt-and-braces once the four sides are
anchored; `transform: none` explicitly cancels the fine-pointer's
`translateY(-50%)` (which sat above at `.nativeIconTarget`'s base rule and
still applied under this media block until the explicit `transform: none`
here).

Verified in the browser after deploy: the coarse-pointer rule compiles to
`top: 0; right: 0; bottom: 0; left: 0; width: 100%; height: 100%;` — the
native `<input type="date">` covers the whole wrap and a tap anywhere on
the field opens the OS picker.

**Ref.** `fix/datefield-inset-shorthand-bug`, 2026-09-11.
