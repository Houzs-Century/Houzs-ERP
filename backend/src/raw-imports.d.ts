/* Vite's `?raw` suffix imports a file as a string. Tests use it to assert
   against SOURCE that tsc never compiles — AcSyncService.cs (the AutoCount half
   of the write-back, a .NET program) and the scm schema dump. `backend/tests/`
   has done this since soConfirmGateWiring.test.ts, but that directory is not in
   tsconfig's `include`; a suite under `src/` is, so the pattern needs declaring. */
declare module '*?raw' {
  const content: string;
  export default content;
}
