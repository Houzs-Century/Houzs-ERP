export const SEEDED_ITEM_GROUPS = (): Array<{ code: string; name: string; is_active: boolean }> => [
  ['SOFA', 'Sofa'], ['BEDFRAME', 'Bedframe'], ['MATTRESS', 'Mattress'], ['ACCESSORY', 'Accessory'],
  ['BEDLINES', 'Bedlines'], ['DINING', 'Dining'], ['DIFFUSER', 'Diffuser'], ['CARPET', 'Carpet'],
  ['SERVICE', 'Service'], ['FABRIC_ACCESSORY', 'Sofa Accessory'],
].map(([code, name]) => ({ code, name, is_active: true }));
