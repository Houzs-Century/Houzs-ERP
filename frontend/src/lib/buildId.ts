
export const BUILD_ID_META = "houzs-build-id";

export function readBuildId(doc: Document | undefined): string {
  const value = doc?.querySelector(`meta[name="${BUILD_ID_META}"]`)?.getAttribute("content")?.trim();
  return value ? value : "dev";
}

export const BUILD_ID = readBuildId(typeof document === "undefined" ? undefined : document);
