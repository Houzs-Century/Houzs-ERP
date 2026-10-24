#!/usr/bin/env node
// check-3pl-from-ap-live.mjs — READ-ONLY launcher: runs check-3pl-from-ap-live.ts
// (the shipping 3PL bill reader + matcher on real prod bills) under tsx.
import { spawnSync } from 'node:child_process';
const r = spawnSync('npx', ['tsx', 'scripts/check-3pl-from-ap-live.ts'], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
