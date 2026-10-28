// SuppliersV2Route — the mount point for the VENDORED 2990's Suppliers page,
// exposed at the temporary parallel route /scm/suppliers (the native Houzs
// SCM Suppliers page at /scm/suppliers is left untouched for side-by-side
// comparison).
//
// The provider setup (NotifyProvider + ConfirmProvider + the dialog-service
// bridge) now lives in the shared <Scm2990Shell> so every vendored SCM page
// mounts the same shell. Behaviour is identical to the original inline wrapper:
// the Suppliers list never raises an in-app confirm, so adding ConfirmProvider
// to the shell is a no-op for this page.

import Scm2990Shell from './Scm2990Shell';
import { Suppliers } from './Suppliers';

export default function SuppliersV2Route() {
  return (
    <Scm2990Shell>
      <Suppliers />
    </Scm2990Shell>
  );
}
