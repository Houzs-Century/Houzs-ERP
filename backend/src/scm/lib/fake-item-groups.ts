/* Test fixture: scm.acc_item_groups as the migrations seed it
   (20260905T0900_acc_item_groups.sql + 20260914T2000 for Sofa Accessory), for
   the fakes that stand in for the database. A copy of DATA, not a list the app
   reads: the app reads the real table. */
export const SEEDED_ITEM_GROUPS = (): Array<{ code: string; name: string; is_active: boolean }> => [
  ['SOFA', 'Sofa'], ['BEDFRAME', 'Bedframe'], ['MATTRESS', 'Mattress'], ['ACCESSORY', 'Accessory'],
  ['BEDLINES', 'Bedlines'], ['DINING', 'Dining'], ['DIFFUSER', 'Diffuser'], ['CARPET', 'Carpet'],
  ['SERVICE', 'Service'], ['FABRIC_ACCESSORY', 'Sofa Accessory'],
].map(([code, name]) => ({ code, name, is_active: true }));
