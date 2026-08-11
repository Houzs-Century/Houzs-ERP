/* Vite's `?raw` suffix imports a module's SOURCE TEXT as a string. Used by
   suites that assert a guard is actually WIRED into its handler — scm routes
   cannot be exercised end-to-end in this harness (they ride Supabase Postgres;
   the harness rebuilds only the D1 side), so the call site is asserted on the
   source instead. tsc does not know the suffix, hence this declaration. */
declare module '*?raw' {
  const source: string;
  export default source;
}
