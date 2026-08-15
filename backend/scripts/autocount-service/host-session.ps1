<#
  ONE sitting on the AutoCount host: fetch main, deploy, and answer the three
  read-only questions the handling listing's section 0 lists as jobs 1-4.

  WHY THIS EXISTS. Every one of these steps has been done by hand over a remote
  desktop, and that channel is hostile in specific ways: UltraViewer does not
  pass Ctrl combinations (so no Ctrl+V, no Ctrl+A), a left-click in the console
  puts conhost into QuickEdit and FREEZES it, and right-click then COPIES rather
  than pasting, silently clobbering the clipboard. Every extra interactive step
  is a chance to lose the session. So the whole sitting is one command.

  It does NOT write to the account book. Jobs 5, 6 and 7 do, and they stay
  separate and deliberate:
    job 5  qa-convert.ps1 -IReallyMeanIt      real DO + GR running numbers
    job 6  the FurtherDescription write probe  scratch document
    job 7  one SO converted to a PO            a real PO

  Usage, on the host:
    powershell -ExecutionPolicy Bypass -File host-session.ps1

  RE-RUN: safe and idempotent. It re-fetches, re-deploys and re-reads. A second
  run leaves the same exe running and asks the same questions again.
#>

param(
  [string]$Dir     = "C:\Temp\ac-session",
  [string]$Server  = ".\A2006",
  [string]$Book    = "AED_HOUZS",
  [string]$KeyFile = "C:\Temp\ac-svc-key.txt",
  [string]$BaseUrl = "http://127.0.0.1:8900",
  [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'
function Ok  ($m) { Write-Host ("OK   " + $m) -ForegroundColor Green }
function Note($m) { Write-Host ("     " + $m) -ForegroundColor Gray }
function Bad ($m) { Write-Host ("FAIL " + $m) -ForegroundColor Red }
function Head($m) { Write-Host ""; Write-Host ("== " + $m) -ForegroundColor Cyan }

# ---------------------------------------------------------------- 1  source
Head "1  fetch the current main"
New-Item -ItemType Directory -Force $Dir | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$raw = 'https://raw.githubusercontent.com/hello-houzs/Houzs-ERP/main/backend/scripts/autocount-service/'
foreach ($f in 'AcSyncService.cs','deploy-on-host.ps1','qa-convert.ps1') {
  Invoke-WebRequest -UseBasicParsing ($raw + $f) -OutFile (Join-Path $Dir $f)
}
$svc = Join-Path $Dir 'AcSyncService.cs'
$sha = (Get-FileHash $svc -Algorithm SHA256).Hash
Ok ("fetched; AcSyncService.cs is " + (Get-Item $svc).Length + " bytes")
Note ("sha256 " + $sha)
Note "Compare that against the tree: git log -1 --format=%H -- backend/scripts/autocount-service/AcSyncService.cs"

<# The host has carried a STALE copy before — on 2026-08-15 C:\Temp held an
   08-11 build and C:\Temp\acbuild an 08-12 one, four merged PRs behind, and
   rebuilding from either would have QUIETLY REVERTED the service. Fetching
   into a dated directory of its own and printing the hash is what makes that
   visible instead of plausible. #>

# ---------------------------------------------------------------- 2  deploy
if ($SkipDeploy) {
  Head "2  deploy SKIPPED (-SkipDeploy)"
} else {
  Head "2  compile and swap  (job 1)"
  & powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $Dir 'deploy-on-host.ps1') -Server $Server -Book $Book
  if ($LASTEXITCODE -ne 0) { Bad "deploy failed - the running service was NOT swapped, and nothing below is meaningful"; exit 1 }
}

# ---------------------------------------------------------------- 3  which build
Head "3  which build is answering  (job 2)"
$key = (Get-Content $KeyFile -Raw).Trim()   # read, never printed
$hdr = @{ 'X-API-KEY' = $key }
$health = Invoke-RestMethod -Uri ($BaseUrl + '/health') -Method Post -Headers $hdr -Body '{}' -ContentType 'application/json'
$health | ConvertTo-Json -Compress | Write-Host

<# builtAt and mvid arrived with #2241. Before it, /health answered
   {ok, book, service} from CONSTANTS and there was NO way to tell which build
   was running - the exact blind spot that let a two-week-old staging build pass
   a nightly check for a fortnight. If builtAt is missing here, the exe predates
   #2241 and step 2 did not do what it said. #>
if (-not $health.builtAt) {
  Bad "/health carries no builtAt - this exe predates #2241, so the swap did not take"
} else {
  Ok ("builtAt " + $health.builtAt + "   mvid " + $health.mvid)
  Note "Older than the last commit touching AcSyncService.cs means the host is behind."
}

# ---------------------------------------------------------------- 4  the DB
Head "4  can this build reach the book  (job 3)"
<# /health opens NO database - it answers from constants, and has returned
   ok:true while the service could not connect at all. /ensure-masters with
   EMPTY arrays opens the connection and creates nothing, so it is the cheapest
   honest proof that the connection line survived the build. #>
$em = Invoke-RestMethod -Uri ($BaseUrl + '/ensure-masters') -Method Post -Headers $hdr `
      -Body '{"Items":[],"Agents":[],"Creditors":[],"Debtors":[],"Locations":[]}' -ContentType 'application/json'
if ($em.ok) { Ok "/ensure-masters answered ok - the connection line works" } else { Bad "/ensure-masters refused"; $em | ConvertTo-Json -Compress | Write-Host }

# ---------------------------------------------------------------- 5  photos
Head "5  read one FurtherDescription  (job 4)"
foreach ($k in 34553, 34737, 165891) {
  $r = Invoke-RestMethod -Uri ($BaseUrl + '/further-description') -Method Post -Headers $hdr `
       -Body ("{`"Table`":`"SODTL`",`"DtlKey`":" + $k + "}") -ContentType 'application/json'
  $v = [string]$r.value
  $picts = ([regex]::Matches($v, [regex]::Escape('{\pict'))).Count
  $wmf   = ([regex]::Matches($v, [regex]::Escape('\wmetafile8'))).Count
  $jpg   = ([regex]::Matches($v, [regex]::Escape('\jpegblip'))).Count
  $png   = ([regex]::Matches($v, [regex]::Escape('\pngblip'))).Count
  Note ("DtlKey {0}  column={1}  chars={2}  truncated={3}  pict={4} wmetafile8={5} jpegblip={6} pngblip={7}" -f `
        $k, $r.column, $v.Length, $r.truncated, $picts, $wmf, $jpg, $png)
}

<# The open question this does NOT answer is whether any line in the book holds
   MORE THAN ONE picture - the write replaces the field wholesale, so a second
   picture on a line we rewrite would be DESTROYED, not duplicated. Three lines
   cannot settle a book-wide maximum. That needs one aggregate over SODTL, and
   the service exposes no route for it on purpose (an arbitrary-SQL route on an
   internet-facing service is not worth the convenience). Run it in LINQPad on
   this host, connection .\A2006 / AED_HOUZS, read-only:

     SELECT COUNT(*) AS lines_with_a_value,
            MAX((LEN(FurtherDescription) - LEN(REPLACE(FurtherDescription,'{\pict',''))) / 6) AS max_pictures
     FROM SODTL
     WHERE FurtherDescription IS NOT NULL AND LEN(FurtherDescription) > 0;

   max_pictures = 1 closes it. Anything higher is a finding and the composer
   needs a read-before-write on those lines before it may touch them. #>

Head "done"
Note "Jobs 1-4 are answered above. Jobs 5, 6 and 7 WRITE to the live book and are run deliberately, not from here."
