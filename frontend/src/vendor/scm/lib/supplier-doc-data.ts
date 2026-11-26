
import { authedFetch } from './authed-fetch';
import { makeSupplierDocLoaders } from '../../../../../shared/src/vendor/scm/lib/supplier-doc-data-core';

export * from '../../../../../shared/src/vendor/scm/lib/supplier-doc-data-core';

const loaders = makeSupplierDocLoaders((path) => authedFetch(path));

export const {
  loadFabricSupplierMap,
  loadFabricDescriptionMap,
  loadSupplierSkuMap,
  loadSupplierRecord,
  loadSupplierDocData,
  loadCustomerFabricMaps,
} = loaders;
