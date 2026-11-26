// The From header for a Mail Center send: `"Staff Name (Company)" <address>`, so
// the recipient sees who wrote it and which company it is from. Quoted because
// a bare "(Company)" is an RFC 5322 comment that strict clients drop.
export function senderFrom(staffName: string, companyName: string, address: string): string {
  const name = staffName.trim();
  const display = name ? `${name} (${companyName})` : companyName;
  return `"${display.replace(/[\\"]/g, "\\$&")}" <${address}>`;
}
