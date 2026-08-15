<#
  The FurtherDescription WRITE PROBE - job 6 of the handling listing's section 0,
  and section 5.2 of docs/autocount-further-description-photos.md.

  THE QUESTION, and it is the only one left before photographs can ship:
  will AutoCount RENDER a metafile it did not write itself? The bytes we emit
  are already known to match the book character-for-character (the guide's
  section 7q2 has the compile-and-run), and that is NECESSARY, NOT SUFFICIENT -
  the entry screen and the report's XRRichText are two different renderers, so a
  picture that appears in one may not appear in the other.

  IT WRITES. Deliberately, and only to a document it creates itself:

    * a SCRATCH sales order, made here through /create-so, never a customer's
    * NEVER a line that already holds a FurtherDescription. That is the whole
      risk of this feature - the field is replaced WHOLESALE, so writing onto a
      populated line destroys what AutoCount is holding, and there is no undo
    * cancelled at the end, never deleted (the owner's rule)

  It consumes one SO running number. AutoCount does not give those back.

  Usage, on the host:
    powershell -ExecutionPolicy Bypass -File fd-probe.ps1 -IReallyMeanIt

  RE-RUN: each run creates and cancels its OWN scratch document. A second run
  costs a second SO number and touches nothing the first one left.
#>

param(
  [switch]$IReallyMeanIt,
  [switch]$SkipCancel,
  [string]$BaseUrl  = "http://localhost:8900",
  [string]$KeyFile  = "C:\Temp\ac-svc-key.txt",
  [string]$Debtor   = "300-C002",
  [string]$Agent    = "OTHERS",
  [string]$Location = "KL",
  [string]$ItemCode = "AK-SLEEP ESSENTIAL 7 HOLES",
  [string]$Jpeg     = ""
)

$ErrorActionPreference = 'Stop'
function Ok  ($m) { Write-Host ("OK   " + $m) -ForegroundColor Green }
function Note($m) { Write-Host ("     " + $m) -ForegroundColor Gray }
function Bad ($m) { Write-Host ("FAIL " + $m) -ForegroundColor Red }
function Head($m) { Write-Host ""; Write-Host ("== " + $m) -ForegroundColor Cyan }

if (-not $IReallyMeanIt) {
  Write-Host "Refusing without -IReallyMeanIt. This CREATES a real sales order in the live book." -ForegroundColor Yellow
  exit 2
}
if (-not (Test-Path $KeyFile)) { Bad "no key file at $KeyFile"; exit 2 }

$key = (Get-Content $KeyFile -Raw).Trim()    # read, never printed
$hdr = @{ 'X-API-KEY' = $key }
function Call($route, $body) {
  Invoke-RestMethod -Uri ($BaseUrl + $route) -Method Post -Headers $hdr -Body $body -ContentType 'application/json'
}

# ------------------------------------------------------------- 1  the picture
Head "1  the picture"
Add-Type -AssemblyName System.Drawing
if ($Jpeg -and (Test-Path $Jpeg)) {
  $bytes = [IO.File]::ReadAllBytes($Jpeg)
  $img = [Drawing.Image]::FromStream((New-Object IO.MemoryStream(,$bytes)))
  Note ("using " + $Jpeg + " - " + $img.Width + "x" + $img.Height)
  $img.Dispose()
} else {
  <# A SYNTHETIC picture is the better probe, not a compromise. The four
     observations 5.2 asks for are about ORIENTATION and SIZE as much as
     presence, and a photograph of a sofa answers neither: it looks the same
     upside down at the wrong scale. A picture that says which way is up, and
     carries its own dimensions in words, answers all three at a glance. #>
  $w = 240; $h = 159
  $bmp = New-Object Drawing.Bitmap($w, $h)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.Clear([Drawing.Color]::White)
  $g.FillRectangle([Drawing.Brushes]::Crimson, 0, 0, $w, 18)
  $g.FillRectangle([Drawing.Brushes]::RoyalBlue, 0, ($h - 18), $w, 18)
  $f = New-Object Drawing.Font("Arial", 11, [Drawing.FontStyle]::Bold)
  $g.DrawString("TOP", $f, [Drawing.Brushes]::White, 4, 0)
  $g.DrawString("BOTTOM", $f, [Drawing.Brushes]::White, 4, ($h - 19))
  $g.DrawString("240 x 159", $f, [Drawing.Brushes]::Black, 8, 60)
  $g.DrawString("ERP PROBE", $f, [Drawing.Brushes]::Black, 8, 80)
  $g.Dispose()
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Jpeg)
  $bytes = $ms.ToArray(); $ms.Dispose(); $bmp.Dispose()
  Note ("generated " + $w + "x" + $h + " - reads TOP at the top, BOTTOM at the bottom, and states its own size")
}
$b64 = [Convert]::ToBase64String($bytes)
Ok ("jpeg " + $bytes.Length + " bytes; base64 " + $b64.Length + " chars")

# ------------------------------------------------------------- 2  scratch SO
Head "2  create the scratch sales order"
<# SalesLocation is on the HEADER and is NOT optional. Omitting it cost this
   probe its first run against the live book on 2026-08-15:

     {"ok":false,"error":"Foreign Key Error (Constraint Name=FK_SO_SalesLocation)"}

   It is the header-level twin of FK_SODTL_Location, which is the line one and
   is already documented. The ERP itself never trips this - autocount-outbox.ts
   raises MissingSalesLocationError and refuses to enqueue rather than send a
   document AutoCount will reject - so the constraint is invisible until
   something hand-writes a payload, which is exactly what this script does.
   qa-convert.ps1 has always sent it. #>
