
import { authedFetch } from './authed-fetch';
import { makeSupplierDocLoaders } from './supplier-doc-data-core';

export * from './supplier-doc-data-core';

const loaders = makeSupplierDocLoaders((path) => authedFetch(path));

export const {
  loadFabricSupplierMap,
  loadFabricDescriptionMap,
  loadSupplierSkuMap,
  loadSupplierRecord,
  loadSupplierDocData,
  loadCustomerFabricMaps,
} = loaders;
