## A BEL byte in the service's port path, and the escape sequence that would have killed the rebuild [medium]

**Symptom** - none, and that is the point: nobody can see it. The AutoCount
write-back service documents its port as "a FILE, not a constant" so it can be
moved without a recompile, after 8899 turned out to be pinned inside `http.sys`
by an orphaned listener. The file it reads has never once existed.

**Root cause (traced, not guessed)** - `AcSyncService.cs` carried a raw **0x07
BEL byte** where `\a` belongs. `grep` and every editor render `C:\Temp` + BEL +
`c-svc-port.txt` as `C:\Tempc-svc-port.txt`, which reads as a missing backslash
and invites a "typo" fix; `od -c` is what showed the byte. In a C# verbatim
string that BEL is part of the path, and BEL is not a legal Windows filename
character, so `File.Exists` can never be true and the port silently falls back
to 8900 forever. Three occurrences: the header comment and both halves of the
`Url` initialiser. `docs/autocount-migration-record.md` carried the same wrong
path as ordinary text, so the doc and the code agreed - on a filename that
cannot exist. **The API key path one line below was clean**, which is the only
reason the service authenticates at all.

**A second defect found by automating the same procedure.** The connection line
is substituted into ORDINARY C# string literals, so a named SQL instance
(`HOST\INSTANCE`) is an unrecognised escape sequence: **CS1009 at all three
sites**. The documented `-replace` recipe has no escaping step, so a hand-written
`dbline.txt` compiles only if whoever wrote it happened to double the backslash.
Found by dry-running `deploy-on-host.ps1` with a named instance.

**Fix** - the BEL bytes replaced with a literal `\a` and the doc's table
corrected. New `deploy-on-host.ps1` does the whole rebuild in one command,
escapes backslashes and quotes when it assembles the line from `setup.json`,
**refuses to swap an exe that did not compile**, **rolls back by itself** if the
new exe does not answer `/health` with the expected book, and deletes the
password-bearing `AcSyncService.build.cs` in a `finally`. Deploy doc now leads
with the script and records the CS1009 trap for the manual path. Verified: clean
compile at 46,592 bytes before and after the fix, and a dry run against a
`DRYRUN\SQLEXPRESS` instance that fails CS1009 unescaped and compiles escaped.

**Lesson** - **a path that reads as a typo may be a byte.** Two reviewers and a
documentation pass agreed with a filename no filesystem could hold, because
every tool that renders text renders a BEL as nothing. When a file "does not
exist" and the path looks right, dump the bytes.

**Ref** - `fix/ac-host-deploy`, 2026-08-11

---
