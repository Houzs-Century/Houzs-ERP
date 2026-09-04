import { useCallback, useEffect, useRef, useState } from "react";
import { Bold, Italic, List, ListOrdered, Underline } from "lucide-react";
import { cn } from "../lib/utils";
import {
  RICH_SIZES,
  sanitizeAnnouncementHtml,
  type RichSize,
} from "../lib/announcementRichText";

// ---------------------------------------------------------------------------
// AnnouncementRichEditor — the announcement composer's message box.
//
// Owner ask (2026-09-04): announcements need bold, text size and numbered
// lists. This is a deliberately SMALL editor: a contenteditable block with a
// six-button toolbar (bold / italic / underline / numbered / bulleted / size),
// driven by the browser's own editing commands. No editor library — the
// grammar it may produce is the ten tags in lib/announcementRichText.ts, and
// every keystroke's output is pushed through that canonicaliser before it
// reaches state, so the value this component reports is ALWAYS the stored
// shape (and never a browser-specific <div>/<font>/style soup).
//
// Font size rides on the classic `fontSize` command: the browser wraps the
// selection in <font size="7">, which we immediately rewrite into
// <span data-size="…"> (or unwrap for "normal"). That is the only DOM surgery
// here; everything else is execCommand + re-read innerHTML.
//
// Controlled-ish: `value` is written into the DOM only when it differs from
// what this editor last emitted (initial mount, and the reset-to-"" after a
// successful post). Writing innerHTML on every keystroke would throw the caret
// to the start, so we never do that mid-edit.
//
// Paste is forced to plain text. Office staff paste from WhatsApp, Word and
// email; letting that HTML in would only feed the canonicaliser junk it has
// to strip anyway, and the user can re-apply the two marks they meant.
// ---------------------------------------------------------------------------
type Size = RichSize | "md";

type Props = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  /** Minimum height of the editable area, in px. */
  minHeight?: number;
  id?: string;
  disabled?: boolean;
};

const SIZE_OPTIONS: Array<{ key: Size; label: string; title: string }> = [
  { key: "sm", label: "S", title: "Small text" },
  { key: "md", label: "M", title: "Normal text" },
  { key: "lg", label: "L", title: "Large text" },
  { key: "xl", label: "XL", title: "Extra-large text" },
];

// The sentinel the fontSize command leaves behind. 7 is the largest legacy
// size, which nothing else in this app produces, so it is safe to key on.
const FONT_SENTINEL = "7";

function isBlankHtml(html: string): boolean {
  return !html.replace(/<br>|<p>|<\/p>|&nbsp;|\s/g, "");
}

function exec(command: string, arg?: string): void {
  try {
    document.execCommand(command, false, arg);
  } catch {
    /* an editing command the browser does not know is a no-op, not a crash */
  }
}

function queryState(command: string): boolean {
  try {
    return document.queryCommandState(command);
  } catch {
    return false;
  }
}

/** Rewrite every <font size="7"> the fontSize command produced into the
 *  canonical span (or unwrap it for "normal"), and remove any nested size
 *  spans inside so the newest choice is the only one that applies. */
