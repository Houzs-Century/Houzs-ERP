import type { Env } from "../types";
import { getBrandingForCompany } from "../services/branding";

/** The From header for a Mail Center send: `"Staff Name (Company)" <address>`.
 *  Quoted because a bare "(Company)" is an RFC 5322 comment strict clients drop. */
export function formatSenderFrom(staffName: string, companyName: string, address: string): string {
  const name = staffName.trim();
  const display = name ? `${name} (${companyName})` : companyName;
  return `"${display.replace(/[\\"]/g, "\\$&")}" <${address}>`;
}

export async function senderFrom(env: Env, staffName: string, companyCode: string, address: string): Promise<string | undefined> {
  if (!address) return undefined;
  const branding = await getBrandingForCompany(env, companyCode);
  return formatSenderFrom(staffName, branding.companyName, address);
}
