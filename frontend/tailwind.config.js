/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  // Semantic utilities the design-system docs (conventions header)
  // enumerate for the claude.ai/design agent — keep them in the
  // compiled CSS even when no in-repo component happens to use them.
  safelist: ["bg-err-bg", "bg-synced-bg", "font-body"],
  theme: {
    extend: {
      colors: {
        // ── Theme C · "Ink & Petrol" ───────────────────────
        // Visual refresh (2026-06-25). Cooler neutral canvas so white
        // cards lift off the page; petrol/teal `primary` is the new
        // FUNCTIONAL accent (buttons, active states, links, selected
        // rows); brass `accent` is demoted to a brand-only accent
        // (logo, eyebrows, doc numbers, soft backgrounds).

        // ── Canvas ─────────────────────────────────────────
        bg: "#eef0ec",
        surface: "#ffffff",
        "surface-2": "#f4f6f3", // table headers, nested/inset surfaces, search fields
        "surface-dim": "#e3e6e0",

        border: {
          DEFAULT: "#d6d9d2",
          subtle: "#e3e6e0",
          strong: "#c2c6bd",
        },

        // ── Ink ────────────────────────────────────────────
        ink: {
          DEFAULT: "#11140f",
          secondary: "#414539",
          muted: "#767b6e",
        },

        // ── Primary (petrol/teal) — NEW functional accent ──
        primary: {
          DEFAULT: "#16695f",
          soft: "#e1efed", // selected-row bg, soft chips, month-P&L card
          ink: "#0c3f39", // text on primary-soft
        },

        // ── Brass accent (brand only — not primary CTAs) ───
        accent: {
          DEFAULT: "#a16a2e",
          soft: "#f3ece0",
          bright: "#d8a85a", // gold for text on dark sidebar/headers
          hover: "#8a5a26",
          ink: "#5a3a14",
        },

        // ── Sidebar palette (dark ink-green slab) ──────────
        sidebar: {
          DEFAULT: "#13201c",
          ink: "#e7eae4",
          "ink-muted": "#8c968a",
          "ink-soft": "#6f786d",
          border: "rgba(231,234,228,0.12)",
          hover: "rgba(231,234,228,0.06)",
          active: "rgba(22,105,95,0.22)", // petrol 22%
        },

        // ── Semantic ───────────────────────────────────────
        synced: { DEFAULT: "#2f8a5b", bg: "#e2f0e9" },
        err: { DEFAULT: "#b23a3a", bg: "#f8eaea" },
        // LEARNING announcements — trend blue, mirrors --c-secondary-b in
        // vendor tokens.css. Hex literal (not var()) so /40-style opacity
        // modifiers compose like the other semantic colors here.
        learning: "#1f3a8a",
        expired: { bg: "#f7e9e9", text: "#7a2222" },
        warning: { bg: "#f6efd9", text: "#6e4d12" },
      },
      fontFamily: {
        // Theme C type spec (Nick 2026-07-03, "IBM PLEX + 思源黑/宋"):
        //   body    = IBM Plex Sans + Noto Sans SC   (正文·思源黑体)
        //   display = IBM Plex Serif + Noto Serif SC (标题·思源宋体)
        //   mono    = IBM Plex Mono                  (金额/编号)
        // Web fonts loaded via @import url() in src/index.css.
        // Owner 2026-07-24 ("统一掉"): ONE face system-wide - the system
        // stack, matching the digits change and 2990's long-standing call.
        // Plex Sans / Noto Sans SC dropped from the lead; CJK falls through
        // to the OS face (YaHei / PingFang).
        // Owner 2026-08-01, superseding the 2026-07-24 "统一掉 → system stack"
        // ruling recorded above: "系统里的所有列表字体都同意换成 IBM Plex Sans",
        // then again after I scoped it to doc numbers only — "需要换成全站列表统
        // 一字体". So the whole surface is one face again, and the 7-24 note is
        // kept rather than deleted because it explains what this replaced.
        //
        // font-extrabold (800) is covered: public/fonts/fonts-v2.css declares
        // an 800 face over the same 400-700 variable file, so 88 heading sites
        // clamp to real 700 outlines instead of synthesising. The -v2 name is
        // load-bearing — /fonts/* is immutable-cached for a year, so the sheet
        // had to be renamed for the fix to reach existing users at all.
        body: ['"IBM Plex Sans"', '"Noto Sans SC"', "system-ui", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", '"Helvetica Neue"', "Arial", "sans-serif"],
        // Nick 2026-07-09 "整个系统页面都要 C 字体": Ink & Petrol admin
        // rhythm wants sans titles, not display serif. Point `font-display`
        // at the same IBM Plex Sans stack as body so every V2 list / detail
        // page (SO / DO / SI / DR / PO / PI / PR / GRN / Consignment) plus
        // PageHeader / AuthShell / etc. render titles in sans — matching
        // the CSS-module page rhythm we just switched via --font-title.
        // `font-serif` stays on IBM Plex Serif for the rare place that
        // deliberately opts into serif (`className="font-serif"`).
        display: ['"IBM Plex Sans"', '"Noto Sans SC"', "system-ui", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", '"Helvetica Neue"', "Arial", "sans-serif"],
        // Codes / IDs / eyebrow labels (金额/编号 role) — SYSTEM stack, owner
        // override 2026-07-24: Plex Mono's dotted zero read wrong ("系统的0可以
        // 用第二张照片的0吗"), and our self-hosted Plex subsets carry no plain-
        // zero alternate or tnum, so the fix is the same one 2990 shipped on
        // 2026-05-29: digits in the system face (Segoe UI on Windows — plain
        // zero, tnum supported), alignment via font-variant-numeric in
        // index.css. Deliberately SKIPS IBM Plex Sans: it would win the stack
        // but its subset lacks tnum, breaking column alignment.
        // Codes / eyebrow labels. Follows `body` so a list is ONE face; the
        // 7-24 objection that sent this to the system stack was Plex Sans's
        // missing tnum breaking column alignment, and the self-hosted subset
        // resolved that (its digits are tabular by construction). Doc numbers
        // do NOT live here — they are `docno`, and the owner put those on Plex
        // Mono the same day. See that alias.
        mono: ['"IBM Plex Sans"', '"Noto Sans SC"', "system-ui", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", '"Helvetica Neue"', "Arial", "sans-serif"],
        // Money / financial figures — same stack, kept as its own alias so
        // amount cells can diverge from codes again if needed.
        money: ['"IBM Plex Sans"', '"Noto Sans SC"', "system-ui", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", '"Helvetica Neue"', "Arial", "sans-serif"],
        // Doc numbers on the SCM list columns (SO / DO / SI / PO / GRN / DR /
        // PR) and the doc-number chips beside them. Its own alias rather than
        // reusing `mono`, which also dresses eyebrow labels and stays on the
        // system stack.
        //
        // IBM Plex MONO, chosen by the owner 2026-08-01 from a three-way
        // side-by-side of the same PO numbers at 12.5px/600 (Plex Sans as
        // shipped by #1445, Segoe UI as it was after 7-24, and this). It is a
        // deliberate return to the true monospace face 7-24 had dropped — and
        // the dotted zero that decided 7-24 was in that comparison, blown up to
        // 40px, so it is chosen WITH that trade, not around it.
        //
        // Weights: the self-hosted subset carries 400/500/600 and every one of
        // the 25 doc-number call sites asks for font-semibold (600) — an exact
        // hit, so nothing synthesises. Do not raise a doc number to font-bold
        // (700) without adding the face first; that is the "假加粗" trap the
        // ASSR print redesign hit.
        //
        // Alignment needs no font-variant-numeric here: monospace is tabular by
        // construction.
        docno: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", '"Cascadia Mono"', '"Segoe UI Mono"', "Consolas", "monospace"],
        serif: ['"IBM Plex Serif"', '"Noto Serif SC"', "Georgia", "serif"],
      },
      letterSpacing: {
        brand: "0.18em",
        wider: "0.06em",
      },
      // Nico 2026-07-09 (ColumnsPanelButton handoff) — expose the semantic
      // motion tokens from vendor/design-system/tokens.css as Tailwind
      // classes. Values mirror --duration-* there so `duration-fast` inside
      // a className resolves to the same 120 ms every raw CSS `.foo {
      // transition-duration: var(--duration-fast) }` gets. `duration-{75,
      // 150, 200, 300}` stay available from Tailwind defaults.
      transitionDuration: {
        quick: "80ms",
        fast: "120ms",
        base: "200ms",
        slow: "320ms",
      },
      boxShadow: {
        // Soft "stone" shadow — matches the cream canvas without
        // looking like a generic Material drop shadow.
        stone: "0 1px 0 rgba(17, 24, 16, 0.04), 0 4px 18px -8px rgba(17, 24, 16, 0.12)",
        slab: "0 1px 0 rgba(17, 24, 16, 0.06), 0 12px 32px -16px rgba(17, 24, 16, 0.25)",
        brass: "0 0 0 1px rgba(161, 106, 46, 0.3), 0 1px 4px rgba(161, 106, 46, 0.18)",
      },
      keyframes: {
        // Page-load reveal: a slow lift from below with fade.
        rise: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        // Brass shimmer for skeleton states — the metal catching light.
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
        // Toast: slide down from above + fade in.
        toastIn: {
          "0%": { opacity: "0", transform: "translateY(-12px) scale(0.97)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        // Modal panel: scale-up + fade.
        modalIn: {
          "0%": { opacity: "0", transform: "scale(0.96)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        /* `backwards`, NOT `both` — deliberate. `both` also fills FORWARDS, which
           leaves the 100% keyframe's `transform: translateY(0)` applied to the
           element forever. A transform other than `none` makes an element the
           containing block for every `position: fixed` descendant, so `both` made
           each page's wrapper (Layout renders `animate-rise` around the whole page)
           silently capture any fixed child — drawers/dialogs anchored to the page
           box instead of the viewport (see BUG-HISTORY 2026-07-16, SO History
           drawer). `backwards` keeps the pre-start fill (no flash at 0%) and drops
           the forwards fill, so transform returns to `none` when the animation
           ends. Visually identical: the 100% keyframe (opacity 1 / translateY 0)
           IS the element's natural resting state. Verified in Chrome: with `both`
           the finished element computes `matrix(1,0,0,1,0,0)` and captures a fixed
           child; with `backwards` it computes `none` and the child latches to the
           viewport. */
        rise: "rise 420ms cubic-bezier(0.16, 1, 0.3, 1) backwards",
        "fade-in": "fadeIn 600ms ease both",
        shimmer: "shimmer 1.6s linear infinite",
        "toast-in": "toastIn 220ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "modal-in": "modalIn 180ms cubic-bezier(0.16, 1, 0.3, 1) both",
      },
    },
  },
  plugins: [],
};
