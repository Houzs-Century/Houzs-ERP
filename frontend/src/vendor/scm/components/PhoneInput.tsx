// PhoneInput — country-selectable phone field (request 2026-06-05:
// "电话号码 +60 格式可以选择国家，默认马来西亚").
//
// A searchable country combobox (defaults to Malaysia +60) + a national-number
// input. The parent state always holds the canonical E.164 storage form
// ("+60116155633") via onChange, so submission to the API is already correct
// and the API's defensive normalizePhone keeps any explicit country code.
// The shared country list + split/combine helpers live in @2990s/shared/phone,
// so the Backend and the POS share the exact same behaviour.
//
// UX (owner 2026-07-23): the previous <select> could not be searched — its
// options rendered only "🇲🇾 +60" (flag + dial), so native type-ahead had a
// flag emoji as the first character and typing "MY"/"马"/"60" jumped nowhere,
// forcing a scroll through 25 rows. This replaces it with a filterable panel:
// type a country name (EN or 中文), ISO code, or dial code to locate it.
//
// Deliberately self-contained (inline styles, no Tailwind / app-util imports)
// so the component stays portable to the POS. Colours mirror the app palette
// (tailwind.config.js · "Ink & Petrol").
//
// The country panel is PORTALLED to <body> and positioned `fixed` from the
// trigger's rect — same idiom as StatePicker / SoLineCard / SearchableSelect.
// It was `position: absolute` inside the field until 2026-08-15, and every
// address form puts this field in a card that clips its overflow: measured on
// prod's New Sales Order, the 287px panel had 247px sliced off by
// `SalesOrderNew.module.css .card { overflow: hidden }`, leaving the search box
// and not one country.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { COUNTRY_DIAL_CODES, splitE164, combineE164 } from '@2990s/shared/phone';
import { useAnchoredPanel, anchoredPanelStyle } from '../../../lib/anchoredPanel';

// Chinese / common search aliases so typing "马"/"新"/"中" locates the country.
// Frontend-side only (search is a UI concern) — keeps the mirrored phone.ts
// data model untouched. Keyed by ISO; the English `name` + `dial` + `iso`
// already match on their own, this only ADDS the 中文 handles.
const SEARCH_ALIAS: Record<string, string> = {
  MY: '马来西亚 大马',
  SG: '新加坡 星',
  ID: '印尼 印度尼西亚',
  TH: '泰国',
  BN: '文莱',
  VN: '越南',
  PH: '菲律宾',
  KH: '柬埔寨',
  MM: '缅甸',
  LA: '老挝',
  CN: '中国 中',
  HK: '香港',
  TW: '台湾 台',
  IN: '印度',
  BD: '孟加拉',
  PK: '巴基斯坦',
  LK: '斯里兰卡',
  AU: '澳大利亚 澳洲',
  NZ: '新西兰',
  JP: '日本',
  KR: '韩国 南韩',
  AE: '阿联酋 阿拉伯联合酋长国',
  SA: '沙特 沙特阿拉伯',
  GB: '英国 英',
  US: '美国 加拿大 美',
};

// Palette (tailwind.config.js · "Ink & Petrol").
const C = {
  surface: '#ffffff',
  surface2: '#f4f6f3',
  border: '#d6d9d2',
  ink: '#11140f',
  inkMuted: '#767b6e',
  primary: '#16695f',
  primarySoft: '#e1efed',
};

type PhoneInputProps = {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  'aria-label'?: string;
};