$create = @{
  DocDate = (Get-Date).ToString("yyyy-MM-dd"); DebtorCode = $Debtor; Agent = $Agent
  SalesLocation = $Location
  Description = "ERP FURTHER DESCRIPTION PROBE - CANCEL ME"
  Details = @( @{ ItemCode = $ItemCode; Qty = 1; UnitPrice = 1; Location = $Location; Desc2 = "PROBE" } )
} | ConvertTo-Json -Depth 6
$so = Call '/create-so' $create
if (-not $so.docNo) { Bad "create-so returned no docNo"; $so | ConvertTo-Json -Compress | Write-Host; exit 1 }
$dtlKey = $so.lines[0].DtlKey
Ok ("created " + $so.docNo + "  DtlKey " + $dtlKey)

# ------------------------------------------------------------- 3  it is EMPTY
Head "3  confirm the line holds nothing yet"
<# 5.2's hard rule: never write onto a line that already has a value. This is
   a document we just made, so it must be empty - and CHECKING is the point.
   If this is ever non-empty, the create path is inheriting a value from
   somewhere and the probe must stop rather than overwrite it. #>
$before = Call '/further-description' ("{`"Table`":`"SODTL`",`"DtlKey`":" + $dtlKey + "}")
$beforeLen = ([string]$before.value).Length
if ($beforeLen -ne 0) {
  Bad ("the new line ALREADY holds " + $beforeLen + " characters - refusing to overwrite it")
  Note "This is a finding, not a glitch. Stop and work out where the value came from."
  exit 1
}
Ok "empty, as a new line must be"

# ------------------------------------------------------------- 4  write it
Head "4  write the photograph"
$edit = @{
  DocType = 'SO'; DocNo = $so.docNo
  Lines = @( @{ DtlKey = $dtlKey; Photos = @( @{ Jpeg = $b64; Caption = ("Image on " + (Get-Date).ToString("M/d/yyyy h:mm:ss tt")) } ) } )
} | ConvertTo-Json -Depth 8
$r = Call '/edit' $edit
if (-not $r.ok) { Bad "the edit was refused"; $r | ConvertTo-Json -Compress | Write-Host; exit 1 }
Ok "/edit accepted the write"

# ------------------------------------------------------------- 5  read it back
Head "5  read it back  (observation iii)"
$after = Call '/further-description' ("{`"Table`":`"SODTL`",`"DtlKey`":" + $dtlKey + "}")
$v = [string]$after.value
$picts = ([regex]::Matches($v, [regex]::Escape('{\pict'))).Count
$wmf   = ([regex]::Matches($v, [regex]::Escape('\wmetafile8'))).Count
Note ("chars=" + $v.Length + "  truncated=" + $after.truncated + "  pict=" + $picts + "  wmetafile8=" + $wmf)
if ($v.Length -eq 0)      { Bad "AutoCount stored NOTHING - it discarded the whole value" }
elseif ($after.truncated) { Bad "the value came back TRUNCATED" }
elseif ($picts -lt 1)     { Bad "the text survived but the PICTURE GROUP was discarded" }
elseif ($wmf -lt 1)       { Ok  "stored, and AutoCount REWROTE it into another form - read the head below, that is the more useful answer" }
else                      { Ok  "stored as \wmetafile8, our own bytes" }
Note ("head: " + $v.Substring(0, [Math]::Min(160, $v.Length)).Replace("`r"," ").Replace("`n"," "))

# ------------------------------------------------------------- 6  the eyes
Head "6  the two observations only a human can make"
Write-Host ""
Write-Host ("  Open " + $so.docNo + " in AutoCount and look at TWO things:") -ForegroundColor Yellow
Write-Host "    (i)  the line's Further Description editor on the ENTRY screen" -ForegroundColor Yellow
Write-Host "    (ii) Preview of the PRINTED sales order" -ForegroundColor Yellow
Write-Host ""
Note "A pass is: the picture is visible, right way up (TOP band at the top), roughly 240x159."
Note "A picture in (i) but NOT in (ii) is a real answer, not a partial one - they are"
Note "different renderers, and (ii) is the one the customer sees."
Note "A red X, a filename, or a blank is section 5.3: AutoCount will not take our RTF"
Note "in this form, and the finding goes in the guide's table."
Write-Host ""
Read-Host "Press Enter once you have looked at both"

# ------------------------------------------------------------- 7  cancel
if ($SkipCancel) {
  Head "7  cancel SKIPPED (-SkipCancel)"
  Note ("LEFT OPEN IN THE LIVE BOOK: " + $so.docNo + " - cancel it by hand.")
} else {
  Head "7  cancel the scratch document"
  <# Cancel, never delete. The owner's standing rule, and the SO number stays
     spent either way - AutoCount does not return it. #>
  $c = Call '/cancel' ("{`"DocType`":`"SO`",`"DocNo`":`"" + $so.docNo + "`"}")
  if ($c.ok) { Ok ($so.docNo + " cancelled") } else { Bad ("cancel refused - " + ($c | ConvertTo-Json -Compress)); Note "Cancel it by hand." }
}

Head "done"
Note ("Record all four observations in docs/autocount-further-description-photos.md section 5.2, including the ones that failed.")
