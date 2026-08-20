## The AutoCount deploy tested its SQL connection only AFTER stopping the service [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Same run, 2026-08-16. The deploy read the server from `setup.json`,
compiled 77,824 bytes, stopped the running service, swapped the exe, started it,
and only then discovered the address was unreachable:

```
connection line assembled from setup.json — server '192.168.1.190\A2006'
/ensure-masters: (500) ... error: 26 - Error Locating Server/Instance Specified
```

A whole deploy cycle plus a service stop, spent on a string that could have been
checked in seconds.

**Root cause (traced).** SQL is LOCAL to that box and `setup.json`'s address
points at a subnet the machine is not on. Measured on the host: `.\A2006` and
`localhost\A2006` both resolve to `DESKTOP-TQ4S0IT\A2006`; `192.168.1.190\A2006`
fails with error 26. The host's own addresses are `10.147.17.100`,
`192.168.0.104` and `169.254.*`. Nothing in the script asked the question early:
`/health` answers from compile-time CONSTANTS and passes regardless, so
`/ensure-masters` — which runs after the stop, the swap and the start — was the
first thing that could notice.

**Fix.** A SQL pre-flight in section 3, before substitution, compile, backup or
stop: it opens a real `SqlConnection` with the same server, user, password and
book the exe is about to be compiled with, and reads `DB_NAME()` back so the
answer is about the BOOK and not just the socket. On failure it names the server
tried and where it came from, prints the host's own IPv4 addresses, says
`-Server '.\A2006'` is the override, and refuses having changed nothing. It then
probes the local instance and, if one answers, prints the exact re-run command.
It does **not** switch automatically: two SQL instances can each hold a database
called `AED_HOUZS` — a restored backup is one — and pointing production
write-back at the wrong copy silently is worse than a refused deploy.

**`setup.json` was deliberately NOT changed.** It lives at
`C:\InistateConnector\setup.json` and belongs to Inistate, the system this ERP
is replacing and which is still running. `-Server` is our side of the fix.

**An unresolved contradiction, recorded not bridged.**
`docs/autocount-handling-listing.md` said the file names `192.168.1.198\A2006`;
this transcript read `192.168.1.190\A2006`. One is wrong or the file changed, and
nobody has looked — so the doc now carries the contradiction instead of a
number. Both are on a subnet the host is not on, so no conclusion here depends
on it, and the next run prints the server it read before touching anything.

**Ref.** fix/acsync-deploy-rollback-preflight, 2026-08-16.
