// Dev server for the settlement test rig — DEV ONLY, not part of any build.
//
// It exists because of a real trap: authed-fetch's API_URL falls back to the
// PRODUCTION Worker whenever VITE_API_URL is unset, so a plain `npm run dev`
// points the rig's screens at the live API and every call comes back 401 — an
// empty company picker and a blank page, with the reason only visible in the
// browser console. Setting the variable is not optional, so it is not left to
// whoever remembers: `npm run dev:settlement-demo` sets it and starts Vite.
//
// (Not cross-env: this needs no dependency, and a plain PowerShell/bash
// `VITE_API_URL=… vite` is exactly the thing that differs per shell.)

import { spawn } from 'node:child_process';

const API = process.env.SETTLEMENT_DEMO_API ?? 'http://localhost:8788';
console.log(`[settlement-demo] frontend → ${API} (start the rig with: npx tsx scripts/settlement-demo-server.ts, from backend/)`);

const child = spawn('npx', ['vite'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, VITE_API_URL: API },
});
child.on('exit', (code) => process.exit(code ?? 0));
