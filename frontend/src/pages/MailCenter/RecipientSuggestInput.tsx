import { useCallback, useId, useMemo, useState, type KeyboardEvent, type ReactElement } from "react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { cn } from "../../lib/utils";
import { DIRECTORY_KEY, type MailDirectory } from "./RecipientPicker";
import {
  replaceTypedTerm,
  suggestRecipients,
  typedTerm,
  type KnownRecipient,
  type RecipientSuggestion,
} from "./mail-recipient-suggest";

export const RECIPIENT_HISTORY_KEY = "/api/mail-center/recipients/history";
const SUGGESTION_STALE_MILLISECONDS = 120_000;

export interface RecipientSuggestInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder: string;
  disabled: boolean;
  invalid: boolean;
  inputClassName: string;
}

export function RecipientSuggestInput({
  value,
  onChange,
  onBlur,
  placeholder,
  disabled,
  invalid,
  inputClassName,
}: RecipientSuggestInputProps): ReactElement {
  const listId = useId();
  const history = useQuery<{ recipients: KnownRecipient[] }>(
    RECIPIENT_HISTORY_KEY,
    () => api.get(RECIPIENT_HISTORY_KEY),
    [],
    { staleTime: SUGGESTION_STALE_MILLISECONDS },
  );
  const directory = useQuery<MailDirectory>(DIRECTORY_KEY, () => api.get(DIRECTORY_KEY), [], {
    staleTime: SUGGESTION_STALE_MILLISECONDS,
  });
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const keepListInView = useCallback((node: HTMLSpanElement | null) => {
    node?.scrollIntoView({ block: "nearest" });
  }, []);

  const suggestions = useMemo(
    () =>
      suggestRecipients(value, history.data?.recipients ?? [], [
        ...(directory.data?.everyone ?? []),
        ...(directory.data?.department ?? []),
      ]),
    [value, history.data, directory.data],
  );
  const hasTerm = typedTerm(value) !== "";
  const loadError = history.error ?? directory.error;
  const isListShown = isOpen && hasTerm && (suggestions.length > 0 || loadError !== null);

  const pick = (suggestion: RecipientSuggestion): void => {
    onChange(replaceTypedTerm(value, suggestion.email));
    setActiveIndex(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!isListShown || suggestions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + step + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pick(suggestions[Math.min(activeIndex, suggestions.length - 1)]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setIsOpen(false);
    }
  };

  return (
    <span className="relative block">
      <input
        type="text"
        inputMode="email"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="next"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isListShown}
        aria-controls={listId}
        aria-activedescendant={isListShown && suggestions.length > 0 ? `${listId}-${activeIndex}` : undefined}
        aria-invalid={invalid}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
          setIsOpen(true);
          setActiveIndex(0);
        }}
        onFocus={() => setIsOpen(true)}
        onBlur={() => {
          setIsOpen(false);
          onBlur?.();
        }}
        onKeyDown={onKeyDown}
        className={inputClassName}
      />
      {isListShown && (
        <span
          id={listId}
          role="listbox"
          ref={keepListInView}
          className="absolute left-0 right-0 top-full z-30 mt-1 block overflow-hidden rounded-md border border-border bg-surface py-1 shadow-slab"
        >
          {suggestions.map((suggestion, index) => (
            <span
              key={suggestion.email}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(suggestion);
              }}
              onMouseEnter={() => setActiveIndex(index)}
              className={cn(
                "flex min-h-[44px] cursor-pointer flex-col justify-center px-3 py-1.5",
                index === activeIndex ? "bg-primary/10" : "hover:bg-surface-dim",
              )}
            >
              <span className="block truncate text-[13px] text-ink">
                {suggestion.name || suggestion.email}
              </span>
              <span className="block truncate text-[11px] text-ink-muted">
                {[suggestion.name ? suggestion.email : "", suggestion.detail].filter(Boolean).join(" · ")}
              </span>
            </span>
          ))}
          {suggestions.length === 0 && loadError !== null && (
            <span className="block px-3 py-2 text-[11px] text-err">
              Past addresses could not load. Type the full address.
            </span>
          )}
        </span>
      )}
    </span>
  );
}
