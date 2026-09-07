# Rebuild AcSyncService on the AutoCount host and swap it in - one command.
#
# WHY THIS EXISTS. The rebuild was a LINQPad query on one machine plus a written
# ritual: substitute the placeholder in three methods, compile with nine
# references, back the exe up, stop, copy, start, health-check, delete the
# substituted source because it holds the password. Every one of those steps is
# a step somebody can skip, and the migration record already carries two
# defects that reached the running exe because the build had no gate:
# an uncompilable over-transfer handler, and a /health that named a book the
# service was not connected to.
#
# This script is that ritual, in order, with the two things a ritual cannot do:
# it REFUSES to swap an exe that did not compile, and it ROLLS BACK by itself
# if the new exe does not answer /health with the expected book.
#
# It must run ON THE HOST, because that is where the SQL credentials are
# (C:\InistateConnector\setup.json) and they are compiled into the exe. To ask
# only "does the source compile", use build-local.ps1 - that runs anywhere with
# AutoCount 2.2 installed and never touches a credential.
#
#   powershell -ExecutionPolicy Bypass -File deploy-on-host.ps1
#   powershell -ExecutionPolicy Bypass -File deploy-on-host.ps1 -DryRun
#
# The password is read, substituted and deleted. It is never printed, never
# logged, and the substituted source is removed even when the script fails.
#
# ---------------------------------------------------------------------------
# ORDER IS THE DESIGN, and it changed on 2026-08-16 after this script caused a
# production outage. Two rules now hold:
#
#   EVERYTHING THAT CAN REFUSE, REFUSES BEFORE THE SERVICE STOPS. A deploy that
#   discovers a problem after the stop has already cost an outage; the same
#   discovery before the stop costs nothing. That is why the SQL connection is
#   OPENED for real in section 3, long before anything is touched.
#
#   THE LAST THING PRINTED, ON EVERY PATH INCLUDING EVERY FAILURE, IS WHETHER
#   SOMETHING IS LISTENING. Exiting with the service down is possible - a host
#   can defeat any script - but exiting QUIETLY with the service down is not.
#
#   1 preflight        source, AutoCount 2.2, csc, key file, port file
#   2 connection line  assembled from setup.json, or read from -DbLineFile
#   3 SQL pre-flight   the assembled connection is opened. NOTHING TOUCHED YET
#   4 substitute + compile                          (still nothing touched)
#   5 back up the running exe - it is still running, reading it is allowed
#   6 stop, wait for the handle, swap, verify the copy landed, start
#   7 verify /health AND /ensure-masters; roll back if either is wrong
#   8 final check      is anything listening?
#
# 5 to 7 sit inside one try/catch, because they are the window in which this
# run owns whether the service is up. Anything unexpected in there routes to 8
# instead of ending the script on a stack trace.
#
# EXIT CODES
#   0  deployed, verified, listening. Or a clean -DryRun.
#   1  refused, or rolled back, and the service IS running.
#   2  THE SERVICE IS NOT RUNNING. Read the last block of output.

param(
  [switch] $DryRun,
  [string] $AutoCountDir = "C:\Program Files\AutoCount\Accounting 2.2",
  [string] $Source       = "$PSScriptRoot\AcSyncService.cs",
  [string] $TargetDir    = "C:\Temp",
  [string] $SetupJson    = "C:\InistateConnector\setup.json",
  [string] $DbLineFile   = "",
  [string] $Server       = "",
  [string] $Book         = "AED_HOUZS",
  [int]    $ExpectPort   = 8900,
  [string] $PortFile     = "C:\Temp\ac-svc-port.txt",
  [string] $KeyFile      = "C:\Temp\ac-svc-key.txt",
  # The AutoCount APPLICATION login the service authenticates as (line 1 the
  # user id, line 2 the password). A FILE and not a parameter, for the reason
  # this script already gives for the DB password: argv is world-readable in a
  # process list. Absent, the login falls back to setup.json's own user /
  # password, which is what the service used before 2026-09-07 - so a deploy
  # that is asked for nothing new changes nothing. See AcSyncService.cs's USER.
  [string] $AcLoginFile  = "C:\Temp\ac-svc-login.txt"
)

