type ClassValue = string | number | null | false | undefined;

export function clsx(...inputs: ClassValue[]): string {
  let out = '';
  for (const i of inputs) {
    if (!i) continue;
    out += (out ? ' ' : '') + i;
  }
  return out;
}

export default clsx;
