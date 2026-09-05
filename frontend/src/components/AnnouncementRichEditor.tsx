import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bold,
  Heading1,
  Heading2,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  RemoveFormatting,
  Table as TableIcon,
  Underline,
} from "lucide-react";
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
// lists. Toolbar follow-up (2026-09-05, Announcements redesign): two heading
// levels, highlight, link, a small table, an inline image, and Clear. This
// is still a deliberately SMALL editor: a contenteditable block driven by the
// browser's own editing commands. No editor library — the grammar it may
// produce is the allow-list in lib/announcementRichText.ts, and every
// keystroke's output is pushed through that canonicaliser before it reaches
// state, so the value this component reports is ALWAYS the stored shape (and
// never a browser-specific <div>/<font>/style soup).
//
// Where the browser's command leaves a spelling the grammar does not have,
// the DOM is rewritten right after the command, and nowhere else:
//   · fontSize → <font size="7"> becomes <span data-size="…"> (or unwraps)
//   · hiliteColor → the styled span/font becomes <mark>
//   · formatBlock h1 / h2 / p is emitted as-is (canonical already)
//   · createLink is fed a normalised http(s)/mailto URL; anything else is
//     refused before the command runs (the canonicaliser would drop it anyway)
//   · a table / image is inserted as canonical HTML through insertHTML
//
// Images: the composer owns the upload (`onInsertImage`), and the editor only
// ever stores the attachment KEY (`<img data-att>`); the `src` you see while
// editing is a local object URL the composer hands back, re-attached through
// `imageSrc` whenever the value is written into the DOM. The stored value
// never carries a URL.
//
// Controlled-ish: `value` is written into the DOM only when it differs from
// what this editor last emitted (initial mount, and the reset-to-"" after a
// successful post). Writing innerHTML on every keystroke would throw the caret
// to the start, so we never do that mid-edit.
//
// Paste is forced to plain text. Office staff paste from WhatsApp, Word and
// email; letting that HTML in would only feed the canonicaliser junk it has
// to strip anyway, and the user can re-apply the marks they meant.
// ---------------------------------------------------------------------------
type Size = RichSize | "md";
type Block = "p" | "h1" | "h2";

export type RichEditorImage = { key: string; src: string };

type Props = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  /** Minimum height of the editable area, in px. */
  minHeight?: number;
  id?: string;
  disabled?: boolean;
  /** Ask the user for a link target (the app's prompt dialog). Absent = no
   *  Link button — the phone composer has no dialog provider. */
  onPromptLink?: (current: string) => Promise<string | null>;
  /** Upload a picked image and return its attachment key + a local preview
   *  URL, or null when the upload failed (the composer has already toasted).
   *  Absent = no Image button. */
  onInsertImage?: (file: File) => Promise<RichEditorImage | null>;
  /** Resolve an attachment key to something an <img src> can show while
   *  editing (the composer's local previews). Unknown key = no src. */
  imageSrc?: (key: string) => string | undefined;
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
// Any colour works: the styled element is rewritten into <mark> at once and
// the reader's CSS paints the real highlight. Picked to match .ann-rich mark.
const HILITE_SENTINEL = "#f3ece0";
// A 2×2 starter: one header row, one body row. <br> keeps an empty cell
// clickable in contenteditable (an empty <td> collapses to nothing).
export const TABLE_TEMPLATE =
  "<table><tr><th>Column</th><th>Column</th></tr><tr><td><br></td><td><br></td></tr></table><p><br></p>";

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

/**
 * Turn what a person types into the Link prompt into a target the grammar
 * accepts, or null. Bare domains get https://, a bare address gets mailto:,
 * and anything with another scheme (javascript:, data:, ftp:) is refused.
 */