$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "  $m" -ForegroundColor Gray }
function Ok($m)   { Write-Host "OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }

$exe     = Join-Path $TargetDir "AcSyncService.exe"
$prev    = Join-Path $TargetDir "AcSyncService.prev.exe"
$buildCs = Join-Path $PSScriptRoot "AcSyncService.build.cs"
$newExe  = Join-Path $env:TEMP ("AcSyncService.new." + [Guid]::NewGuid().ToString('N') + ".exe")

# Set the moment THIS run becomes responsible for whether the service is up -
# when it stops one, and again when it overwrites the exe. It is what lets the
# final check tell "I broke it" apart from "it was already down when I got
# here", and the repo's standing rule is that a check may only blame the actor
# for something the actor did.
$script:ServiceTouched = $false
# Whether a running process was stopped, which is a narrower thing: it decides
# one line of console output, not blame.
$script:ServiceStopped = $false
# Set by Complete-Exit immediately before it exits. PowerShell does NOT let a
# catch block intercept `exit`, so this should never be read - but the swap
# below runs inside a try/catch and that assumption is not something this
# script can test on the machine it was written on. If it is ever wrong, the
# catch re-exits with the code Complete-Exit already decided instead of
# reporting a phantom error over a successful deploy.
$script:ExitCode = $null
# The DB password, once known, so it can be scrubbed out of anything printed.
$script:DbPassword = ''
# The AutoCount APPLICATION password, same rule. It is a SECOND secret since
# 2026-09-07 - before that the login sent the user id as its own password, so
# there was nothing here to leak that DbPassword did not already cover.
$script:AcPassword = ''

# ------------------------------------------------------------------ helpers

function Protect-Secret([string] $Text, [int] $SqlNumber) {
  # 18456 is "Login failed for user 'X'." - the one SQL error whose text quotes
  # a credential back at you. This script's standing property is that
  # credentials are never printed, so that error is DESCRIBED, never quoted.
  if ($SqlNumber -eq 18456) {
    return "login failed - the SQL server rejected the credentials from setup.json (SQL error 18456). Credentials not shown."
  }
  if (-not $Text) { return $Text }
  if ($script:DbPassword) { $Text = $Text.Replace($script:DbPassword, '<password>') }
  if ($script:AcPassword) { $Text = $Text.Replace($script:AcPassword, '<ac-password>') }
  return $Text
}

function Call($path, $body) {
  try {
    if (-not (Test-Path $KeyFile)) { return @{ code = 0; body = "" } }
    $req = [Net.HttpWebRequest]::Create("http://localhost:$ExpectPort$path")
    $req.Method = "POST"; $req.ContentType = "application/json"; $req.Timeout = 120000
    $req.Headers.Add("X-API-KEY", (Get-Content $KeyFile -Raw).Trim())
    $b = [Text.Encoding]::UTF8.GetBytes($body)
    $req.ContentLength = $b.Length
    if ($b.Length) { $s = $req.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close() }
    $r = $req.GetResponse()
    return @{ code = [int]$r.StatusCode; body = (New-Object IO.StreamReader($r.GetResponseStream())).ReadToEnd() }
  } catch {
    $r = $_.Exception.Response
    if ($r) { return @{ code = [int]$r.StatusCode; body = (New-Object IO.StreamReader($r.GetResponseStream())).ReadToEnd() } }
    return @{ code = 0; body = $_.Exception.Message }
  }
}

# Poll rather than sleep-then-hope. The old code slept 3s, asked once, slept 5s,
# asked once more; a host under load needs longer and a fast one needs none.
function Wait-Health([int] $TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ($true) {
    $h = (Call "/health" "").body
    if ($h -and $h -match '"ok"\s*:\s*true') { return $h }
    if ((Get-Date) -ge $deadline) { return $null }
    Start-Sleep -Milliseconds 500
  }
}

# THE BUG THIS FUNCTION EXISTS FOR. Stop-Process -Force signals the process and
# RETURNS; it does not wait, and Windows keeps the image file open until the
# process is really gone. On 2026-08-16 the rollback killed the new service and
# copied over C:\Temp\AcSyncService.exe on the next line, the copy threw "being
# used by another process", $ErrorActionPreference='Stop' killed the script, and
# the host was left with NOTHING running. Wait for the exit, then wait for the
# handle - they are two different things.
function Stop-AcSyncAndWait([int] $TimeoutSec) {
  $procs = @(Get-Process -Name "AcSyncService" -ErrorAction SilentlyContinue)
  if (-not $procs) { return $true }
  $script:ServiceStopped = $true
  $script:ServiceTouched = $true
  Step ("stopping AcSyncService (pid " + (($procs | ForEach-Object { $_.Id }) -join ',') + ")")
  foreach ($p in $procs) { try { $p.Kill() } catch { } }
  foreach ($p in $procs) { try { $null = $p.WaitForExit($TimeoutSec * 1000) } catch { } }
  # WaitForExit only covers the processes we enumerated. Poll the NAME so a
  # second instance started by another session is waited for too.
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Name "AcSyncService" -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# The process being gone is not the file being free. Ask the filesystem the
# question the copy is about to ask, and keep asking until it says yes.
function Wait-FileWritable([string] $Path, [int] $TimeoutSec) {
  if (-not (Test-Path $Path)) { return $true }
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ($true) {
    try {
      $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $fs.Close(); $fs.Dispose()
      return $true
    } catch {
      if ((Get-Date) -ge $deadline) { return $false }
      Start-Sleep -Milliseconds 250
    }
  }
}

function Get-FileFingerprint([string] $Path) {
  if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  }
  return "len:" + (Get-Item -LiteralPath $Path).Length
}

# Returns $null on success, or a message. A copy that did not throw is not a
# copy that LANDED - the destination is compared to the source before this
# returns success, because the whole rollback rests on it.
function Copy-Verified([string] $From, [string] $To, [int] $TimeoutSec) {
  if (-not (Wait-FileWritable $To $TimeoutSec)) {
    return "$To is still locked after ${TimeoutSec}s - something still has it open"
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ($true) {
    try { Copy-Item -LiteralPath $From -Destination $To -Force -ErrorAction Stop; break }
    catch {
      if ((Get-Date) -ge $deadline) { return "copy failed: $($_.Exception.Message)" }
      Start-Sleep -Milliseconds 250
    }
  }
  $a = Get-FileFingerprint $From
  $b = Get-FileFingerprint $To
  if ($a -ne $b) { return "the copy landed but $To does not match $From ($a vs $b)" }
  return $null
}

function Get-HostAddress {
  $addrs = @()
  try { $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object { $_.IPAddress }) } catch { }
  if (-not $addrs) {
    try {
      $addrs = @([Net.Dns]::GetHostAddresses([Net.Dns]::GetHostName()) |
                 Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
                 ForEach-Object { $_.ToString() })
    } catch { }
  }
  return @($addrs | Where-Object { $_ -ne '127.0.0.1' })
}

# Open the connection. Not resolve the name, not ping the host - OPEN it, with
# the same server, user, password and database the exe is about to be compiled
# with, and read DB_NAME() back so the answer is about the BOOK and not just
# the socket.
function Test-SqlOpen([string] $Srv, [string] $User, [string] $Pass, [string] $Db, [int] $TimeoutSec) {
  try { Add-Type -AssemblyName System.Data -ErrorAction SilentlyContinue } catch { }
  $conn = $null
  try {
    $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $b['Data Source']     = $Srv
    $b['Initial Catalog'] = $Db
    $b['User ID']         = $User
    $b['Password']        = $Pass
    $b['Connect Timeout'] = $TimeoutSec
    $conn = New-Object System.Data.SqlClient.SqlConnection $b.ConnectionString
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = "SELECT DB_NAME()"
    $name = [string] $cmd.ExecuteScalar()
    return @{ ok = $true; db = $name; message = ''; number = 0 }
  } catch {
    # Compare the type by NAME, not with a [type] literal: a literal has to
    # resolve the assembly, and a machine where that fails would throw from
    # inside the handler that exists to report failures.
    $isSql = { param($e) $e -and $e.GetType().FullName -eq 'System.Data.SqlClient.SqlException' }
    $ex = $_.Exception
    while (-not (& $isSql $ex) -and $ex.InnerException) { $ex = $ex.InnerException }
    $num = 0
    if (& $isSql $ex) { $num = [int]$ex.Number }
    return @{ ok = $false; db = ''; message = (Protect-Secret $ex.Message $num); number = $num }
  } finally {
    if ($conn) { try { $conn.Dispose() } catch { } }
  }
}

# ------------------------------------------------------- the last act, always
# Every exit runs through here. It asks one question - is anything answering? -
# and if the answer is no AND this run is what stopped it, it says so in the
# loudest terms a console has and exits 2 rather than 1.
function Test-ServiceUp {
  $r = @{ procs = 0; health = $null; listening = $false }
  try {
    $r.procs  = @(Get-Process -Name "AcSyncService" -ErrorAction SilentlyContinue).Count
    $r.health = (Call "/health" "").body
    $r.listening = [bool]($r.health -and $r.health -match '"ok"\s*:\s*true')
  } catch { }
  return $r
}

function Complete-Exit([int] $Code, [string] $Message) {
  # The substituted source holds the password, and this function now does real
  # work (an HTTP probe) before the process ends. Delete it FIRST so the file
  # never outlives the decision to leave, whichever path got here.
  if (Test-Path $buildCs) { Remove-Item $buildCs -Force -ErrorAction SilentlyContinue }
  if ($Message) {
    if ($Code -eq 0) { Ok $Message } else { Write-Host "FAIL $Message" -ForegroundColor Red }
  }
  $s = Test-ServiceUp
  Write-Host ""
  if ($s.listening) {
    Ok "FINAL CHECK: AcSyncService is listening on port $ExpectPort - $($s.health)"
    $script:ExitCode = $Code
    exit $Code
  }
  if (-not $script:ServiceTouched) {
    # Nothing here stopped or replaced it, so nothing here is to blame - but
    # the operator still needs to know the write-back is not working.
    Warn "FINAL CHECK: nothing is answering /health on port $ExpectPort ($($s.procs) AcSyncService process(es) running)."
    Warn "             This run neither stopped nor replaced it - it was already down when this script started."
    Warn "             The ERP write-back is NOT working. Start it: $exe"
    $script:ExitCode = $Code
    exit $Code
  }
  $script:ExitCode = 2
  Write-Host ""
  Write-Host "################################################################" -ForegroundColor Red
  Write-Host "#                                                              #" -ForegroundColor Red
  Write-Host "#   THE AUTOCOUNT SERVICE IS DOWN, AND THIS DEPLOY IS WHY.     #" -ForegroundColor Red
  Write-Host "#   ERP write-back is dead until something is running again.   #" -ForegroundColor Red
  Write-Host "#   DO NOT WALK AWAY FROM THIS CONSOLE.                        #" -ForegroundColor Red
  Write-Host "#                                                              #" -ForegroundColor Red
  Write-Host "################################################################" -ForegroundColor Red
  Write-Host ("  AcSyncService processes : " + $s.procs) -ForegroundColor Red
  Write-Host ("  /health                 : " + $(if ($s.health) { $s.health } else { "no answer" })) -ForegroundColor Red
  Write-Host ""
  Write-Host "  Recover by hand, in this order:" -ForegroundColor Yellow
  Write-Host "    powershell -Command `"Get-Process AcSyncService -EA SilentlyContinue | Stop-Process -Force`"" -ForegroundColor Yellow
  if (Test-Path $prev) {
    Write-Host "    copy /Y `"$prev`" `"$exe`"" -ForegroundColor Yellow
  } else {
    Write-Host "    (there is no $prev - whatever is at $exe is all there is)" -ForegroundColor Yellow
  }
  Write-Host "    start `"`" `"$exe`"" -ForegroundColor Yellow
  Write-Host "    curl -X POST http://localhost:$ExpectPort/health -H `"X-API-KEY: %ACKEY%`"" -ForegroundColor Yellow
  Write-Host "  Service log: $TargetDir\ac-sync-service.log" -ForegroundColor Yellow
  exit 2
}

function Die($m) { Complete-Exit 1 $m }

Write-Host "=== AcSyncService rebuild and swap ===" -ForegroundColor Cyan

# ---------------------------------------------------------------- 1 preflight
if (-not (Test-Path $Source))       { Die "source not found: $Source" }
if (-not (Test-Path $AutoCountDir)) { Die "AutoCount 2.2 not found at $AutoCountDir" }
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc))          { Die "csc.exe not found (.NET Framework 4 required)" }
if (-not (Test-Path $KeyFile)) {
  Die "no API key at $KeyFile. The service is fail-closed: without it every request is refused with 503. Put the key there BEFORE swapping."
}
Ok "preflight - source, AutoCount 2.2, csc, key file all present"

# THE PORT MUST NOT MOVE. It is 8900 and everything downstream assumes it: the
# cloudflared ingress that fronts autocount.houzscentury.com, and every runbook
# curl. The service reads the port from $PortFile - and until 2026-08-12 that
# path carried a stray 0x07 byte, so the file could never be found and the port
# was 8900 by accident. Fixing the path made the file LIVE. If one exists
# carrying anything else (8899 was the old port, pinned inside http.sys), this
# build would silently move the service and the tunnel would answer nothing.
if (Test-Path $PortFile) {
  $onDisk = (Get-Content $PortFile -Raw).Trim()
  if ($onDisk -ne "$ExpectPort") {
    Die "$PortFile says '$onDisk' but this deploy expects $ExpectPort. The service would start on the wrong port and the tunnel would stop answering. Delete the file to use $ExpectPort, or pass -ExpectPort $onDisk deliberately."
  }
  Step "port file present and says $onDisk - matches"
} else {
  Step "no port file - the service will use its built-in default $ExpectPort"
}

# ------------------------------------------------- 2 build the connection line
# Read from a prepared dbline.txt if given (the older documented procedure), or
# assemble it from setup.json. Either way the value is held in memory only.
$dbline    = $null
$preSrv    = $null   # the four fields section 3 will actually open, kept apart
$preUser   = $null   # from the C# text so the pre-flight tests values, not a
$prePass   = $null   # regex over a string that also holds a password.
$srvOrigin = $null
if ($DbLineFile) {
  if (-not (Test-Path $DbLineFile)) { Die "-DbLineFile given but not found: $DbLineFile" }
  $dbline = (Get-Content $DbLineFile -Raw).Trim()
  Step "connection line taken from $DbLineFile"
  # Recover the four fields so section 3 can still run. The line is C#, so the
  # strings are escaped; \\ and \" both unescape as "backslash then the next
  # character is literal".
  $m = [regex]::Match($dbline, 'DBSetting\s*\(\s*[^,]+,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)')
  if ($m.Success) {
    $un = { param($s) [regex]::Replace($s, '\\(.)', '$1') }
    $preSrv  = & $un $m.Groups[1].Value
    $preUser = & $un $m.Groups[2].Value
    $prePass = & $un $m.Groups[3].Value
    $srvOrigin = "the DBSetting line in $DbLineFile"
  }
} else {
  if (-not (Test-Path $SetupJson)) { Die "setup.json not found at $SetupJson. Pass -SetupJson or -DbLineFile." }
  $cfg = Get-Content $SetupJson -Raw | ConvertFrom-Json
  # The real file nests the credentials one level down, in an ARRAY:
  # { "AutoCountServers": [ { server, database, dbUsername, dbPassword, ... } ] }
  # The first version of this script only looked at the top level and refused
  # with "no username key" - correct behaviour, wrong assumption. Search the
  # top level first, then every array-valued property's first element, so the
  # shape is discovered rather than hard-coded.
  $scopes = @($cfg)
  foreach ($prop in $cfg.PSObject.Properties) {
    if ($prop.Value -is [System.Array] -and $prop.Value.Count -gt 0 -and $prop.Value[0] -is [PSCustomObject]) {
      $scopes += $prop.Value[0]
    }
  }
  $pick = {
    param($names)
    foreach ($s in $scopes) {
      foreach ($k in $names) {
        if ($s.PSObject.Properties.Name -contains $k -and "$($s.$k)".Trim()) { return $s.$k }
      }
    }
    return $null
  }
  $u = & $pick @('dbUsername','DbUsername','username','user')
  $p = & $pick @('dbPassword','DbPassword','password','pwd')
  $srv = $Server; $srvOrigin = "the -Server argument"
  if (-not $srv) { $srv = & $pick @('dbServer','DbServer','server','serverName'); $srvOrigin = "setup.json at $SetupJson" }
  $seen = ($scopes | ForEach-Object { $_.PSObject.Properties.Name }) -join ', '
  if (-not $u)   { Die "setup.json has no username key. Keys seen (top level + first element of each array): $seen" }
  if (-not $p)   { Die "setup.json has no password key. Keys seen (top level + first element of each array): $seen" }
  if (-not $srv) { Die "could not determine the SQL server. Pass -Server, or add it to setup.json." }
  # The file also NAMES a database. If it disagrees with what we are about to
  # compile in, say so - a build pointed at the wrong book is the defect this
  # whole __BOOK__ substitution exists to prevent.
  $cfgBook = & $pick @('database','Database','db')
  if ($cfgBook -and $cfgBook -ne $Book) {
    Step "NOTE: setup.json names database '$cfgBook' but this build targets '$Book' (from -Book). Proceeding with '$Book'."
  }
  # These go inside ORDINARY C# string literals, not verbatim ones, so a
  # backslash is an escape sequence. A named SQL instance is spelled
  # HOST\INSTANCE, so the unescaped form fails to compile with CS1009 on all
  # three sites - which is exactly what a hand-written dbline.txt does too.
  $cs = { param($s) $s.Replace('\', '\\').Replace('"', '\"') }
  # Shape matches build-local.ps1's dummy: (serverType, server, user, password, database)
  $dbline = 'AutoCount.Data.DBSetting db = new AutoCount.Data.DBSetting(AutoCount.Data.DBServerType.SQL2000, "' +
            (& $cs $srv) + '", "' + (& $cs $u) + '", "' + (& $cs $p) + '", "' + (& $cs $Book) + '");'
  $preSrv = $srv; $preUser = $u; $prePass = $p
  Step "connection line assembled from setup.json - server '$srv', book '$Book', credentials NOT shown"
}
if ($dbline -notmatch 'DBSetting') { Die "the connection line does not look like a DBSetting - refusing to compile it" }

# ------------------------------------- 2b the AutoCount APPLICATION login
# A DIFFERENT credential from the SQL one above, and the distinction is the
# whole point of this section: the SQL login opens the database, this one is
# what the service presents to AutoCount, and it is the name AutoCount stamps
# as the ACTOR on every document the write-back creates, edits or cancels.
#
# Until 2026-09-07 the service was hardcoded to ADMIN and sent the user id as
# its own password. Measured that day on the live book: ADMIN had created or
# last-modified 110,184 documents against 28 for every other user combined -
# ADMIN is the account the staff work in. So the write-back could not be given
# its own identity, AutoCount could not be locked for the staff without locking
# the ERP out with them, and the book could not tell the two apart.
$acUser = $null; $acPass = $null; $acOrigin = $null
$csEsc = { param($s) $s.Replace('\', '\\').Replace('"', '\"') }
if (Test-Path $AcLoginFile) {
  # Read the lines WITHOUT dropping empty ones. The first draft filtered blanks
  # and then demanded two survivors, which made the one state the live book
  # actually holds impossible to express: AOTG's `Users.Passwd` is an empty
  # string (measured 2026-09-07 - every other user's is 112 characters), so the
  # account genuinely has NO password and the file's second line has to be
  # allowed to be empty. A validator that refuses the real world is a validator
  # that gets worked around, and the work-around would have been to put some
  # made-up password in the file and wonder why the login failed.
  $acRaw = @(Get-Content $AcLoginFile)
  if ($acRaw.Count -lt 1 -or -not "$($acRaw[0])".Trim()) {
    Die "$AcLoginFile is empty - line 1 must be the AutoCount user id (line 2 is its password, and MAY be blank)."
  }
  $acUser = "$($acRaw[0])".Trim()
  $acPass = if ($acRaw.Count -ge 2) { "$($acRaw[1])".Trim() } else { '' }
  $acOrigin = $AcLoginFile
} elseif ($pick) {
  # setup.json's own `user` / `password` - NOT dbUsername / dbPassword. This is
  # the pre-2026-09-07 pair, so a host with no login file deploys exactly what
  # it deployed before and this change is invisible to it.
  $acUser = & $pick @('user','User')
  $acPass = & $pick @('password','Password')
  $acOrigin = "setup.json at $SetupJson (the pre-2026-09-07 fallback)"
}
if (-not $acUser) {
  Die ("no AutoCount application login could be resolved. Write $AcLoginFile with the user id on line 1 " +
       "and its password on line 2, or use a setup.json that carries ``user`` and ``password``.")
}
$script:AcPassword = $acPass
Step "AutoCount login '$acUser' from $acOrigin; password NOT shown"
# A blank password is ALLOWED because it is the truth about this book today, and
# refusing it would only push someone into inventing one. It is not silent: the
# whole reason to give the write-back its own login is so the staff's login can
# be locked down, and a service account with no password makes that lock
# worthless - anyone can simply log in as it. Say so on every deploy until it
# stops being true.
if (-not $acPass) {
  Step "WARNING: '$acUser' has NO PASSWORD. The service will work, but locking any other AutoCount user is pointless while this account can be logged into by name alone. Set one in User Maintenance, then put it on line 2 of $AcLoginFile and redeploy."
}
if ($prePass) { $script:DbPassword = $prePass }

# ---------------------------------------------------------- 3 SQL PRE-FLIGHT
# WHY THIS IS HERE AND NOT AFTER THE SWAP. /health answers from CONSTANTS. A
# build carrying a server the host cannot reach passes /health and fails every
# real request. Until 2026-08-16 the only thing that noticed was
# /ensure-masters, which runs AFTER the service has been stopped, the exe
# swapped and the new one started - so a three-day-stale address in a config
# file this repo does not own cost an outage instead of a refusal. On that date
# setup.json said 192.168.1.190\A2006 while the host's own addresses were
# 10.147.17.100 and 192.168.0.104, and SQL was local.
#
# Opening a connection costs seconds and changes nothing. Do it while nothing
# has been touched.
if (-not $preSrv -or -not $preUser) {
  Warn "PRE-FLIGHT NOT RUN: the connection line could not be broken back into server/user/password,"
  Warn "                    so it was not opened. This is NOT a pass - the first thing that will"
  Warn "                    find a bad server is /ensure-masters, AFTER the swap."
} else {
  Step "pre-flight: opening SQL as configured - server '$preSrv', database '$Book' (credentials NOT shown)"
  $probe = Test-SqlOpen $preSrv $preUser $prePass $Book 8
  if ($probe.ok) {
    Ok "SQL pre-flight - '$preSrv' opened database '$($probe.db)'. The connection line works."
    if ($probe.db -and $probe.db -ne $Book) {
      Die "the connection opened but landed on database '$($probe.db)', not '$Book'. Refusing to compile a build that names a book it does not reach."
    }
  } else {
    Write-Host "FAIL SQL pre-flight - the configured connection does not open." -ForegroundColor Red
    Write-Host "  server tried : '$preSrv'   (from $srvOrigin)" -ForegroundColor Red
    Write-Host "  database     : '$Book'" -ForegroundColor Red
    Write-Host "  SQL said     : $($probe.message)" -ForegroundColor Red
    $ips = Get-HostAddress
    if ($ips.Count) { Write-Host ("  this host's own IPv4 addresses: " + ($ips -join ', ')) -ForegroundColor Yellow }
    Write-Host "  If that server is on a subnet this machine is not on, the address is stale." -ForegroundColor Yellow
    Write-Host "  DO NOT EDIT setup.json - it belongs to Inistate, which is still running." -ForegroundColor Yellow
    Write-Host "  Override it here instead:  -Server '.\A2006'" -ForegroundColor Yellow

    # Name the fix rather than leaving the next person to rediscover it: probe
    # the LOCAL instance and, if it answers, print the exact command.
    $instance = ''
    if ($preSrv -match '\\(.+)$') { $instance = $Matches[1] }
    $candidates = @()
    if ($instance) { $candidates = @(".\$instance", "localhost\$instance", "$env:COMPUTERNAME\$instance") }
    else           { $candidates = @('.', 'localhost', "$env:COMPUTERNAME") }
    $candidates = @($candidates | Where-Object { $_ -and $_ -ne $preSrv } | Select-Object -Unique)
    $found = $null
    foreach ($c in $candidates) {
      $t = Test-SqlOpen $c $preUser $prePass $Book 4
      if ($t.ok) { $found = @{ srv = $c; db = $t.db }; break }
      Step "  tried '$c' - no"
    }
    if ($found) {
      Write-Host "" -ForegroundColor Yellow
      Write-Host "  A LOCAL instance DID answer: '$($found.srv)' opened database '$($found.db)'." -ForegroundColor Yellow
      Write-Host "  This script will NOT switch to it on its own. Two SQL instances can each" -ForegroundColor Yellow
      Write-Host "  hold a database called '$Book' - a restored backup is one - and pointing" -ForegroundColor Yellow
      Write-Host "  production write-back at the wrong copy is worse than a refused deploy." -ForegroundColor Yellow
      Write-Host "  If it is the right one, re-run with:" -ForegroundColor Yellow
      Write-Host "    powershell -ExecutionPolicy Bypass -File deploy-on-host.ps1 -Server '$($found.srv)' -Book '$Book'" -ForegroundColor Cyan
    }
    Die "SQL pre-flight failed. NOTHING was stopped, compiled or swapped - the running service is untouched."
  }
}

# ------------------------------------------------------------ 4 substitute
try {
  $text = Get-Content $Source -Raw
  $before = ([regex]::Matches($text, '__DBLINE__')).Count
  # FOUR since 2026-09-01 (/table-columns joined the three read paths). The
  # guard is a FLOOR, not an equality: a new read that needs the connection is a
  # normal change, and a count that has to be edited in step is a count that
  # eventually lies. It still catches the real fault -- a source where the
  # placeholder went missing entirely.
  if ($before -lt 3) {
    Step "WARNING: __DBLINE__ appears $before time(s); it is documented as appearing in at least three methods"
  }
  # String.Replace, never -replace: the connection line contains backslashes and
  # a regex replacement would eat them.
  $text = $text.Replace('__DBLINE__', $dbline).Replace('__BOOK__', $Book).
                Replace('__ACUSER__', (& $csEsc $acUser)).Replace('__ACPASS__', (& $csEsc $acPass))
  Set-Content -Path $buildCs -Value $text -Encoding UTF8

  $left = (Select-String -Path $buildCs -Pattern '__DBLINE__|__BOOK__|__ACUSER__|__ACPASS__' -AllMatches | Measure-Object).Count
  if ($left -ne 0) { Die "placeholders still present after substitution ($left). A partial replace will not compile." }
  Ok "substituted $before x __DBLINE__, __BOOK__ = '$Book', __ACUSER__ = '$acUser' (password substituted, not shown); 0 placeholders left"

  # -------------------------------------------------------------- 4b compile
  $refs = @('AutoCount.dll','AutoCount.Invoicing.dll','AutoCount.Sales.dll','AutoCount.Purchase.dll',
            'AutoCount.Accounting.dll','AutoCount.Stock.dll','AutoCount.ARAP.dll',
            'AutoCount.GeneralMaint.dll','AutoCount.StockMaint.dll') |
          ForEach-Object { '/r:' + (Join-Path $AutoCountDir $_) }
  $args = @('/nologo','/platform:x64') + $refs +
          @('/r:System.Web.Extensions.dll','/r:System.Data.dll','/r:System.Drawing.dll', "/out:$newExe", $buildCs)
  $out = & $csc @args 2>&1
  if ($LASTEXITCODE -ne 0) {
    $out | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    Die "compile failed - nothing was swapped, the running service is untouched"
  }
  Ok ("compiled - " + (Get-Item $newExe).Length + " bytes")
} finally {
  # It holds the password. Remove it whether or not anything above succeeded.
  if (Test-Path $buildCs) { Remove-Item $buildCs -Force }
}

if ($DryRun) {
  Remove-Item $newExe -Force
  Complete-Exit 0 "DRY RUN - the connection opens and the source compiles. Nothing was swapped."
}

# EVERYTHING BELOW IS WRAPPED, and that wrapper is part of the fix. From the
# backup onward this run is responsible for whether the service is up, so an
# unanticipated terminating error here - Remove-Item, Start-Process, a full
# disk - must not end the script on a PowerShell stack trace with nothing
# running and nothing said. That is exactly how 2026-08-16 ended.
try {

  # -------------------------------------------------- 5 back up BEFORE stopping
  # Reading a running image is allowed on Windows, so the rollback target can be
  # taken while the service is still up. That ordering matters: if the backup
  # cannot be made, this refuses without ever creating an outage window.
  if (Test-Path $exe) {
    $err = Copy-Verified $exe $prev 30
    if ($err) { Die "could not take the rollback backup ($prev): $err. Refusing to swap without one - nothing was stopped." }
    Ok "rollback backup taken: $prev (verified against $exe)"
  } else {
    Step "no $exe yet - first install, so there is no rollback target"
  }

  # ---------------------------------------------------- 6 stop, swap, start

  # One implementation, used by both the failed-swap path and the failed-verify
  # path. It does the four things the old rollback did not: WAIT for the process,
  # WAIT for the handle, VERIFY the copy landed, and CONFIRM the restored exe
  # answers before it reports.
  function Invoke-Rollback([string] $Why) {
    Write-Host "ROLLING BACK: $Why" -ForegroundColor Red
    if (-not (Test-Path $prev)) {
      # Do NOT stop the running process to reach a state with nothing running.
      # A service that answers but fails its database is worth more than none.
      Warn "there is no $prev to restore, so nothing here will be stopped."
      if (-not (Get-Process -Name "AcSyncService" -ErrorAction SilentlyContinue)) {
        Step "nothing is running - starting $exe rather than leaving the host with no service"
        try { Start-Process -FilePath $exe -WindowStyle Hidden } catch { Warn "could not start ${exe}: $($_.Exception.Message)" }
        $null = Wait-Health 30
      } else {
        Warn "the newly-swapped exe has been LEFT RUNNING. Decide whether to keep it."
      }
      Die "$Why - and there was no previous exe to roll back to."
    }
    if (-not (Stop-AcSyncAndWait 30)) {
      Warn "an AcSyncService process is STILL running after 30s. Attempting the restore anyway."
    }
    $err = Copy-Verified $prev $exe 30
    if ($err) { Write-Host "  RESTORE COPY FAILED: $err" -ForegroundColor Red }
    else      { Ok "restored $prev over $exe - copy verified by hash" }
    Step "starting $exe"
    try { Start-Process -FilePath $exe -WindowStyle Hidden } catch { Write-Host "  could not start ${exe}: $($_.Exception.Message)" -ForegroundColor Red }
    $h2 = Wait-Health 30
    if ($h2) { Ok "the restored exe answers /health: $h2" }
    else     { Write-Host "  the restored exe did NOT answer /health within 30s." -ForegroundColor Red }
    Die "rolled back. $Why"
  }

  if (-not (Stop-AcSyncAndWait 30)) {
    Die "an AcSyncService process is still running 30s after being killed. Refusing to overwrite $exe underneath it - the copy would fail and leave the host with a half-written exe. Nothing was swapped."
  }
  if (-not $script:ServiceStopped) { Step "no AcSyncService process was running" }

  # The point of no return: from here the exe on disk is this run's doing, so the
  # final check may blame this run for the service being down even on a host where
  # nothing was running when we arrived.
  $script:ServiceTouched = $true
  $err = Copy-Verified $newExe $exe 30
  if ($err) {
    Write-Host "the swap copy failed: $err" -ForegroundColor Red
    Invoke-Rollback "the new exe could not be copied into place"
  }
  Remove-Item $newExe -Force
  Ok "swapped in the new exe - copy verified by hash"

  Start-Process -FilePath $exe -WindowStyle Hidden

  # -------------------------------------------- 7 verify, and roll back if wrong
  $h = Wait-Health 30

  # /health answers from CONSTANTS. It proves the process is up and which book it
  # was COMPILED for - it opens no database, so it cannot tell you the connection
  # line works. Section 3 now opens the connection before anything is touched, so
  # this is the second half of the same question: the exe that is RUNNING can
  # reach the book, not just the PowerShell session that built it.
  # /ensure-masters with an EMPTY payload is the cheapest honest probe:
  # EnsureMasters() opens the session on its first line and the empty arrays
  # create nothing.
  $db = Call "/ensure-masters" '{"Items":[],"Agents":[],"Creditors":[],"Locations":[],"UdfOptions":[]}'

  if ($h -and $h -match [regex]::Escape($Book) -and $db.code -eq 200) {
    Ok "health: $h"
    Ok "database reachable: /ensure-masters answered $($db.code) - the connection line works"
    Ok "listening on port $ExpectPort, as expected"
    Write-Host ""
    Write-Host "DONE. Rollback if you ever need it: stop AcSyncService, copy $prev over $exe, start it." -ForegroundColor Cyan
    Complete-Exit 0 ""
  }

  Write-Host "the new exe did not pass verification" -ForegroundColor Red
  Write-Host ("  /health         : " + $(if ($h) { $h } else { "nothing" })) -ForegroundColor Red
  Write-Host ("  /ensure-masters : " + $db.code + " " + (Protect-Secret $db.body 0)) -ForegroundColor Red
  if ($db.code -ne 200 -and $db.body -match 'Locating Server') {
    Write-Host "  That error is the SQL server name, not the code - and section 3 opened it" -ForegroundColor Yellow
    Write-Host "  from THIS session, so the exe is reaching a different one. Pass -Server with" -ForegroundColor Yellow
    Write-Host "  the name the host resolves (the LINQPad connection uses '.\A2006')." -ForegroundColor Yellow
  }
  Invoke-Rollback "the new exe did not pass verification"

} catch {
  # A deliberate exit that has already run the final check. Nothing to add.
  if ($null -ne $script:ExitCode) { exit $script:ExitCode }
  # $ErrorActionPreference is Stop, so anything unexpected lands here rather
  # than killing the script mid-swap. Report it, then fall through to the
  # final listening check like every other exit.
  Write-Host "UNHANDLED ERROR during the swap: $($_.Exception.Message)" -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor Red }
  Complete-Exit 1 "the deploy hit an unhandled error after it had started changing things"
}