function foldFontSentinels(root: HTMLElement, size: Size): void {
  const fonts = Array.from(root.querySelectorAll(`font[size="${FONT_SENTINEL}"]`));
  for (const font of fonts) {
    font.querySelectorAll("span[data-size]").forEach((inner) => unwrap(inner));
    if (size === "md") {
      unwrap(font);
      continue;
    }
    const span = document.createElement("span");
    span.setAttribute("data-size", size);
    while (font.firstChild) span.appendChild(font.firstChild);
    font.replaceWith(span);
  }
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function sizeAtSelection(root: HTMLElement): Size {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  const node = sel?.anchorNode ?? null;
  if (!node || !root.contains(node)) return "md";
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const sized = el?.closest("span[data-size]");
  if (!sized || !root.contains(sized)) return "md";
  const v = sized.getAttribute("data-size") ?? "";
  return (RICH_SIZES as readonly string[]).includes(v) ? (v as RichSize) : "md";
}

export function AnnouncementRichEditor({
  value,
  onChange,
  placeholder,
  className,
  minHeight = 132,
  id,
  disabled,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string | null>(null);
  const [empty, setEmpty] = useState(true);
  const [marks, setMarks] = useState({
    bold: false,
    italic: false,
    underline: false,
    ol: false,
    ul: false,
    size: "md" as Size,
  });

  // External value → DOM, only when it is not what we just reported.
  useEffect(() => {
    const el = ref.current;
    if (!el || value === lastEmitted.current) return;
    const safe = value ? sanitizeAnnouncementHtml(value) : "";
    el.innerHTML = safe;
    lastEmitted.current = value;
    setEmpty(isBlankHtml(safe));
  }, [value]);

  // Paragraphs, not <div>s, when Enter is pressed (Chrome's default is div;
  // the canonicaliser folds either, but <p> keeps the DOM and the stored
  // value identical, which makes the caret behave across a re-sanitise).
  useEffect(() => {
    exec("defaultParagraphSeparator", "p");
    exec("styleWithCSS", "false");
  }, []);

  const refreshMarks = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setMarks({
      bold: queryState("bold"),
      italic: queryState("italic"),
      underline: queryState("underline"),
      ol: queryState("insertOrderedList"),
      ul: queryState("insertUnorderedList"),
      size: sizeAtSelection(el),
    });
  }, []);

  const emit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const safe = sanitizeAnnouncementHtml(el.innerHTML);
    const next = isBlankHtml(safe) ? "" : safe;
    setEmpty(next === "");
    lastEmitted.current = next;
    onChange(next);
  }, [onChange]);

  useEffect(() => {
    const onSel = () => {
      const el = ref.current;
      if (!el || document.activeElement !== el) return;
      refreshMarks();
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [refreshMarks]);

  const run = useCallback(
    (command: string) => {
      const el = ref.current;
      if (!el || disabled) return;
      el.focus();
      exec(command);
      emit();
      refreshMarks();
    },
    [disabled, emit, refreshMarks],
  );

  const applySize = useCallback(
    (size: Size) => {
      const el = ref.current;
      if (!el || disabled) return;
      el.focus();
      exec("fontSize", FONT_SENTINEL);
      foldFontSentinels(el, size);
      emit();
      refreshMarks();
    },
    [disabled, emit, refreshMarks],
  );

  const toolBtn =
    "inline-flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:bg-surface hover:text-ink disabled:opacity-40";
  const active = "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary";

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-surface focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20",
        disabled && "opacity-60",
        className,
      )}
    >
      <div
        className="flex flex-wrap items-center gap-0.5 border-b border-border-subtle bg-surface-dim px-1.5 py-1"
        role="toolbar"
        aria-label="Text formatting"
      >
        <button
          type="button"
          title="Bold (Ctrl+B)"
          aria-label="Bold"
          aria-pressed={marks.bold}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run("bold")}
          className={cn(toolBtn, marks.bold && active)}
        >
          <Bold size={13} />
        </button>
        <button
          type="button"
          title="Italic (Ctrl+I)"
          aria-label="Italic"
          aria-pressed={marks.italic}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run("italic")}
          className={cn(toolBtn, marks.italic && active)}
        >
          <Italic size={13} />
        </button>
        <button
          type="button"
          title="Underline (Ctrl+U)"
          aria-label="Underline"
          aria-pressed={marks.underline}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run("underline")}
          className={cn(toolBtn, marks.underline && active)}
        >
          <Underline size={13} />
        </button>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <button
          type="button"
          title="Numbered list"
          aria-label="Numbered list"
          aria-pressed={marks.ol}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run("insertOrderedList")}
          className={cn(toolBtn, marks.ol && active)}
        >
          <ListOrdered size={13} />
        </button>
        <button
          type="button"
          title="Bulleted list"
          aria-label="Bulleted list"
          aria-pressed={marks.ul}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run("insertUnorderedList")}
          className={cn(toolBtn, marks.ul && active)}
        >
          <List size={13} />
        </button>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Size
        </span>
        {SIZE_OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            title={o.title}
            aria-label={o.title}
            aria-pressed={marks.size === o.key}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applySize(o.key)}
            className={cn(toolBtn, marks.size === o.key && active)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div
        ref={ref}
        id={id}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder ?? "Message"}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-empty={empty ? "true" : "false"}
        data-placeholder={placeholder ?? ""}
        className="ann-rte px-3 py-2 text-[13px] leading-relaxed text-ink"
        style={{ minHeight }}
        onInput={emit}
        onBlur={emit}
        onFocus={refreshMarks}
        onKeyUp={refreshMarks}
        onMouseUp={refreshMarks}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          if (text) exec("insertText", text);
        }}
      />
    </div>
  );
}