export const PhoneInput = ({
  value,
  onChange,
  className,
  placeholder = '11-6155 6133',
  disabled,
  required,
  id,
  'aria-label': ariaLabel,
}: PhoneInputProps) => {
  const init = splitE164(value);
  const [dial, setDial] = useState(init.dial);
  const [national, setNational] = useState(init.national);
  const lastSynced = useRef(value);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0); // highlighted row in the filtered list
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nationalRef = useRef<HTMLInputElement>(null);

  /* Search header (~46px) + the ten-row country list this replaced a native
     <select> with. The list itself flexes, so a cramped viewport shrinks the
     rows rather than hiding the search box. */
  const panelPos = useAnchoredPanel(triggerRef, open, 300);

  // Pull external value changes (a fresh row loads) into local state, without
  // clobbering an in-progress edit (which updates lastSynced on every emit).
  useEffect(() => {
    if (lastSynced.current !== value) {
      const p = splitE164(value);
      setDial(p.dial);
      setNational(p.national);
      lastSynced.current = value;
    }
  }, [value]);

  // Close on click-outside while the panel is open. The panel is in a <body>
  // portal, so it is NOT inside rootRef in the DOM — it has to be tested
  // separately or a mousedown on a country would close the list before the
  // button's click could pick it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // On open: clear the query, reset the highlight, focus the search box.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      const t = setTimeout(() => searchRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const emit = (d: string, n: string) => {
    const next = combineE164(d, n);
    lastSynced.current = next;
    onChange(next);
  };

  const selected =
    COUNTRY_DIAL_CODES.find((c) => c.dial === dial) ?? COUNTRY_DIAL_CODES[0];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRY_DIAL_CODES;
    return COUNTRY_DIAL_CODES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.iso.toLowerCase().includes(q) ||
        c.dial.includes(q) ||
        (SEARCH_ALIAS[c.iso] ?? '').toLowerCase().includes(q),
    );
  }, [query]);

  // Keep the highlight in range as the filtered list shrinks.
  useEffect(() => {
    if (active >= filtered.length) setActive(filtered.length ? filtered.length - 1 : 0);
  }, [filtered.length, active]);

  const pick = (d: string) => {
    setDial(d);
    emit(d, national);
    setOpen(false);
    // move the operator straight to the number field
    setTimeout(() => nationalRef.current?.focus(), 0);
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = filtered[active];
      if (c) pick(c.dial);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      ref={rootRef}
      style={{ position: 'relative', display: 'flex', gap: 6, alignItems: 'stretch', minWidth: 0 }}
    >
      {/* Country trigger — opens the searchable panel. */}
      <button
        ref={triggerRef}
        type="button"
        aria-label="Country dial code"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={className}
        style={{
          flex: '0 0 auto',
          width: 96,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 4,
          cursor: disabled ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <span>
          {selected.flag} +{selected.dial}
        </span>
        <span aria-hidden style={{ color: C.inkMuted, fontSize: 10 }}>▾</span>
      </button>

      {open && panelPos && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          style={{
            ...anchoredPanelStyle(panelPos),
            // The trigger is a 96px chip; the list needs room for a country
            // name, so it keeps its own width rather than the anchor's.
            width: 250,
            maxWidth: '80vw',
            display: 'flex',
            flexDirection: 'column',
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(17,20,15,0.14)',
            overflow: 'hidden',
          }}
        >
          <div style={{ flex: '0 0 auto', padding: 6, borderBottom: `1px solid ${C.border}` }}>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
              placeholder="搜索 / search (my · 马 · 60)"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '6px 8px',
                fontSize: 12,
                color: C.ink,
                background: C.surface2,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                outline: 'none',
              }}
            />
          </div>
          <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: 4 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '10px 8px', fontSize: 12, color: C.inkMuted }}>
                没有匹配 / no match
              </div>
            ) : (
              filtered.map((c, i) => {
                const isSel = c.dial === dial;
                const isActive = i === active;
                return (
                  <button
                    key={c.iso}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(c.dial)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '7px 8px',
                      textAlign: 'left',
                      fontSize: 12.5,
                      color: C.ink,
                      background: isActive ? C.primarySoft : 'transparent',
                      border: 'none',
                      borderRadius: 6,
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontSize: 15, lineHeight: 1 }}>{c.flag}</span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.name}
                    </span>
                    <span style={{ color: isSel ? C.primary : C.inkMuted, fontWeight: isSel ? 600 : 400 }}>
                      +{c.dial}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )}

      <input
        ref={nationalRef}
        type="tel"
        id={id}
        className={className}
        aria-label={ariaLabel}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        value={national}
        onChange={(e) => {
          let n = e.target.value.replace(/\D+/g, '');
          // Dedup a leading dial-code inside the national digits (owner
          // sighting 2026-07-22: operator typed "601161556133" with MY +60
          // selected → stored "+60601161556133", a double country code that
          // makes the number invalid). splitE164 already applies the same
          // strip on the read path; the write path was missing it.
          if (dial && n.startsWith(dial)) n = n.slice(dial.length);
          setNational(n);
          emit(dial, n);
        }}
        style={{ flex: 1, minWidth: 0 }}
      />
    </div>
  );
};
