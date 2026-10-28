// Tiny clsx shim (vendored). 2990's design-system imports `clsx` from the
// npm package; Houzs doesn't have it installed and we must not run npm install,
// so this provides the exact subset the design-system uses: truthy-join of
// string / number / falsy class values. Mirrors clsx's default-export call
// signature (`clsx(...inputs)`) so the verbatim component code works unchanged.
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
