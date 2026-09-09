# Compile AcSyncService.cs on ANY machine that has AutoCount 2.2 installed.
#
# WHY THIS EXISTS. This file was documented for months as "the only piece of
# this repository that does not build in CI ... it is reviewed as source here
# and built by hand there", and a consequence was recorded in the migration
# record: an uncompilable over-transfer handler sat on main undetected, because
# "a file that compiles on exactly one machine in the building gets no CI".
#
# That premise was wrong. The licensed assemblies ship with the ordinary
# AutoCount 2.2 desktop install, and csc.exe ships with the .NET Framework, so
# ANY workstation with AutoCount installed can compile this - including the
# owner's desktop. Verified 2026-08-11: a clean build, 36,352 bytes, byte-size
# identical to the AcSyncService.prev.exe already on the office host.
#
# Re-verified 2026-09-02 on the DEVELOPMENT desktop, which turns out to have
# AutoCount 2.2 installed as well: COMPILES CLEAN, 110,592 bytes. Two things
# follow, and the second is the one that cost real time. The size is not a
# fingerprint any more - the service has tripled since August and a build that
# does not match 36,352 bytes is normal, not suspect. And the sentence
# "there is no C# toolchain in this environment", written into two bug-ledger
# entries the same day, was WRONG: the check below had been runnable all along
# and answers in seconds. Run it before writing UNCOMPILED anywhere.
#
# It does NOT run the service and it never touches a database: the connection
# line is substituted with an obvious dummy. This answers exactly one question,
# which is the question CI cannot answer - DOES IT COMPILE.
#
#   powershell -ExecutionPolicy Bypass -File build-local.ps1
#
# Exit code 0 = compiles. Non-zero = it does not, and the errors are printed.

param(
  [string] $AutoCountDir = "C:\Program Files\AutoCount\Accounting 2.2",
  [string] $Source       = "$PSScriptRoot\AcSyncService.cs"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $AutoCountDir)) {
  Write-Error "AutoCount 2.2 not found at $AutoCountDir. Pass -AutoCountDir if it is installed elsewhere."
}
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { Write-Error "csc.exe not found at $csc (.NET Framework 4 is required)." }

# A DUMMY connection line. The real one is substituted at deploy time on the
# host from C:\InistateConnector\setup.json and never lives in source control.
$dummy = 'AutoCount.Data.DBSetting db = new AutoCount.Data.DBSetting(AutoCount.Data.DBServerType.SQL2000, "COMPILE-ONLY", "u", "p", "AED_HOUZS");'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("AcSyncService.compilecheck." + [System.Guid]::NewGuid().ToString('N') + ".cs")
$exe = [System.IO.Path]::ChangeExtension($tmp, '.exe')
try {
  $src = Get-Content $Source -Raw
  # The AutoCount login placeholders take DUMMY values here for the same reason
  # the connection line does: this script answers "does the source compile",
  # and it must never need a credential to answer it. deploy-on-host.ps1 is
  # where the real pair is substituted.
  [System.IO.File]::WriteAllText($tmp, $src.Replace('__DBLINE__', $dummy).Replace('__BOOK__', 'AED_HOUZS').
                                            Replace('__ACUSER__', 'DUMMYUSER').Replace('__ACPASS__', 'DUMMYPASS'))

  # Stock / ARAP / GeneralMaint / StockMaint carry the MASTER-DATA classes that
  # /ensure-masters drives - ItemDataAccess, DebtorDataAccess, CreditorDataAccess,
  # SalesAgentCommand and LocationMaintenance (which is in StockMaint, NOT Stock).
  # AutoCount.UDF.UDFList is in AutoCount.dll, already referenced. The five
  # document assemblies alone are no longer enough.
  $refs = @(
    "$AutoCountDir\AutoCount.dll",
    "$AutoCountDir\AutoCount.Invoicing.dll",
    "$AutoCountDir\AutoCount.Sales.dll",
    "$AutoCountDir\AutoCount.Purchase.dll",
    "$AutoCountDir\AutoCount.Accounting.dll",
    "$AutoCountDir\AutoCount.Stock.dll",
    "$AutoCountDir\AutoCount.ARAP.dll",
    "$AutoCountDir\AutoCount.GeneralMaint.dll",
    "$AutoCountDir\AutoCount.StockMaint.dll"
  ) | ForEach-Object { "/r:$_" }

  & $csc /nologo /platform:x64 /target:exe "/out:$exe" @refs /r:System.Web.Extensions.dll /r:System.Data.dll /r:System.Drawing.dll $tmp
  if ($LASTEXITCODE -ne 0) { Write-Error "AcSyncService.cs DOES NOT COMPILE (csc exit $LASTEXITCODE)." }
  Write-Output ("COMPILES CLEAN - " + (Get-Item $exe).Length + " bytes (discarded; this is a check, not a deploy)")
} finally {
  Remove-Item $tmp, $exe -ErrorAction SilentlyContinue
}