export function normalizeLinkHref(input: string): string | null {
  const v = input.trim();
  if (!v || /[\s<>"'`\\]/.test(v)) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^mailto:/i.test(v)) return /^mailto:[^@]+@[^@]+$/i.test(v) ? v : null;
  // Some other scheme (javascript:, data:, ftp:) — but "host:8080/x" is a
  // port, not a scheme, so a digit right after the colon is not one.
  if (/^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(v)) return null;
  if (/^[^@]+@[^@]+\.[^@]+$/.test(v)) return `mailto:${v}`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(v)) return `https://${v}`;
  return null;
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

/** Rewrite whatever the hiliteColor command styled into <mark>, and flatten
 *  a mark that landed inside another mark. */
function foldHighlights(root: HTMLElement): void {
  const styled = Array.from(root.querySelectorAll<HTMLElement>("[style]")).filter(
    (el) => el.style.backgroundColor !== "",
  );
  for (const el of styled) {
    const mark = document.createElement("mark");
    while (el.firstChild) mark.appendChild(el.firstChild);
    el.replaceWith(mark);
  }
  root.querySelectorAll("mark mark").forEach((inner) => unwrap(inner));
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/** Give every stored image its editing-time src (the stored value has none). */
function hydrateImages(root: HTMLElement, imageSrc?: (key: string) => string | undefined): void {
  root.querySelectorAll<HTMLImageElement>("img[data-att]").forEach((img) => {
    const key = img.getAttribute("data-att") ?? "";
    const src = imageSrc?.(key);
    if (src) img.setAttribute("src", src);
    else img.removeAttribute("src");
    img.setAttribute("alt", "");
    img.setAttribute("draggable", "false");
  });
}

function selectionElement(root: HTMLElement): Element | null {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  const node = sel?.anchorNode ?? null;
  if (!node || !root.contains(node)) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function closestIn(root: HTMLElement, selector: string): Element | null {
  const el = selectionElement(root);
  const hit = el?.closest(selector) ?? null;
  return hit && root.contains(hit) && hit !== root ? hit : null;
}

function sizeAtSelection(root: HTMLElement): Size {
  const v = closestIn(root, "span[data-size]")?.getAttribute("data-size") ?? "";
  return (RICH_SIZES as readonly string[]).includes(v) ? (v as RichSize) : "md";
}

function blockAtSelection(root: HTMLElement): Block {
  const tag = closestIn(root, "h1,h2")?.tagName.toLowerCase();
  return tag === "h1" || tag === "h2" ? tag : "p";
}

/** Unwrap every element matching `selector` that the current selection
 *  touches. Used by Clear, where removeFormat leaves marks and links alone. */
function unwrapInSelection(root: HTMLElement, selector: string): void {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  // Boundary comparison rather than Range.intersectsNode: same answer, and
  // implemented by every DOM the editor runs in (jsdom included).
  const hits = Array.from(root.querySelectorAll(selector)).filter((el) => {
    const r = document.createRange();
    r.selectNode(el);
    return (
      range.compareBoundaryPoints(Range.END_TO_START, r) < 0 &&
      range.compareBoundaryPoints(Range.START_TO_END, r) > 0
    );
  });
  hits.forEach((el) => unwrap(el));
}

export function AnnouncementRichEditor({
  value,
  onChange,
  placeholder,
  className,
  minHeight = 132,
  id,
  disabled,
  onPromptLink,
  onInsertImage,
  imageSrc,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastEmitted = useRef<string | null>(null);
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [marks, setMarks] = useState({
    bold: false,
    italic: false,
    underline: false,
    ol: false,
    ul: false,
    mark: false,
    link: false,
    block: "p" as Block,
    size: "md" as Size,
  });

  // External value → DOM, only when it is not what we just reported.
  useEffect(() => {
    const el = ref.current;
    if (!el || value === lastEmitted.current) return;
    const safe = value ? sanitizeAnnouncementHtml(value) : "";
    el.innerHTML = safe;
    hydrateImages(el, imageSrc);
    lastEmitted.current = value;
    setEmpty(isBlankHtml(safe));
  }, [value, imageSrc]);

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
      mark: closestIn(el, "mark") !== null,
      link: closestIn(el, "a") !== null,
      block: blockAtSelection(el),
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
    (command: string, arg?: string) => {
      const el = ref.current;
      if (!el || disabled) return;
      el.focus();
      exec(command, arg);
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

  const applyBlock = useCallback(
    (block: Block) => {
      const el = ref.current;
      if (!el || disabled) return;
      // Clicking the active heading turns it back into a paragraph.
      const next = blockAtSelection(el) === block ? "p" : block;
      run("formatBlock", `<${next}>`);
    },
    [disabled, run],
  );

  const toggleHighlight = useCallback(() => {
    const el = ref.current;
    if (!el || disabled) return;
    el.focus();
    const current = closestIn(el, "mark");
    // An emptied highlighted line leaves <mark><br></mark> with the caret
    // parked beside (not inside) it; the click means "no highlight here".
    const block = closestIn(el, "p,h1,h2,li,td,th");
    const emptied = block
      ? Array.from(block.querySelectorAll("mark")).filter((m) => !m.textContent)
      : [];
    if (current) unwrap(current);
    else if (emptied.length) emptied.forEach((m) => unwrap(m));
    else {
      exec("hiliteColor", HILITE_SENTINEL);
      foldHighlights(el);
    }
    emit();
    refreshMarks();
  }, [disabled, emit, refreshMarks]);

  const toggleLink = useCallback(async () => {
    const el = ref.current;
    if (!el || disabled || !onPromptLink) return;
    const current = closestIn(el, "a");
    if (current) {
      unwrap(current);
      emit();
      refreshMarks();
      return;
    }
    // The prompt steals focus; remember the selection and put it back.
    const sel = window.getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    const typed = await onPromptLink("");
    if (typed === null) return;
    const href = normalizeLinkHref(typed);
    if (!href) return;
    el.focus();
    if (range && sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    if (!range || range.collapsed) {
      // Nothing selected: the address itself becomes the link text.
      const text = href.replace(/^mailto:/i, "");
      exec("insertHTML", `<a href="${href}">${text}</a>&nbsp;`);
    } else {
      exec("createLink", href);
    }
    emit();
    refreshMarks();
  }, [disabled, emit, onPromptLink, refreshMarks]);

  const insertTable = useCallback(() => run("insertHTML", TABLE_TEMPLATE), [run]);

  const onPickImage = useCallback(
    async (file: File | undefined) => {
      const el = ref.current;
      if (fileRef.current) fileRef.current.value = "";
      if (!el || !file || disabled || !onInsertImage) return;
      setBusy(true);
      try {
        const got = await onInsertImage(file);
        if (!got) return;
        el.focus();
        exec(
          "insertHTML",
          `<img data-att="${got.key}" src="${got.src}" alt="" draggable="false"><p><br></p>`,
        );
        emit();
        refreshMarks();
      } finally {
        setBusy(false);
      }
    },
    [disabled, emit, onInsertImage, refreshMarks],
  );

  const clearFormatting = useCallback(() => {
    const el = ref.current;
    if (!el || disabled) return;
    el.focus();
    exec("removeFormat");
    unwrapInSelection(el, "mark, a, span[data-size]");
    if (blockAtSelection(el) !== "p") exec("formatBlock", "<p>");
    emit();
    refreshMarks();
  }, [disabled, emit, refreshMarks]);

  const toolBtn =
    "inline-flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:bg-surface hover:text-ink disabled:opacity-40";
  const active = "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary";
  const divider = <span className="mx-1 h-4 w-px bg-border" aria-hidden />;
  const btn = (
    label: string,
    title: string,
    pressed: boolean,
    onClick: () => void,
    icon: ReactNode,
    extraDisabled = false,
  ) => (
    <button
      type="button"
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled || extraDisabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(toolBtn, pressed && active)}
    >
      {icon}
    </button>
  );

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
        {btn("Heading 1", "Heading 1", marks.block === "h1", () => applyBlock("h1"), <Heading1 size={14} />)}
        {btn("Heading 2", "Heading 2", marks.block === "h2", () => applyBlock("h2"), <Heading2 size={14} />)}
        {divider}
        {btn("Bold", "Bold (Ctrl+B)", marks.bold, () => run("bold"), <Bold size={13} />)}
        {btn("Italic", "Italic (Ctrl+I)", marks.italic, () => run("italic"), <Italic size={13} />)}
        {btn("Underline", "Underline (Ctrl+U)", marks.underline, () => run("underline"), <Underline size={13} />)}
        {btn("Highlight", "Highlight", marks.mark, toggleHighlight, <Highlighter size={13} />)}
        {divider}
        {btn("Numbered list", "Numbered list", marks.ol, () => run("insertOrderedList"), <ListOrdered size={13} />)}
        {btn("Bulleted list", "Bulleted list", marks.ul, () => run("insertUnorderedList"), <List size={13} />)}
        {divider}
        {onPromptLink &&
          btn(
            marks.link ? "Remove link" : "Link",
            marks.link ? "Remove link" : "Link (Ctrl+K)",
            marks.link,
            () => void toggleLink(),
            <LinkIcon size={13} />,
          )}
        {btn("Insert table", "Insert table", false, insertTable, <TableIcon size={13} />)}
        {onInsertImage &&
          btn(
            "Insert image",
            busy ? "Uploading…" : "Insert image",
            false,
            () => fileRef.current?.click(),
            <ImageIcon size={13} />,
            busy,
          )}
        {btn("Clear formatting", "Clear formatting", false, clearFormatting, <RemoveFormatting size={13} />)}
        {divider}
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
        {onInsertImage && (
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Image file"
            onChange={(e) => void onPickImage(e.target.files?.[0])}
          />
        )}
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
        onKeyDown={(e) => {
          if (onPromptLink && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            void toggleLink();
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          if (text) exec("insertText", text);
        }}
      />
    </div>
  );
}
