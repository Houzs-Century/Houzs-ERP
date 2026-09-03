# Fingerprint every sales order's LINE ORDER in the AutoCount book — read-only.
#
# WHY A FINGERPRINT AND NOT THE LINES. This repository is PUBLIC. The comparison
# has to happen against the ERP, which lives behind DATABASE_URL in a GitHub
# workflow, so something has to travel — and item codes, descriptions and
# customer-identifying text must not. Each document therefore leaves this machine
# as three values only:
#
#     doc_no , line_count , sha256(the ordered item codes)
#
# Two documents with the same lines in the same order produce the same hash. Two
# with the same lines in a DIFFERENT order do not. That is exactly the question
# being asked and it carries nothing else.
#
# WHAT IT ANSWERS. The owner, 2026-09-03, after finding a third document whose
# AutoCount lines were in a different order from the ERP's, with a deleted line
# still sitting there at quantity 0:
#
#     「之后有问题吗？我不要每次都来 fix 啊」
#
# New documents are written in ERP order and an add/delete rebuilds the whole
# document, so they are fine going forward. The MIGRATED ones never matched to
# begin with — this counts them, so they can be rebuilt in one pass instead of
# one at a time as somebody trips over them.
#
# READ-ONLY. One SELECT. No writes, no DDL, no transaction. It uses Windows
# authentication (`-E`), so it needs NO password and nothing secret is read.
#
# CANCELLED LINES ARE INCLUDED ON PURPOSE. A line the ERP deleted and the book
# still holds at Qty 0 is precisely one of the mismatches being counted; dropping
# it would hide the case this was written for.
#
#   powershell -ExecutionPolicy Bypass -File dump-ac-line-fingerprints.ps1
#
# Writes ac-line-fingerprints.csv beside itself. Exit 0 = wrote the file.

param(
  [string] $Server = ".\A2006",
  [string] $Book   = "AED_HOUZS",
  [string] $Out    = "$PSScriptRoot\ac-line-fingerprints.csv"
)

$ErrorActionPreference = 'Stop'

$sql = @'
SET NOCOUNT ON;
SELECT h.DocNo AS doc_no,
       COUNT(*) AS line_count,
       -- The ordered item codes, joined. Seq is AutoCount's own line order.
       STUFF((SELECT '|' + ISNULL(d2.ItemCode, '')
                FROM SODTL d2
               WHERE d2.DocKey = h.DocKey
               ORDER BY d2.Seq
                 FOR XML PATH('')), 1, 1, '') AS ordered_codes
  FROM SO h
  JOIN SODTL d ON d.DocKey = h.DocKey
 GROUP BY h.DocNo, h.DocKey
 ORDER BY h.DocNo;
'@

$tmp = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($tmp, $sql)
  $raw = & sqlcmd -S $Server -d $Book -E -C -h -1 -W -s "`t" -i $tmp
  if ($LASTEXITCODE -ne 0) { Write-Error "sqlcmd exited $LASTEXITCODE" }

  $sha = [System.Security.Cryptography.SHA256]::Create()
  $rows = New-Object System.Collections.Generic.List[string]
  $rows.Add("doc_no,line_count,order_hash")
  foreach ($line in $raw) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line -match '^\(\d+ rows affected\)') { continue }
    $parts = $line -split "`t"
    if ($parts.Count -lt 3) { continue }
    $docNo = $parts[0].Trim()
    $count = $parts[1].Trim()
    if (-not ($count -match '^\d+$')) { continue }
    # The codes never leave this machine - only the digest of them does.
    $codes = $parts[2]
    $hash = ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($codes)) |
             ForEach-Object { $_.ToString("x2") }) -join ''
    $rows.Add("$docNo,$count,$hash")
  }
  [System.IO.File]::WriteAllLines($Out, $rows)
  Write-Output ("WROTE " + $Out + " - " + ($rows.Count - 1) + " document(s). No item text left this machine.")
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
