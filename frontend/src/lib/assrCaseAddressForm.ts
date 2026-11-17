// The service case's address editor state (owner 2026-11-17): the SO's layout —
// address lines + State / City / Postcode — seeded from the case and saved as
// one PATCH of only what changed. Lines go to assr_cases.addr1..addr4; postcode /
// city / state to assr_case_address (the server splits them). Shared by the
// desktop case page and the phone (components/assr/CaseAddressFields.tsx).

import { CASE_ADDRESS_KEYS } from "../vendor/scm/lib/assr-case-address";

export interface CaseAddressForm {
  addr1: string;
  addr2: string;
  addr3: string;
  addr4: string;
  postcode: string;
  city: string;
  state: string;
}

export const CASE_ADDRESS_FORM_KEYS = ["addr1", "addr2", "addr3", "addr4", ...CASE_ADDRESS_KEYS] as const;

const str = (v: unknown): string => (v == null ? "" : String(v));

export function seedCaseAddressForm(c: Record<string, unknown>): CaseAddressForm {
  return {
    addr1: str(c.addr1),
    addr2: str(c.addr2),
    addr3: str(c.addr3),
    addr4: str(c.addr4),
    postcode: str(c.postcode),
    city: str(c.city),
    state: str(c.state),
  };
}

/** The PATCH body for what changed (blank = null); null when nothing did. */
export function caseAddressPatch(seed: CaseAddressForm, form: CaseAddressForm): Record<string, string | null> | null {
  const body: Record<string, string | null> = {};
  for (const k of CASE_ADDRESS_FORM_KEYS) {
    const next = form[k].trim();
    if (next !== seed[k].trim()) body[k] = next === "" ? null : next;
  }
  return Object.keys(body).length ? body : null;
}
