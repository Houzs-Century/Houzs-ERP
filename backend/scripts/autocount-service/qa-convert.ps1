<#
  AutoCount QA - the part that is still NOT proven: PO create, and both converts.

  Runs from ANY machine over the public tunnel. Per
  docs/modules/autocount-writeback.md section 7z:
    * call https://autocount.houzscentury.com, never the ZeroTier IP
    * auth is the X-API-KEY header
    * it-houzs.dev is a different relay and proves nothing

  Already PASSED 2026-08-11 (runbook Step 3, document ZZERP-0001, left cancelled):
    4.1 create-so returns DtlKeys / 4.2 keyless edit REFUSED / 4.3 edit by key
    / 4.4 IsNewLine / 4.5 Retire / cancel.
  So this script does not re-litigate those. It closes the three cells that have
  never run end to end: /create-po, /so-to-do, /po-to-gr.

  ORDER, and why:
    1  /health                    confirm the book before writing to it
    2  /create-so                 the DO needs a parent
    3  /create-po                 NEVER PROVEN
    4  /so-to-do                  NEVER PROVEN. Consumes a REAL DO number
    5  /po-to-gr                  NEVER PROVEN. Posts a REAL stock IN
    6  cancel SO too early        MUST FAIL - that failure is the proof the
                                  convert really linked the documents
    7  teardown, child first      DO, then SO, then GR, then PO

  THINGS THAT ARE TRUE AND CANNOT BE AVOIDED:
    * The converts take the next real DO and GR running numbers. Cancelling does
      not give them back; AutoCount assigns them.
    * The GR posts a real stock IN of 1 unit, reversed when the GR is cancelled.
      The line item is a high-stock pillow at KL (629 on hand in the export), so
      a transient +1 is noise, not a business event.
    * The exe on the host PREDATES /ensure-masters, so every code used here must
      already exist in the book. Nothing new is minted.
    * Nothing is ever deleted. Cancel only.

  Usage:
    powershell -ExecutionPolicy Bypass -File qa-convert.ps1 -KeyFile <path> -IReallyMeanIt

  The key is read from the file and never printed. Transcript next to this script.
#>

param(
  [switch]$IReallyMeanIt,
  [switch]$SkipTeardown,
  [string]$BaseUrl  = "https://autocount.houzscentury.com",
  [string]$KeyFile  = "",
  [string]$Debtor   = "300-C002",
  [string]$Creditor = "400-N002",
  [string]$Agent    = "OTHERS",
  [string]$Location = "KL",
  [string]$ItemCode = "AK-SLEEP ESSENTIAL 7 HOLES"
)

if (-not $IReallyMeanIt) {
  Write-Host "Refusing to run without -IReallyMeanIt. This writes to the LIVE AED_HOUZS book." -ForegroundColor Yellow
  exit 2
}
if (-not $KeyFile -or -not (Test-Path $KeyFile)) {
  Write-Host "No API key file at $KeyFile" -ForegroundColor Red
  Write-Host "Put the value of the host's C:\Temp\ac-svc-key.txt (= the AC_SYNC_KEY Worker secret) in that file." -ForegroundColor Yellow
  exit 2
}

$key   = (Get-Content $KeyFile -Raw).Trim()
if ($key.Length -lt 8) { Write-Host "The key file looks empty or truncated." -ForegroundColor Red; exit 2 }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$log   = Join-Path $PSScriptRoot "ac-qa-convert-$stamp.log"
$SO    = "ZZERP-SO-$stamp"
$PO    = "ZZERP-PO-$stamp"
$results = @()

function Say($m, $colour) {
  if (-not $colour) { $colour = "Gray" }
  Write-Host $m -ForegroundColor $colour
  Add-Content -Path $log -Value $m -Encoding utf8
}

function Call($path, $payload) {
  $json = $null
  if ($payload -ne $null) { $json = ($payload | ConvertTo-Json -Depth 12 -Compress) }
  $req = [System.Net.HttpWebRequest]::Create("$BaseUrl$path")
  $req.Method = "POST"
  $req.Headers.Add("X-API-KEY", $key)
  $req.ContentType = "application/json"
  $req.Timeout = 300000
  if ($json) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $req.ContentLength = $bytes.Length
    $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
  } else { $req.ContentLength = 0 }
  try {
    $resp = $req.GetResponse()
    $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    $code = [int]$resp.StatusCode
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
      $code = [int]$resp.StatusCode
    } else { $body = $_.Exception.Message; $code = 0 }
  }
  $obj = $null
  try { $obj = $body | ConvertFrom-Json } catch { }
  return @{ status = $code; body = $body; json = $obj }
}

function Record($step, $verdict, $detail) {
  $script:results += [pscustomobject]@{ Step = $step; Verdict = $verdict; Detail = $detail }
  $c = "Gray"
  if ($verdict -eq "PASS") { $c = "Green" }
  if ($verdict -eq "FAIL") { $c = "Red" }
  if ($verdict -eq "SKIP") { $c = "Yellow" }
  Say ("[{0,-4}] {1} - {2}" -f $verdict, $step, $detail) $c
}

function Keys($r) {
  if ($r.json -and $r.json.lines) { return @($r.json.lines | ForEach-Object { $_.DtlKey }) }
  return @()
}

Say "=== AutoCount convert QA  $stamp ===" "Cyan"
Say "base=$BaseUrl  SO=$SO  PO=$PO  item=$ItemCode"
Say ""

