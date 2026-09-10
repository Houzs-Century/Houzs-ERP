## The DS SearchInput could not be widened by a caller, so the field stayed pinned at 288px [low]

<!-- area: Frontend + mobile -->

**Symptom.** Rebuilding the Roles & Permissions left rail (`frontend/src/pages/Roles.tsx`) needed a full-width search field. `SearchInput` (`frontend/src/components/Button.tsx`) rendered at a hard 288px and there was no clean way to widen it: `className` styles the WRAPPER, not the field, and `inputClassName` only "worked" by luck.

**Root cause (traced).** The input's width was baked into its own class string as `w-72`, and the component's `cn` helper (`frontend/src/lib/utils.ts`) is a plain `join`, NOT tailwind-merge. So a width passed through `inputClassName` sits ALONGSIDE `w-72` (`"… w-72 … w-full"`) rather than overriding it; which one wins is left to Tailwind's compiled source order. `ColumnsDrawer` got a fluid field only because `w-full` happened to sort after `w-72` there — a coincidence, not an API.

**Fix.** `SearchInput` gained a `widthClassName` prop defaulting to `"w-72"`, applied in the field's own `cn` slot IN PLACE OF the hardcoded width. Existing callers keep the `w-72` default and are unchanged; the Roles rail passes `widthClassName="w-full"` for a fluid field with no class collision. Verified in an isolated Vite preview (real Tailwind) that the rail search fills its column, and `tsc -b` stays green.

**Ref.** feat/roles-permissions-redesign, 2026-09-10.
