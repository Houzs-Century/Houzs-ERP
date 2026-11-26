// ----------------------------------------------------------------------------
// supplier-doc-data — print-time lookups for documents, read with the browser's
// session (authedFetch). The rules and the loaders live in
// supplier-doc-data-core.ts, which the Worker also bundles for the AI Connector's
// get_pdf; this file binds them to authedFetch and keeps every import path.
// ----------------------------------------------------------------------------

import { authedFetch } from './authed-fetch';
import { makeSupplierDocLoaders } from './supplier-doc-data-core';

export * from './supplier-doc-data-core';

/* Called through the import binding on every read (not captured once), so a
   test that mocks ./authed-fetch still intercepts it. */
const loaders = makeSupplierDocLoaders((path) => authedFetch(path));

export const {
  loadFabricSupplierMap,
  loadFabricDescriptionMap,
  loadSupplierSkuMap,
  loadSupplierRecord,
  loadSupplierDocData,
  loadCustomerFabricMaps,
} = loaders;
