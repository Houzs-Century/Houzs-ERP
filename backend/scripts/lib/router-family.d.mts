// Types for router-family.mjs, which stays plain ESM so node scripts
// (check-workflow-consistency.mjs) and TypeScript tests share one implementation.
export function blankComments(src: string): string;
export function importSpecifiers(code: string): Map<string, string>;
export function expandRouterFamily(
  entry: string,
  readSource: (key: string) => string | null,
): { source: string; files: string[]; origins: Array<{ file: string; line: number }> };
