
/** Remove `/* … *\/` blocks (a JSX `{/* … *\/}` comment is one) and whole-line
 *  `//` comments, leaving only code a scan should consider live. */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}
