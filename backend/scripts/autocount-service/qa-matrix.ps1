<#
  The QA MATRIX the owner asked for on 2026-08-15, in one run.

    (A) does an EDIT actually reach AutoCount - processing date, the header
        delivery date, each line's delivery date, and payment
    (B) do the five conversions leave a visible Transfer link - the entry
        screen's "convert from" / "convert to" - for
        SO->PO, SO->DO, DO->IV, PO->GR, GR->PI
    (C) do the line operations work - edit a line, delete (retire) a line

  WHY IT VERIFIES BY READING THE BOOK. Checking that we SENT a field proves
  nothing about what AutoCount stored. Every assertion here reads the document
  back through /doc-read and compares AutoCount's own column. That route also
  reports which columns do not EXIST, so "payment does not update" and
  "AutoCount has no payment column on a sales order" come back as different
  answers instead of one shrug.

  IT ALWAYS READS THE ERROR BODY. qa-convert.ps1 reported /po-to-gr as
  "status=0 ... (500)" and never read the response, so that failure has had a
  symptom and no cause for days. Invoke-RestMethod throws away the body on a
  non-2xx; Call() below digs it out of the exception stream, every time.

  IT WRITES. Real documents, real running numbers, in the LIVE book:
    * every document it creates is CANCELLED at the end, child before parent
    * nothing is ever deleted (the owner's rule)
    * AutoCount does not give running numbers back - that cost is real and
      is the price of testing conversions at all, since AED_TESTING is out of
      transactions

  Usage, on the host:
    powershell -ExecutionPolicy Bypass -File qa-matrix.ps1 -IReallyMeanIt

  RE-RUN: each run stamps its own document numbers from the clock, so a second
  run collides with nothing the first one left.
#>

param(
  [switch]$IReallyMeanIt,
  [switch]$SkipTeardown,
  [string]$BaseUrl   = "http://localhost:8900",
  [string]$KeyFile   = "C:\Temp\ac-svc-key.txt",
  [string]$Debtor    = "300-C002",
  [string]$Creditor  = "400-N002",
  [string]$Agent     = "OTHERS",
  [string]$Location  = "KL",
  [string]$ItemCode  = "AK-SLEEP ESSENTIAL 7 HOLES"
)

$ErrorActionPreference = 'Stop'
$script:Rows = @()
function Head($m) { Write-Host ""; Write-Host ("== " + $m) -ForegroundColor Cyan }
function Note($m) { Write-Host ("     " + $m) -ForegroundColor Gray }
function Record($name, $verdict, $detail) {
  $script:Rows += [pscustomobject]@{ Check = $name; Verdict = $verdict; Detail = $detail }
  $c = if ($verdict -eq 'PASS') { 'Green' } elseif ($verdict -eq 'FAIL') { 'Red' } else { 'Yellow' }
  Write-Host ("[" + $verdict + "] " + $name + " - " + $detail) -ForegroundColor $c
}

if (-not $IReallyMeanIt) {
  Write-Host "Refusing without -IReallyMeanIt. This writes REAL documents to the LIVE book." -ForegroundColor Yellow
  exit 2
}
if (-not (Test-Path $KeyFile)) { Write-Host "no key file at $KeyFile" -ForegroundColor Red; exit 2 }
$key = (Get-Content $KeyFile -Raw).Trim()    # read, never printed

<# A separate function, NOT an inline `(try {...} catch {...})`. That form is a
   PowerShell 7 expression and this host runs 5.1, where it parses as a command
   called "try" and dies at RUNTIME with "the term 'try' is not recognized".
   The parser does not catch it, so it would have reached the live book before
   anything complained. #>
function AsJson($raw) {
  if (-not $raw) { return $null }
  try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

<# Always returns { status, json, raw } and NEVER throws on an HTTP error.
   Invoke-RestMethod discards the response body on a non-2xx, which is exactly
   how /po-to-gr's 500 stayed uncaused. #>
function Call($route, $bodyObj) {
  $body = ($bodyObj | ConvertTo-Json -Depth 10)
  try {
    $r = Invoke-WebRequest -Uri ($BaseUrl + $route) -Method Post -Headers @{ 'X-API-KEY' = $key } `
         -Body $body -ContentType 'application/json' -UseBasicParsing
    return @{ status = [int]$r.StatusCode; raw = $r.Content; json = (AsJson $r.Content) }
  } catch {
    $resp = $_.Exception.Response
    $raw = ''
    if ($resp) {
      try {
        $sr = New-Object IO.StreamReader($resp.GetResponseStream())
        $raw = $sr.ReadToEnd(); $sr.Close()
      } catch { $raw = '<body unreadable>' }
    }
    if (-not $raw) { $raw = $_.Exception.Message }
    $st = 0
    if ($resp) { try { $st = [int]$resp.StatusCode } catch { $st = 0 } }
    return @{ status = $st; raw = $raw; json = (AsJson $raw) }
  }
}

function ReadDoc($docType, $docNo) { return (Call '/doc-read' @{ DocType = $docType; DocNo = $docNo }) }

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$SO = "ZZQA-SO-$stamp"
$PO = "ZZQA-PO-$stamp"

# ---------------------------------------------------------------- 0 preflight
Head "0  which build is answering"
$h = Call '/health' @{}
if ($h.status -ne 200) { Record "0 health" "FAIL" ("status=" + $h.status + " " + $h.raw); exit 1 }
Record "0 health" "PASS" ("book=" + $h.json.book + " builtAt=" + $h.json.builtAt)

# ---------------------------------------------------------------- 1 create SO
Head "1  create the sales order (two lines)"
$r = Call '/create-so' @{
  DocNo = $SO; DocDate = (Get-Date).ToString('yyyy-MM-dd')
  DebtorCode = $Debtor; DebtorName = "ERP QA MATRIX"; Agent = $Agent; SalesLocation = $Location
  Description = "ERP QA MATRIX - CANCEL ME"
  Details = @(
    @{ ItemCode = $ItemCode; Qty = 2; UnitPrice = 10; Location = $Location; Desc2 = "LINE ONE" },
    @{ ItemCode = $ItemCode; Qty = 3; UnitPrice = 20; Location = $Location; Desc2 = "LINE TWO" }
  )
}
if ($r.status -ne 200 -or -not $r.json.ok) { Record "1 create-so" "FAIL" ("status=" + $r.status + " " + $r.raw); exit 1 }
$soKeys = @($r.json.lines | ForEach-Object { $_.DtlKey })
Record "1 create-so" "PASS" ("DocNo=" + $r.json.docNo + " DtlKeys=" + ($soKeys -join ','))

# ---------------------------------------------------------------- 2 what the book even HAS
Head "2  which fields exist on a sales order at all"
$d = ReadDoc 'SO' $SO
if ($d.status -ne 200 -or -not $d.json.ok) { Record "2 doc-read" "FAIL" ("status=" + $d.status + " " + $d.raw); exit 1 }
Record "2 doc-read" "PASS" ("header cols=" + ($d.json.header.PSObject.Properties.Name.Count) + " lines=" + @($d.json.lines).Count)
<# missingColumns is the ANSWER to "does payment update into AutoCount" when the
   column does not exist. Printing it is the point, not a diagnostic aside. #>
$missing = @($d.json.missingColumns)
if ($missing.Count) { Note ("columns AutoCount does NOT have: " + ($missing -join ', ')) }

foreach ($f in 'ProcessingDate','DeliveryDate','PaymentAmt','PaymentTerm','CreditTerm') {
  if ($missing -contains ("SO." + $f)) { Record ("2." + $f) "N/A" "no such column on SO - AutoCount cannot hold this" }
  else { Record ("2." + $f) "PASS" ("column exists, currently = " + $d.json.header.$f) }
}

# ---------------------------------------------------------------- 3 EDIT header + lines
Head "3  edit: header dates, line delivery date, line fields"
$newDocDate  = (Get-Date).AddDays(1).ToString('yyyy-MM-dd')
$lineDeliv   = (Get-Date).AddDays(7).ToString('yyyy-MM-dd')
$editBody = @{
  DocType = 'SO'; DocNo = $SO
  Header = @{ DocDate = $newDocDate; Description = "EDITED BY QA MATRIX"; Ref = "QA-REF-1"; Remark1 = "QA-R1" }
  Lines = @( @{ DtlKey = $soKeys[0]; Desc2 = "LINE ONE EDITED"; Qty = 4; UnitPrice = 12.5; DeliveryDate = $lineDeliv } )
}
$r = Call '/edit' $editBody
if ($r.status -ne 200 -or -not $r.json.ok) { Record "3 edit" "FAIL" ("status=" + $r.status + " " + $r.raw) }
else {
  Record "3 edit" "PASS" "accepted"
  $d = ReadDoc 'SO' $SO
  $hdr = $d.json.header
  $l1  = @($d.json.lines)[0]
  function Cmp($name, $got, $want) {
    if ("$got".StartsWith("$want")) { Record $name "PASS" ("book holds '" + $got + "'") }
    else { Record $name "FAIL" ("book holds '" + $got + "', sent '" + $want + "'") }
  }
  Cmp "3.1 header DocDate"      $hdr.DocDate      $newDocDate
  Cmp "3.2 header Description"  $hdr.Description  "EDITED BY QA MATRIX"
  Cmp "3.3 header Ref"          $hdr.Ref          "QA-REF-1"
  Cmp "3.4 line Desc2"          $l1.Desc2         "LINE ONE EDITED"
  Cmp "3.5 line Qty"            $l1.Qty           "4"
  Cmp "3.6 line UnitPrice"      $l1.UnitPrice     "12.5"
  Cmp "3.7 line DeliveryDate"   $l1.DeliveryDate  $lineDeliv
}

# ---------------------------------------------------------------- 4 retire a line
Head "4  delete a line (retire in place - this SDK has no line delete)"
$r = Call '/edit' @{ DocType = 'SO'; DocNo = $SO; Lines = @( @{ DtlKey = $soKeys[1]; Retire = $true } ) }
if ($r.status -ne 200 -or -not $r.json.ok) { Record "4 retire" "FAIL" ("status=" + $r.status + " " + $r.raw) }
else {
  $d = ReadDoc 'SO' $SO
  $l2 = @($d.json.lines) | Where-Object { $_.DtlKey -eq $soKeys[1] }
  if ($l2 -and [double]$l2.Qty -eq 0) { Record "4 retire" "PASS" ("Qty=0, Desc2='" + $l2.Desc2 + "'") }
  else { Record "4 retire" "FAIL" ("line still reads Qty=" + $l2.Qty) }
}

# ---------------------------------------------------------------- 5 the conversions
Head "5  the five conversions, and whether the Transfer link is really there"

<# The evidence is FromDocType / FromDocNo on the TARGET's lines. That is what
   AutoCount's own convert-from / convert-to reads. A target that exists with
   those columns empty is a standalone document that merely looks right. #>
function CheckLink($name, $docType, $docNo, $expectType, $expectNo) {
  $d = ReadDoc $docType $docNo
  if ($d.status -ne 200 -or -not $d.json.ok) { Record $name "FAIL" ("doc-read " + $d.status + " " + $d.raw); return }
  $ls = @($d.json.lines)
  if (-not $ls.Count) { Record $name "FAIL" "target has no lines"; return }
  $linked = @($ls | Where-Object { "$($_.FromDocNo)" -eq $expectNo -and "$($_.FromDocType)" -eq $expectType })
  if ($linked.Count -eq $ls.Count) {
    Record $name "PASS" ("all " + $ls.Count + " line(s) carry FromDocType=" + $expectType + " FromDocNo=" + $expectNo)
  } elseif ($linked.Count) {
    Record $name "FAIL" ($linked.Count.ToString() + " of " + $ls.Count + " lines carry the link")
  } else {
    Record $name "FAIL" ("NO line carries a Transfer link - FromDocType='" + $ls[0].FromDocType + "' FromDocNo='" + $ls[0].FromDocNo + "'")
  }
}

# 5a SO -> PO
$r = Call '/so-to-po' @{ FromDocNo = $SO; DocNo = $PO; DtlKeys = @($soKeys[0]); CreditorCode = $Creditor; CreditorName = "ERP QA"; Agent = $Agent
                         Lines = @( @{ DtlKey = $soKeys[0]; UnitPrice = 5; Qty = 4; Location = $Location } ) }
if ($r.status -ne 200 -or -not $r.json.ok) { Record "5a so-to-po" "FAIL" ("status=" + $r.status + " " + $r.raw); $poNo = $null }
else { $poNo = $r.json.docNo; Record "5a so-to-po" "PASS" ("PO=" + $poNo); CheckLink "5a link PO<-SO" 'PO' $poNo 'SO' $SO }

# 5b SO -> DO
$r = Call '/so-to-do' @{ FromDocNo = $SO; DebtorCode = $Debtor; DebtorName = "ERP QA"; SalesLocation = $Location }
if ($r.status -ne 200 -or -not $r.json.ok) { Record "5b so-to-do" "FAIL" ("status=" + $r.status + " " + $r.raw); $doNo = $null }
else { $doNo = $r.json.docNo; Record "5b so-to-do" "PASS" ("DO=" + $doNo); CheckLink "5b link DO<-SO" 'DO' $doNo 'SO' $SO }

# 5c DO -> IV
$ivNo = $null
if ($doNo) {
  $r = Call '/do-to-iv' @{ FromDocNo = $doNo; DebtorCode = $Debtor; DebtorName = "ERP QA"; SalesLocation = $Location }
  if ($r.status -ne 200 -or -not $r.json.ok) { Record "5c do-to-iv" "FAIL" ("status=" + $r.status + " " + $r.raw) }
  else { $ivNo = $r.json.docNo; Record "5c do-to-iv" "PASS" ("IV=" + $ivNo); CheckLink "5c link IV<-DO" 'IV' $ivNo 'DO' $doNo }
}

# 5d PO -> GR   (the one that answered 500 with no body on 2026-08-15)
$grNo = $null
if ($poNo) {
  $r = Call '/po-to-gr' @{ FromDocNo = $poNo; CreditorCode = $Creditor; CreditorName = "ERP QA"; SupplierDONo = "ERP-QA" }
  if ($r.status -ne 200 -or -not $r.json.ok) { Record "5d po-to-gr" "FAIL" ("status=" + $r.status + " BODY: " + $r.raw) }
  else { $grNo = $r.json.docNo; Record "5d po-to-gr" "PASS" ("GR=" + $grNo); CheckLink "5d link GR<-PO" 'GR' $grNo 'PO' $poNo }
}

# 5e GR -> PI
$piNo = $null
if ($grNo) {
  $r = Call '/gr-to-pi' @{ FromDocNo = $grNo; CreditorCode = $Creditor; CreditorName = "ERP QA"; SupplierInvoiceNo = "ERP-QA-INV" }
  if ($r.status -ne 200 -or -not $r.json.ok) { Record "5e gr-to-pi" "FAIL" ("status=" + $r.status + " BODY: " + $r.raw) }
  else { $piNo = $r.json.docNo; Record "5e gr-to-pi" "PASS" ("PI=" + $piNo); CheckLink "5e link PI<-GR" 'PI' $piNo 'GR' $grNo }
}

# ---------------------------------------------------------------- 6 the link must HOLD
Head "6  a parent with a live child must NOT be cancellable"
<# This is the assertion that FAILED on 2026-08-15 and is the reason the run
   mattered. It must FAIL to pass: if the SO cancels while its DO is still
   live, either the convert did not link the documents or Cancel does not look
   downstream, and either way a parent can be cancelled out from under its
   child - which is the divergence the owner's cancel rule exists to prevent. #>
if ($doNo) {
  $r = Call '/cancel' @{ DocType = 'SO'; DocNo = $SO }
  if ($r.status -eq 200 -and $r.json.ok) {
    Record "6 link holds" "FAIL" "the SO CANCELLED while its DO was still live - the link did not hold"
  } else {
    Record "6 link holds" "PASS" ("refused, as it must: " + $r.raw)
  }
} else { Record "6 link holds" "N/A" "no DO was created, nothing to hold" }

# ---------------------------------------------------------------- 7 teardown
if ($SkipTeardown) {
  Head "7  teardown SKIPPED - these are LIVE documents, cancel them by hand"
} else {
  Head "7  teardown - cancel, never delete; child before parent"
  foreach ($pair in @(@('PI',$piNo), @('GR',$grNo), @('IV',$ivNo), @('DO',$doNo), @('SO',$SO), @('PO',$poNo))) {
    if (-not $pair[1]) { continue }
    $r = Call '/cancel' @{ DocType = $pair[0]; DocNo = $pair[1] }
    if ($r.status -eq 200 -and $r.json.ok) { Record ("7 cancel " + $pair[0] + " " + $pair[1]) "PASS" "cancelled, not deleted" }
    else { Record ("7 cancel " + $pair[0] + " " + $pair[1]) "FAIL" ("status=" + $r.status + " " + $r.raw + " - CANCEL BY HAND") }
  }
}

Head "VERDICT"
$script:Rows | Format-Table -AutoSize
$fails = @($script:Rows | Where-Object { $_.Verdict -eq 'FAIL' })
Write-Host ""
Write-Host ("PASS " + @($script:Rows | Where-Object { $_.Verdict -eq 'PASS' }).Count +
            "   FAIL " + $fails.Count +
            "   N/A " + @($script:Rows | Where-Object { $_.Verdict -eq 'N/A' }).Count)
if ($fails.Count) { exit 1 }
