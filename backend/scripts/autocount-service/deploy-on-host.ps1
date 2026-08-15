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
  [string] $KeyFile      = "C:\Temp\ac-svc-key.txt"
)

$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "  $m" -ForegroundColor Gray }
function Ok($m)   { Write-Host "OK   $m" -ForegroundColor Green }
function Die($m)  { Write-Host "FAIL $m" -ForegroundColor Red; exit 1 }

$exe     = Join-Path $TargetDir "AcSyncService.exe"
$prev    = Join-Path $TargetDir "AcSyncService.prev.exe"
$buildCs = Join-Path $PSScriptRoot "AcSyncService.build.cs"
$newExe  = Join-Path $env:TEMP ("AcSyncService.new." + [Guid]::NewGuid().ToString('N') + ".exe")

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
$dbline = $null
if ($DbLineFile) {
  if (-not (Test-Path $DbLineFile)) { Die "-DbLineFile given but not found: $DbLineFile" }
  $dbline = (Get-Content $DbLineFile -Raw).Trim()
  Step "connection line taken from $DbLineFile"
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
  $srv = $Server; if (-not $srv) { $srv = & $pick @('dbServer','DbServer','server','serverName') }
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
  Step "connection line assembled from setup.json - server '$srv', book '$Book', credentials NOT shown"
}
if ($dbline -notmatch 'DBSetting') { Die "the connection line does not look like a DBSetting - refusing to compile it" }

# ------------------------------------------------------------ 3 substitute
try {
  $text = Get-Content $Source -Raw
  $before = ([regex]::Matches($text, '__DBLINE__')).Count
  if ($before -lt 3) {
    Step "WARNING: __DBLINE__ appears $before time(s); it is documented as appearing in three methods"
  }
  # String.Replace, never -replace: the connection line contains backslashes and
  # a regex replacement would eat them.
  $text = $text.Replace('__DBLINE__', $dbline).Replace('__BOOK__', $Book)
  Set-Content -Path $buildCs -Value $text -Encoding UTF8

  $left = (Select-String -Path $buildCs -Pattern '__DBLINE__|__BOOK__' -AllMatches | Measure-Object).Count
  if ($left -ne 0) { Die "placeholders still present after substitution ($left). A partial replace will not compile." }
  Ok "substituted $before x __DBLINE__ and __BOOK__ = '$Book'; 0 placeholders left"

  # -------------------------------------------------------------- 4 compile
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
  Ok "DRY RUN - compiled cleanly, nothing swapped. Discarding the new exe."
  Remove-Item $newExe -Force
  exit 0
}

# ------------------------------------------------------ 5 stop, back up, swap
$running = Get-Process -Name "AcSyncService" -ErrorAction SilentlyContinue
if ($running) { Step "stopping the running service (pid $($running.Id -join ','))"; $running | Stop-Process -Force; Start-Sleep -Seconds 2 }
else { Step "no AcSyncService process was running" }

if (Test-Path $exe) {
  Copy-Item $exe $prev -Force
  Step "previous exe kept as $prev - this is the rollback"
}
Copy-Item $newExe $exe -Force
Remove-Item $newExe -Force
Ok "swapped in the new exe"

Start-Process -FilePath $exe -WindowStyle Hidden
Start-Sleep -Seconds 3

# -------------------------------------------- 6 verify, and roll back if wrong
function Call($path, $body) {
  try {
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

$h = (Call "/health" "").body
if (-not $h) { Start-Sleep -Seconds 5; $h = (Call "/health" "").body }

# /health answers from CONSTANTS. It proves the process is up and which book it
# was COMPILED for - it opens no database, so it cannot tell you the connection
# line works. A build carrying a server name the host cannot resolve passes
# /health and then fails every real request with
# "Error Locating Server/Instance Specified". That happened on 2026-08-12 and
# the swap was accepted because health was the only gate. /ensure-masters with
# an EMPTY payload is the cheapest honest probe: EnsureMasters() opens the
# session on its first line and the empty arrays create nothing.
$db = Call "/ensure-masters" '{"Items":[],"Agents":[],"Creditors":[],"Locations":[],"UdfOptions":[]}'

if ($h -and $h -match '"ok"\s*:\s*true' -and $h -match [regex]::Escape($Book) -and $db.code -eq 200) {
  Ok "health: $h"
  Ok "database reachable: /ensure-masters answered $($db.code) - the connection line works"
  Ok "listening on port $ExpectPort, as expected"
  Write-Host ""
  Write-Host "DONE. Rollback if you ever need it: stop AcSyncService, copy $prev over $exe, start it." -ForegroundColor Cyan
  exit 0
}

Write-Host "the new exe did not pass verification - rolling back" -ForegroundColor Red
Write-Host ("  /health         : " + $(if ($h) { $h } else { "nothing" })) -ForegroundColor Red
Write-Host ("  /ensure-masters : " + $db.code + " " + $db.body) -ForegroundColor Red
if ($db.code -ne 200 -and $db.body -match 'Locating Server') {
  Write-Host "  That error is the SQL server name, not the code. Pass -Server with the name" -ForegroundColor Yellow
  Write-Host "  this host actually resolves (the LINQPad connection uses '.\A2006')." -ForegroundColor Yellow
}
Get-Process -Name "AcSyncService" -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path $prev) {
  Copy-Item $prev $exe -Force
  Start-Process -FilePath $exe -WindowStyle Hidden
  Start-Sleep -Seconds 3
  $h2 = (Call "/health" "").body
  Die "rolled back to the previous exe. It answers: $(if ($h2) { $h2 } else { 'nothing - check C:\Temp\ac-sync-service.log' })"
}
Die "the new exe did not come up and there was no previous exe to restore. Check C:\Temp\ac-sync-service.log"