# ------------------------------------------------------------------ 1 health
$r = Call "/health" $null
if ($r.status -eq 200 -and $r.json.ok -and $r.json.book -eq "AED_HOUZS") {
  Record "1 health" "PASS" ("book=" + $r.json.book)
} else {
  Record "1 health" "FAIL" ("status=" + $r.status + " " + $r.body); exit 1
}

# --------------------------------------------------------------- 2 create SO
$r = Call "/create-so" @{
  DocNo = $SO; DebtorCode = $Debtor; DebtorName = "ERP QA"; Agent = $Agent
  SalesLocation = $Location; Ref = "ERP-QA-CONVERT"
  Details = @(@{ ItemCode = $ItemCode; Description = "QA convert probe"; Qty = 1; UnitPrice = 100; Location = $Location })
}
$soKeys = Keys $r
if ($r.status -eq 200 -and $soKeys.Count -eq 1 -and $soKeys[0]) {
  Record "2 create-so" "PASS" ("DocNo=" + $r.json.DocNo + " DtlKey=" + $soKeys[0])
} else {
  Record "2 create-so" "FAIL" ("status=" + $r.status + " " + $r.body); exit 1
}

# --------------------------------------------------------------- 3 create PO
$r = Call "/create-po" @{
  DocNo = $PO; CreditorCode = $Creditor; CreditorName = "ERP QA"; Agent = $Agent; Ref = "ERP-QA-CONVERT"
  Details = @(@{ ItemCode = $ItemCode; Description = "QA convert probe"; Qty = 1; UnitPrice = 80; Location = $Location })
}
$poKeys = Keys $r
$poOk = ($r.status -eq 200 -and $poKeys.Count -eq 1 -and $poKeys[0])
if ($poOk) { Record "3 create-po" "PASS" ("DocNo=" + $r.json.DocNo + " DtlKey=" + $poKeys[0]) }
else {
  Record "3 create-po" "FAIL" ("status=" + $r.status + " " + $r.body)
  Say "A foreign key here means the CreditorCode is not in the book. Pick one from AutoCount." "Yellow"
}

# -------------------------------------------------------------- 4 SO -> DO
# No DtlKeys sent, so the service transfers EVERY outstanding line (caveat D14).
$doNo = $null
$r = Call "/so-to-do" @{ FromDocNo = $SO; DebtorCode = $Debtor; DebtorName = "ERP QA"; SalesLocation = $Location }
if ($r.status -eq 200 -and $r.json.DocNo) {
  $doNo = $r.json.DocNo
  Record "4 so-to-do" "PASS" ("DO=" + $doNo + " lines=" + (Keys $r).Count + " (a real DO number was consumed)")
} else {
  Record "4 so-to-do" "FAIL" ("status=" + $r.status + " " + $r.body)
}

# -------------------------------------------------------------- 5 PO -> GR
$grNo = $null
if ($poOk) {
  $r = Call "/po-to-gr" @{ FromDocNo = $PO; CreditorCode = $Creditor; CreditorName = "ERP QA"; SupplierDONo = "ERP-QA" }
  if ($r.status -eq 200 -and $r.json.DocNo) {
    $grNo = $r.json.DocNo
    Record "5 po-to-gr" "PASS" ("GR=" + $grNo + " lines=" + (Keys $r).Count + " (1 unit of $ItemCode moved IN)")
  } else { Record "5 po-to-gr" "FAIL" ("status=" + $r.status + " " + $r.body) }
} else { Record "5 po-to-gr" "SKIP" "no PO to convert" }

# ------------------------------------ 6 the link proof: cancelling the parent
#     first must FAIL. AutoCount refuses to cancel a document already
#     transferred downstream, so a refusal here proves the convert linked them.
if ($doNo) {
  $r = Call "/cancel" @{ DocType = "SO"; DocNo = $SO }
  if ($r.status -ge 400) { Record "6 link proof (SO cancel must fail)" "PASS" "refused while the DO exists - the documents are linked" }
  else { Record "6 link proof (SO cancel must fail)" "FAIL" "the SO cancelled while its DO was still live - the link did not hold" }
} else { Record "6 link proof" "SKIP" "no DO was produced" }

# ---------------------------------------------- 7 teardown, child before parent
if ($SkipTeardown) {
  Say ""
  Say "TEARDOWN SKIPPED - these are LIVE and uncancelled: SO=$SO PO=$PO DO=$doNo GR=$grNo" "Yellow"
} else {
  Say ""
  Say "--- teardown: cancel, never delete; child before parent ---" "Cyan"
  $order = @()
  if ($doNo) { $order += ,@("DO", $doNo) }
  $order += ,@("SO", $SO)
  if ($grNo) { $order += ,@("GR", $grNo) }
  if ($poOk) { $order += ,@("PO", $PO) }
  foreach ($pair in $order) {
    $r = Call "/cancel" @{ DocType = $pair[0]; DocNo = $pair[1] }
    if ($r.status -eq 200) { Record ("7 cancel " + $pair[0] + " " + $pair[1]) "PASS" "cancelled, not deleted" }
    else { Record ("7 cancel " + $pair[0] + " " + $pair[1]) "FAIL" ("status=" + $r.status + " " + $r.body) }
  }
}

Say ""
Say "================= VERDICT =================" "Cyan"
$results | ForEach-Object { Say ("{0,-4}  {1}" -f $_.Verdict, $_.Step) }
$fail = @($results | Where-Object { $_.Verdict -eq "FAIL" }).Count
Say ""
Say ("FAIL {0} of {1} steps" -f $fail, $results.Count)
Say ("documents touched: SO=$SO PO=$PO DO=$doNo GR=$grNo")
Say ("transcript: " + $log)
if ($fail -gt 0) { exit 1 }
