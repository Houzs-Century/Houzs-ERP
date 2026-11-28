
import {
  identityStorageKey,
  subscribeBrowserStorageIdentity,
} from "../../lib/storageIdentity";

export type MailDensity = "compact" | "comfortable";
export type MailReadingPane = "split" | "full";

export type MailViewPrefs = {
  density: MailDensity;
  readingPane: MailReadingPane;
  categoryTabs: boolean;
};

export type MailCategory = "all" | "primary" | "notifications";

const KEY_BASE = "houzs-mail-prefs:v2";
const currentKey = () => identityStorageKey(KEY_BASE);

const DEFAULTS: MailViewPrefs = {
  density: "compact",
  readingPane: "full",
  categoryTabs: true,
};

function load(): MailViewPrefs {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const key = currentKey();
    if (!key) return { ...DEFAULTS };
    const raw = window.localStorage.getItem(key);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<MailViewPrefs>;
    return {
      density: parsed.density === "comfortable" ? "comfortable" : "compact",
      readingPane: parsed.readingPane === "split" ? "split" : "full",
      categoryTabs: parsed.categoryTabs === false ? false : true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let state: MailViewPrefs = load();
const listeners = new Set<() => void>();

function persistAndNotify(): void {
  if (typeof window !== "undefined") {
    try {
      const key = currentKey();
      if (key) window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
    }
  }
  for (const cb of listeners) {
    try {
      cb();
    } catch {
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== currentKey()) return;
    state = load();
    for (const cb of listeners) {
      try {
        cb();
      } catch {
      }
    }
  });

  subscribeBrowserStorageIdentity(() => {
    state = load();
    for (const cb of listeners) {
      try {
        cb();
      } catch {
      }
    }
  });
}

export function subscribePrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getPrefsSnapshot(): MailViewPrefs {
  return state;
}

export function setDensity(density: MailDensity): void {
  if (state.density === density) return;
  state = { ...state, density };
  persistAndNotify();
}

export function setReadingPane(readingPane: MailReadingPane): void {
  if (state.readingPane === readingPane) return;
  state = { ...state, readingPane };
  persistAndNotify();
}

export function setCategoryTabs(categoryTabs: boolean): void {
  if (state.categoryTabs === categoryTabs) return;
  state = { ...state, categoryTabs };
  persistAndNotify();
}


const AUTOMATED_LOCALPART =
  /no-?reply|do-?not-?reply|donotreply|notification|notify|alert|mailer|mailer-daemon|postmaster|eservice|e-?services|statement|auto(?:mated)?|system|noreply|bounce|newsletter|updates?/i;

const AUTOMATED_DOMAIN =
  /hongleong|hlbb|hlb\.com|uob|maybank|mbb|cimb|publicbank|pbebank|rhb|ambank|bankislam|affinbank|alliancebank|ocbc|hsbc|stripe|paypal|billplz|ipay88|senangpay|razorpay|lhdn|hasil|myinvois|kwsp|epf|perkeso|socso/i;

export function classifyCategory(
  counterpartyEmail: string | null | undefined,
): Exclude<MailCategory, "all"> {
  const email = (counterpartyEmail ?? "").trim().toLowerCase();
  if (!email) return "primary";
  const at = email.lastIndexOf("@");
  const local = at >= 0 ? email.slice(0, at) : email;
  const domain = at >= 0 ? email.slice(at + 1) : "";
  if (AUTOMATED_LOCALPART.test(local)) return "notifications";
  if (domain && AUTOMATED_DOMAIN.test(domain)) return "notifications";
  return "primary";
}
