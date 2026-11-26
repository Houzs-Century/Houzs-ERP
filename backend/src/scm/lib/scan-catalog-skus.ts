
export type ScanCatalogRow = {
  code: string;
  name: string;
  category: string;
  base_model: string | null;
  model?: { active?: boolean | null } | Array<{ active?: boolean | null }> | null;
};

export type CatalogSku = { code: string; name: string; category: string; baseModel: string | null };

export function scanCatalogSkus(rows: ScanCatalogRow[] | null): CatalogSku[] {
  return (rows ?? [])
    .filter((p) => (Array.isArray(p.model) ? p.model[0] : p.model)?.active !== false)
    .map((p) => ({ code: p.code, name: p.name, category: p.category, baseModel: p.base_model ?? null }));
}
