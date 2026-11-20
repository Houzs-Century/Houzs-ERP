import type { DirectoryEntry } from "./RecipientPicker";
import { parseRecipients } from "./mail-recipients";

export interface KnownRecipient {
  email: string;
  name: string;
  timesUsed: number;
  lastUsedAt: string;
}

export interface RecipientSuggestion {
  email: string;
  name: string;
  detail: string;
}

export const SUGGESTION_LIMIT = 6;

const SEPARATOR = /[,;]/;

function lastSeparatorIndex(raw: string): number {
  for (let i = raw.length - 1; i >= 0; i--) {
    if (SEPARATOR.test(raw[i])) return i;
  }
  return -1;
}

export function typedTerm(raw: string): string {
  return raw.slice(lastSeparatorIndex(raw) + 1).trim();
}

export function replaceTypedTerm(raw: string, email: string): string {
  const kept = raw.slice(0, lastSeparatorIndex(raw) + 1).trim();
  return `${kept ? `${kept} ` : ""}${email}, `;
}

function fromHistory(known: KnownRecipient): RecipientSuggestion {
  return { email: known.email.toLowerCase(), name: known.name, detail: "" };
}

function fromDirectory(entry: DirectoryEntry): RecipientSuggestion {
  return {
    email: entry.email.toLowerCase(),
    name: entry.name === entry.email ? "" : entry.name,
    detail: [entry.position, entry.department].filter(Boolean).join(" · "),
  };
}

export function suggestRecipients(
  raw: string,
  history: KnownRecipient[],
  directory: DirectoryEntry[],
): RecipientSuggestion[] {
  const term = typedTerm(raw).toLowerCase();
  if (!term) return [];
  const onField = new Set(parseRecipients(raw).map((address) => address.toLowerCase()));
  const seen = new Set<string>();
  const matches: RecipientSuggestion[] = [];
  for (const suggestion of [...history.map(fromHistory), ...directory.map(fromDirectory)]) {
    if (seen.has(suggestion.email) || onField.has(suggestion.email)) continue;
    seen.add(suggestion.email);
    if (suggestion.email.includes(term) || suggestion.name.toLowerCase().includes(term)) {
      matches.push(suggestion);
    }
  }
  const startsWithTerm = (suggestion: RecipientSuggestion): boolean =>
    suggestion.email.startsWith(term) || suggestion.name.toLowerCase().startsWith(term);
  const laterMatches = matches.filter((suggestion) => !startsWithTerm(suggestion));
  return [...matches.filter(startsWithTerm), ...laterMatches].slice(0, SUGGESTION_LIMIT);
}
