## A snapshot timestamp that gets subtracted was written naive, so a UTC runner read it as eight hours in the future [medium]

**Symptom.** The first production dispatch of *Sync AutoCount delta (go-live)*
refused a snapshot that had been cut from the live book twenty minutes earlier
(run 34095828677):

```
##[notice]stamps snapshot: since=2026-08-29 exported=2026-09-07 15:10:27.415239 (-0.32 days old)
REFUSED: the AutoCount stamps snapshot is -0.32 days old (limit 2). Re-cut it before syncing a delta.
##[error]Process completed with exit code 2.
```

**Root cause (traced).** `backend/scripts/export-ac-reimport.py` stamped
`ac-doc-stamps.json.gz` with the module-level `NOW`, which is
`datetime.datetime.now().isoformat(sep=" ")` — no timezone. The export runs on a
UTC+8 desktop over ZeroTier; `sync-ac-delta.mjs` computes
`Date.now() - Date.parse(exportedAt)` on a UTC Actions runner, where a bare
`2026-09-07 15:10:27` means 15:10 UTC. Eight hours of offset became a snapshot
0.32 days in the FUTURE, and the staleness guard — which refuses a negative age
on purpose — fired on it.

`NOW` had been correct for its whole previous life because every other consumer
only PRINTS it. This snapshot is the first one whose timestamp is COMPARED.

**Fix.** `exportedAt` on the stamps payload is now
`datetime.datetime.now().astimezone().isoformat()` —
`2026-09-07T15:33:15.897615+08:00`, which reads identically on both clocks
(measured: age 0.0001 days from the exporting desktop). The manifest's `NOW` is
deliberately left naive: it is displayed, never subtracted, and those are not
the same requirement. The guard still refuses a future snapshot — the age is the
only thing standing between a delta apply and a stale picture of the book — but
now tolerates one hour of genuine clock skew instead of zero.

**The class.** A timestamp that is only ever printed may be naive; one that is
ever subtracted may not. When a value crosses a machine boundary, its timezone
stops being cosmetic.

**Ref.** `feat/ac-delta-sync-2026-09-07`, PR #3037, 2026-09-07.
