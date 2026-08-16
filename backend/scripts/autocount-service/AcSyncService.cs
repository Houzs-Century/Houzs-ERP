// AutoCount write-back service — the full document chain (.NET Framework 4).
//
// Owner 2026-08-10: the AutoCount import is ONE-TIME; from go-live the ERP is
// master and pushes every change into AutoCount. Six modules were specified:
//   (a) SO -> DO      (b) PO -> GRN      (c) DO -> Invoice   (d) GRN -> PI
//   (e) Cancel        (f) Edit (header + lines + variants/Desc2)
// plus the create paths the chain needs (SO and PO).
//
// This supersedes AcSoService.cs (create-SO only), which proved the approach on
// 2026-08-07 by writing two real SOs into the LIVE AED_HOUZS book.
//
// ── HOW THE SDK DOES A CONVERSION ─────────────────────────────────────────
// CORRECTED 2026-08-17. This block used to open:
//
//     "There is NO TransferTo/CreateFrom API. Every document class exposes
//      exactly one transfer primitive: AddPartialTransferDetail(...) ...
//      (reflected off the installed 2.2 assemblies on 2026-08-10 — NOT guessed)"
//
// That is false, and the parenthesis is the reason it lasted a week: it cites a
// measurement, so nobody re-took it. The 2026-08-10 dump was taken with
// BindingFlags.DeclaredOnly — sdk-api-reference.txt says so in its own third
// paragraph — and DeclaredOnly SKIPS INHERITED MEMBERS. The transfer API is
// inherited: it lives on SalesDocument / PurchaseDocument, not on DeliveryOrder
// or GoodsReceivedNote, so a per-subclass DeclaredOnly dump could never show it.
// "The instrument could not see it" was written down as "it is not there".
//
// Re-reflected with BindingFlags.FlattenHierarchy against
// C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Sales.dll, on the type
// AutoCount.Invoicing.Sales.DeliveryOrder.DeliveryOrder, these exist:
//
//   SalesDocument.FullTransfer(String[], TransferFrom, FullTransferOption, Boolean)
//   SalesDocument.FullTransfer(Int64[],  TransferFrom, FullTransferOption, Boolean)
//   SalesDocument.FullTransfer(String[], TransferFrom, FullTransferOption)
//   SalesDocument.PartialTransfer(TransferFrom, String, String, Decimal, Int64)
//   SalesDocument.PartialTransfer(TransferFrom, String, String, String, Decimal)
//   SalesDocument.PartialTransfer(TransferFrom, String, String, String, Decimal, Decimal)
//   SalesDocument.PartialTransfer(TransferFrom, String, String, String, Decimal, Decimal, Int64)
//   SalesDocument.InternalFullTransfer / InternalPartialTransfer / AddPartialTransferRow
//   DeliveryOrder.AddPartialTransferDetail(String, Int64[], Boolean)   <- what ran until now
//   DeliveryOrder.AddPartialTransferDetail(String, Int64, Boolean)
//   DeliveryOrder.get_IsTransferFromSupported() / get_IsTransfered() / get_Transferable()
//   SalesDocument.add_OnSalesDocumentTransferConflict(SalesDocumentTransferConflictDelegate)
//   DeliveryOrder.add_ConfirmOverTransferedQtyEvent(ConfirmOverTransferedQtyEventHandler)
//   InvoicingDocument.add_ShowEditTransferDetailFormEvent(ShowEditTransferDetailFormEventHandler)
//   InvoicingDocument.IsFullTransfered() / IsInTransfer() / IsPartialTransfer()
//   InvoicingDocument.IsNotTransferedDetail(Int64) / GetValidTransferDetailRows(Int64)
//
// AutoCount.Invoicing.dll also ships
// FixPartialTransferTransferedQty.FixPartialTransfer(String, DBSetting, Boolean)
// — a vendor repair for partial-transfer quantities going out of sync. This
// service does not call it; it exists here as a warning about how easily the
// remainder bookkeeping gets wrong.
//
// NOTHING HERE IS TYPED AGAINST THOSE SIGNATURES. RunTransfer binds them by the
// parameter NAMES in the assembly's own metadata and logs every overload it
// finds, because this file compiles nowhere but the office host and neither
// FullTransferOption's shape nor PartialTransfer's argument order can be
// established from off it. The reasoning is written out above
// TryDocumentedTransfer. LogTransferApi re-takes the dump above on every
// service start, so the next reader does not have to trust this comment.
//
// The vendor's own pages, which set the debtor/creditor and the document date
// on the target BEFORE calling the transfer — the order Convert_ now follows:
//   wiki.autocountsoft.com/wiki/Programmer:Goods_Received_Note_Transfer_from_Purchase_Order
//   wiki.autocountsoft.com/wiki/Programmer:Sales_Invoice
//   wiki.autocountsoft.com/wiki/Programmer:Delivery_Order
//
// fromDocType literals are the ones the live book already stores in
// DODTL/GRDTL/IVDTL/PIDTL.FromDocType: "SO", "PO", "DO", "GR".
//
// Cancel is a COMMAND method, not a flag: InvoicingCommonCommand.CancelDocument
// (docNo, userID) — inherited by every invoicing command. Setting Cancelled on
// the entity would bypass AutoCount's transferred-document guards.
//
// Build (on the AutoCount host):
//   csc.exe /platform:x64 ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.dll" ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Invoicing.dll" ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Sales.dll" ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Purchase.dll" ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Accounting.dll" ^
//     /r:System.Web.Extensions.dll /r:System.Data.dll /r:System.Drawing.dll ^
//     /out:AcSyncService.exe AcSyncService.cs
//
// Run: AcSyncService.exe   (port from C:\Temp\ac-svc-port.txt, default 8900)
// Routes (all POST, header X-API-KEY):
//   /health          -> { ok, book }
//   /create-so       -> { docNo, lines[] }  payload = header + Details[]
//   /create-po       -> { docNo, lines[] }
//   /so-to-do        -> { docNo, lines[] }  { FromDocNo, DtlKeys[]?, DocDate?, ... }
//   /po-to-gr        -> { docNo, lines[] }
//   /do-to-iv        -> { docNo, lines[] }
//   /gr-to-pi        -> { docNo, lines[] }
//   /cancel          -> { ok }         { DocType, DocNo }
//   /edit            -> { ok }         { DocType, DocNo, Header{}, Lines[] }
//
// ── LINE IDENTITY (2026-08-11) ─────────────────────────────────────────────
// `lines` on every create/convert response is
//     [ { Seq, DtlKey, ItemCode, Desc2 }, ... ]   ordered by DtlKey
// so the ERP can store scm.*_items.linked_ac_dtlkey at the moment the document
// is created. These routes previously answered with the DocNo alone, which left
// EVERY ERP-created document with NULL line identity — and /edit then APPENDED
// duplicate lines into the live book instead of updating them. Measured on prod
// 2026-08-11: 0 of 13,907 SO lines and 0 of 864 PO lines carried a DtlKey.
//
// /edit now REFUSES a line that has neither a DtlKey nor an explicit IsNewLine,
// and a line can be retired in place with Retire:true (Qty = 0, Transferable =
// false, Desc2 marked) because this SDK offers no line-level cancel on any
// class and no line delete at all on PO / GRN / PI / DO / IV.
//
// The SQL connection line (__DBLINE__) is injected at build time so the DB
// password never lives in source control; the API key is read from
// C:\Temp\ac-svc-key.txt. That placeholder appears in every method that opens
// the book directly, and the build step must replace EVERY occurrence, not the
// first. No count is written here any more: this line said "THREE methods —
// Session, DtlKeys and CreatedLines" while there were already seven sites,
// which is the kind of number that goes stale in silence. Grep for it to count
// them, and deploy-on-host.ps1 refuses to compile if any placeholder survives.
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Reflection;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

class AcSyncService {
  const string AC   = @"C:\Program Files\AutoCount\Accounting 2.2";
  /* Substituted at build time from the SAME value that builds the DB connection
     line below, so the
     book this service REPORTS can never disagree with the book it is actually
     connected to. It used to be a separate hardcoded constant, which meant a
     build pointed at a test book still announced the live one on /health — the
     single signal an operator uses to check exactly that. */
  const string BOOK = "__BOOK__";
  /* Port is a FILE, not a constant: 8899 turned out to be pinned inside
     http.sys by an orphaned listener registration from the cutover file
     server, and a service that cannot be moved without a recompile is a
     service that fights the machine it runs on. Default 8900. */
  static string Url =
    "http://localhost:" + (File.Exists(@"C:\Temp\ac-svc-port.txt")
      ? File.ReadAllText(@"C:\Temp\ac-svc-port.txt").Trim() : "8900") + "/";
  const string USER = "ADMIN";

  static string ApiKey =
    File.Exists(@"C:\Temp\ac-svc-key.txt") ? File.ReadAllText(@"C:\Temp\ac-svc-key.txt").Trim() : null;

  /* Prefixed to Desc2 when the ERP retires a line. A line-level Cancelled flag
     does not exist in this SDK (whole-file check of sdk-api-reference.txt: the
     string "Cancelled" appears zero times), so a retired line is recognised by
     Qty = 0 plus this marker. Keep it greppable and keep it ASCII — it is read
     off a printed document and out of SQL by people, not by code. */
  const string RETIRED_MARK = "[ERP-CANCELLED]";

  static void Main() {
    AppDomain.CurrentDomain.AssemblyResolve += (s, e) => {
      var n = new AssemblyName(e.Name).Name;
      var p = Path.Combine(AC, n + ".dll");
      return File.Exists(p) ? Assembly.LoadFrom(p) : null;
    };
    Serve();
  }

  static void Serve() {
    var l = new HttpListener();
    l.Prefixes.Add(Url);
    try { l.Start(); }
    catch (Exception ex) {
      /* Started detached, so an unlogged bind failure looks like "the service
         silently did nothing". Record it where the operator will look. */
      Log("LISTEN FAILED on " + Url + ": " + ex.Message);
      throw;
    }
    Log("AcSyncService listening on " + Url + "  (book=" + BOOK + ")");
    Console.WriteLine("AcSyncService listening on " + Url + "  (book=" + BOOK + ")");
    while (true) {
      var ctx = l.GetContext();
      try { Handle(ctx); }
      catch (Exception ex) {
        Log("ERROR " + ctx.Request.Url.AbsolutePath + ": " + ex);
        try { Json(ctx, 500, new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } }); } catch { }
      }
    }
  }

  /* One place, because /last-errors reads the same file the catch-all writes.
     Two copies of a path is how a reader ends up tailing a file nobody is
     writing to and reporting "no errors". */
  const string LogPath = @"C:\Temp\ac-sync-service.log";

  static void Log(string m) {
    try { File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + m + "\r\n"); } catch { }
  }

  /* Every real payload is one document; the largest sofa order in the cutover
     is tens of KB. Reading an unbounded stream into a string is how a single
     request takes the service down. */
  const int MaxBody = 2 * 1024 * 1024;

  /* WHAT IS ACTUALLY RUNNING ON THIS HOST.
     Until 2026-08-15 /health answered {ok, book, service} and nothing else, so
     the question "does the exe on that machine contain commit X" had no answer
     anywhere: not from this service, not from the repository, not from any
     document that could be trusted to be current. It was answered by reading a
     handoff note instead, which is how a reader concluded the host was three
     changes behind without being able to show it. UNKNOWN was the honest
     answer and there was no way to reach a better one.

     builtAt is the assembly's own file timestamp. Compare it against the date
     of the last commit that touched THIS FILE:

       git log -1 --format=%ad --date=short -- backend/scripts/autocount-service/AcSyncService.cs

     builtAt earlier than that date means the host is behind, full stop.

     DELIBERATELY NOT a version constant someone has to bump, and not a git SHA
     injected at build time. Both are things a person must remember, and this
     repo's own rule is that a hand-maintained fact is a fact with an expiry
     date. The timestamp maintains itself: rebuilding the exe moves it, and
     nothing else can.

     mvid is the module version id, unique per COMPILATION. Two hosts reporting
     the same mvid are running the same bytes; two builds of identical source
     differ. It is what settles "did the rebuild actually get swapped in" when a
     timestamp alone looks plausible.

     Both are read defensively: a single-file compile can run from a location
     the process cannot stat, and /health failing is worse than /health being
     vague — it is the probe used to decide whether the host is up at all. */
  static Dictionary<string, object> Health() {
    var h = new Dictionary<string, object> {
      { "ok", true }, { "book", BOOK }, { "service", "AcSyncService" },
    };
    try {
      var asm = Assembly.GetExecutingAssembly();
      try {
        var loc = asm.Location;
        if (!string.IsNullOrEmpty(loc) && File.Exists(loc)) {
          h["builtAt"] = File.GetLastWriteTimeUtc(loc).ToString("yyyy-MM-ddTHH:mm:ssZ");
        }
      } catch { h["builtAt"] = null; }
      h["mvid"] = asm.ManifestModule.ModuleVersionId.ToString();
    } catch {
      /* Report the gap rather than omitting the keys: an absent key reads as an
         old build that never had them, which is the exact confusion this
         removes. */
      h["builtAt"] = null;
      h["mvid"] = null;
    }
    return h;
  }

  static void Handle(HttpListenerContext ctx) {
    var path = ctx.Request.Url.AbsolutePath;

    /* FAIL CLOSED. This used to read
           if (!IsNullOrEmpty(ApiKey) && header != ApiKey) -> 401
       so NO KEY FILE meant NO CHECK AT ALL - every request accepted, including
       /create-so and /cancel, straight into the licensed live book. One deleted
       file, or one rebuild on a fresh machine, and the account book is open to
       whoever reaches the port; behind a public hostname that is everyone. A
       service with no key configured now serves nothing. */
    if (string.IsNullOrEmpty(ApiKey)) { Json(ctx, 503, Err("no API key configured on the host - refusing every request")); return; }
    if (!SameKey(ctx.Request.Headers["X-API-KEY"], ApiKey)) { Json(ctx, 401, Err("bad key")); return; }

    /* AFTER the key, deliberately: which account book this is connected to is
       not something to hand an anonymous caller on a public hostname. */
    if (path == "/health") {
      Json(ctx, 200, Health());
      return;
    }
    if (ctx.Request.HttpMethod != "POST") { Json(ctx, 405, Err("POST only")); return; }

    if (ctx.Request.ContentLength64 > MaxBody) { Json(ctx, 413, Err("body too large")); return; }
    string body;
    using (var sr = new StreamReader(ctx.Request.InputStream, Encoding.UTF8)) body = sr.ReadToEnd();
    if (body.Length > MaxBody) { Json(ctx, 413, Err("body too large")); return; }
    var p = (Dictionary<string, object>) new JavaScriptSerializer().DeserializeObject(body);
    /* The ROUTE and the DOCUMENT, never the payload. A payload carries the
       customer's name, address and phone, and a log is a file people copy. */
    Log(path + " " + Str(p, "DocType") + " " + Or(Str(p, "DocNo"), Str(p, "FromDocNo")));

    /* Every route that CREATES a document answers with the created line keys
       as well as the DocNo. The DocNo alone is not enough: without the DtlKeys
       the ERP stores NULL line identity, and the next /edit of that very
       document is refused by the keyless-line guard (or, before that guard
       existed, silently appended duplicates into the account book). */
    string docNo;
    string dtlTable;
    switch (path) {
      case "/create-so": docNo = CreateSo(p); dtlTable = "SODTL"; break;
      case "/create-po": docNo = CreatePo(p); dtlTable = "PODTL"; break;
      case "/so-to-do":  docNo = Convert_("SO", "DO", p); dtlTable = "DODTL"; break;
      case "/po-to-gr":  docNo = Convert_("PO", "GR", p); dtlTable = "GRDTL"; break;
      case "/so-to-po":  docNo = SoToPo(p); dtlTable = "PODTL"; break;
      case "/do-to-iv":  docNo = Convert_("DO", "IV", p); dtlTable = "IVDTL"; break;
      case "/gr-to-pi":  docNo = Convert_("GR", "PI", p); dtlTable = "PIDTL"; break;
      case "/cancel":    Cancel(p); Json(ctx, 200, Ok(null)); return;
      case "/edit":      Edit(p);   Json(ctx, 200, Ok(null)); return;
      case "/ensure-masters": Json(ctx, 200, EnsureMasters(p)); return;
      /* READ-ONLY. One SELECT for the column name, one for the value, no writes,
         no SDK session. See FurtherDescription() for why it exists. */
      case "/further-description": Json(ctx, 200, FurtherDescription(p)); return;
      /* READ-ONLY. Two SELECTs, no SDK session. See DocRead() for why. */
      case "/doc-read": Json(ctx, 200, DocRead(p)); return;
      /* READ-ONLY, and it reads a FILE rather than the book. See LastErrors(). */
      case "/last-errors": Json(ctx, 200, LastErrors(p)); return;
      /* READ-ONLY, one aggregate. See PictureCensus(). */
      case "/picture-census": Json(ctx, 200, PictureCensus(p)); return;
      default: Json(ctx, 404, Err("unknown route " + path)); return;
    }
    Json(ctx, 200, Ok(docNo, CreatedLines(dtlTable, docNo)));
  }

  /* ── /further-description — the read that retires a manual instruction sheet ──
     WHY THIS EXISTS. `docs/autocount-handling-listing.md` is a sheet someone has
     to carry to the AutoCount machine and run three SELECTs by hand. It exists
     only because this service exposed no read route at all, and `CLAUDE.md`'s
     standing rule — never ask a human to run a query, build the check — could
     not be honoured for the one database no workflow can reach. The listing's
     own section 8 names this route as the durable fix. This is it.

     IT DISCOVERS THE COLUMN RATHER THAN NAMING IT. The listing's step 1 exists
     because the SDK calls the field `FurtherDescription` and NOBODY HAS LOOKED
     at what the column is called. Hard-coding a guess would turn "the column has
     another name" — a real answer — into a SQL error that reads like a broken
     service. So step 1 is the first query here, and "no such column" comes back
     as a successful answer with `column: null`.

     TRUNCATION IS REPORTED, NEVER SILENT. The listing warns that `sqlcmd` cuts a
     long text column and the reader never sees it happen; that is the failure
     mode this route must not reproduce. The value is capped, and when it is cut
     the response says so and gives the full length, so the caller knows the
     bytes it holds are incomplete.

     READ-ONLY, and mechanically so: two SELECTs on one connection, no SDK
     session, no transaction, and the table name comes from an ALLOW-LIST rather
     than from the caller's string. */
  static readonly string[] DtlTables = { "SODTL", "PODTL", "DODTL", "GRDTL", "IVDTL", "PIDTL" };
  /* 4 MB of RTF is far past any real Further Description; the cap is here so one
     pathological row cannot make the service allocate without bound. */
  const int MaxFurtherDescription = 4 * 1024 * 1024;

  static Dictionary<string, object> FurtherDescription(Dictionary<string, object> p) {
    var table = Or(Str(p, "Table"), "SODTL").ToUpperInvariant();
    if (Array.IndexOf(DtlTables, table) < 0)
      return Err("Table must be one of " + string.Join(", ", DtlTables) + " (got '" + table + "')");

    long dtlKey;
    if (!long.TryParse(Str(p, "DtlKey"), out dtlKey) || dtlKey <= 0)
      return Err("DtlKey must be a positive integer");

    __DBLINE__
    using (var cn = new System.Data.SqlClient.SqlConnection(db.ConnectionString)) {
      cn.Open();

      /* Step 1 of the listing. More than one match is not something to pick
         from — it is the finding, and the caller decides. */
      var cols = new List<Dictionary<string, object>>();
      using (var cmd = cn.CreateCommand()) {
        cmd.CommandText =
          "SELECT name, system_type_id, max_length FROM sys.columns " +
          "WHERE object_id = OBJECT_ID(@t) AND name LIKE '%Further%' ORDER BY name";
        var pt = cmd.CreateParameter(); pt.ParameterName = "@t"; pt.Value = table;
        cmd.Parameters.Add(pt);
        using (var rd = cmd.ExecuteReader()) {
          while (rd.Read()) {
            cols.Add(new Dictionary<string, object> {
              { "name", rd.GetString(0) },
              { "system_type_id", (int) rd.GetByte(1) },
              { "max_length", (int) rd.GetInt16(2) },
            });
          }
        }
      }

      if (cols.Count == 0) {
        /* NOT an error. "The field is stored somewhere else" is the answer the
           listing asks for when step 1 returns nothing, and a 200 is what makes
           it readable as an answer instead of an outage. */
        return new Dictionary<string, object> {
          { "ok", true }, { "table", table }, { "column", null }, { "columns", cols },
          { "note", "no column matching %Further% on " + table + " - the field is stored elsewhere" },
        };
      }
      if (cols.Count > 1) {
        return new Dictionary<string, object> {
          { "ok", true }, { "table", table }, { "column", null }, { "columns", cols },
          { "note", "more than one %Further% column - refusing to guess which one holds the description" },
        };
      }

      var col = (string) cols[0]["name"];
      /* The name came out of sys.columns for this very table, so it is not
         caller input; the DtlKey is still parameterised. */
      string value = null;
      var found = false;
      using (var cmd = cn.CreateCommand()) {
        cmd.CommandText = "SELECT [" + col + "] FROM [" + table + "] WHERE DtlKey = @k";
        var pk = cmd.CreateParameter(); pk.ParameterName = "@k"; pk.Value = dtlKey;
        cmd.Parameters.Add(pk);
        using (var rd = cmd.ExecuteReader()) {
          if (rd.Read()) { found = true; if (!rd.IsDBNull(0)) value = rd.GetValue(0).ToString(); }
        }
      }

      if (!found)
        return new Dictionary<string, object> {
          { "ok", true }, { "table", table }, { "column", col }, { "columns", cols },
          { "dtlKey", dtlKey }, { "found", false },
          { "note", "no row with that DtlKey in " + table },
        };

      var full = value == null ? 0 : value.Length;
      var truncated = full > MaxFurtherDescription;
      return new Dictionary<string, object> {
        { "ok", true }, { "table", table }, { "column", col }, { "columns", cols },
        { "dtlKey", dtlKey }, { "found", true },
        { "isNull", value == null },
        { "length", full },
        { "truncated", truncated },
        { "value", truncated ? value.Substring(0, MaxFurtherDescription) : value },
      };
    }
  }

  /* The DtlKeys of the document we just created, in the order AutoCount stored
     them, each with its ItemCode and Desc2.

     Read back from the book's own detail table rather than off the SDK detail
     objects: DtlKey is assigned by the database at Save() and is not a settable
     property on any detail class, so the entity wrapper is not a dependable
     source for it — the same reason DtlKeys() below reads SQL directly.

     ItemCode and Seq travel with each key ON PURPOSE. The ERP zips this array
     onto its own lines by index; shipping the code alongside lets it ASSERT the
     zip is right and refuse to store anything if the two disagree, instead of
     writing a confidently wrong line identity that would later edit the wrong
     line in a live book. A wrong DtlKey is worse than no DtlKey: no key is
     refused loudly, a wrong key silently edits somebody else's line. */
  /* ── /doc-read — read a document back out of the book ─────────────────────
     WHY THIS EXISTS. Every route here WRITES, and until now nothing could say
     what actually landed. That gap is not academic: `qa-convert.ps1` reported
     `/po-to-gr` as `status=0 ... (500)` and the body was never read, so the
     failure has a symptom and no cause. And the owner's standing questions -
     does an edited processing date reach AutoCount, does a line delivery date,
     is the convert's Transfer link really there - are all questions about what
     the book HOLDS, which no amount of checking our own payload can answer.

     IT DISCOVERS THE COLUMNS RATHER THAN NAMING THEM, for the same reason
     FurtherDescription() does. The wanted list below is what we would LIKE to
     see; the query asks sys.columns which of them exist on that table and
     selects only those, reporting the rest in `missingColumns`. So "AutoCount
     has no such field" comes back as an ANSWER - which is itself the answer to
     "does payment update into AutoCount" if no payment column exists on the
     document - instead of a SQL error that reads like a broken service.

     READ-ONLY and mechanically so: SELECTs on one connection, no SDK session,
     no transaction, and the table names come from a fixed map, never from the
     caller's string. */
  static readonly string[] DocTypes = { "SO", "PO", "DO", "GR", "IV", "PI" };

  /* Wanted on the HEADER. DocNo/DocDate/Cancelled are the identity and the
     state; the rest are the fields the ERP claims to send, so a QA run can
     prove each one arrived rather than assume it. */
  static readonly string[] HeaderWanted = {
    "DocKey", "DocNo", "DocDate", "Cancelled", "DebtorCode", "DebtorName",
    "CreditorCode", "CreditorName", "Agent", "SalesLocation", "Ref",
    "Description", "DeliveryDate", "ProcessingDate", "Note",
    "Remark1", "Remark2", "Remark3", "Remark4", "Attention", "Phone1",
    "DeliverAddr1", "InvAddr1", "SupplierDONo", "SupplierInvoiceNo",
    "Total", "OutstandingAmt", "PaymentAmt", "PaymentTerm", "CreditTerm",
    /* The REAL names, learned by listing sys.columns on 2026-08-15 after the
       first run reported SO.Agent as missing - which it is, because the column
       is SalesAgent. A wanted list built from SDK PROPERTY names answers a
       different question than the one being asked, and "no such column" then
       reads as "AutoCount cannot hold this" when it only means "not by that
       name". These are the columns the book actually has. */
    "SalesAgent", "DisplayTerm", "UDF_PDate", "UDF_UDate", "UDF_PAYEMENT",
  };

  /* Wanted on the LINES. From* is the whole point of the convert questions:
     it is where AutoCount records that this line came from another document,
     and it is what "convert from / convert to" reads. */
  static readonly string[] DetailWanted = {
    "DtlKey", "Seq", "ItemCode", "Description", "Desc2", "Qty", "UnitPrice",
    "Location", "DeliveryDate", "TransferedQty", "Transferable",
    /* FromDocDtlKey, not FromDtlKey - same lesson as above, same day.
       FullTransferFromDocList is AutoCount's own summary of every document a
       line was transferred from, so it is the cheapest single answer to "is
       the convert-from link there". */
    "FromDocType", "FromDocNo", "FromDocDtlKey", "FullTransferFromDocList",
    "EstimatedDeliveryDate", "PrintOut",
  };

  /* ── /last-errors — the tail of this service's own log ────────────────────
     WHY. The catch-all in Serve() already writes the FULL exception here, and
     on 2026-08-15 that is where both open failures turned out to be written:

       ERROR /so-to-po: ForeignKeyException (Constraint Name=FK_PO_DisplayTerm)
       ERROR /cancel:   TransferedDocNotAllowToCancelException

     Both had been reported for days as "500, no body" and chased as mysteries.
     The cause was on this machine the whole time, and reaching it cost a remote
     desktop session, LINQPad, and a person. That is the same argument section 8
     of the handling listing makes about the account book: if the answer needs a
     human to go and fetch it, the answer does not get fetched.

     It returns the tail only, and never the whole file: the log carries every
     request line and grows without bound. */
  const int MaxLogLines = 400;

  static Dictionary<string, object> LastErrors(Dictionary<string, object> p) {
    int want = 60;
    int.TryParse(Str(p, "Lines"), out want);
    if (want <= 0) want = 60;
    if (want > MaxLogLines) want = MaxLogLines;
    var onlyErrors = Bool(p, "OnlyErrors");

    var r = Ok(null);
    r["path"] = LogPath;
    if (!File.Exists(LogPath)) { r["exists"] = false; r["lines"] = new List<string>(); return r; }
    r["exists"] = true;

    string[] all;
    /* The service is appending to this file while we read it, so share the
       write handle rather than fighting for it. A locked log must not be able
       to take the service down. */
    try {
      using (var fs = new FileStream(LogPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
      using (var sr = new StreamReader(fs)) {
        var lines = new List<string>();
        string ln;
        while ((ln = sr.ReadLine()) != null) lines.Add(ln);
        all = lines.ToArray();
      }
    } catch (Exception ex) { return Err("could not read the log: " + ex.Message); }

    r["totalLines"] = all.Length;
    var picked = new List<string>();
    if (onlyErrors) {
      /* An ERROR line is followed by its stack, and the stack is the useful
         half - so take the ERROR line and everything under it up to the next
         timestamped request line. */
      for (int i = 0; i < all.Length; i++) {
        if (all[i].IndexOf(" ERROR ", StringComparison.Ordinal) < 0) continue;
        for (int j = i; j < all.Length && j < i + 40; j++) {
          if (j > i && all[j].Length > 4 && all[j].StartsWith("20") && all[j].IndexOf(" ERROR ", StringComparison.Ordinal) < 0) break;
          picked.Add(all[j]);
        }
        picked.Add("---");
      }
      if (picked.Count > want) picked = picked.GetRange(picked.Count - want, want);
    } else {
      var from = Math.Max(0, all.Length - want);
      for (int i = from; i < all.Length; i++) picked.Add(all[i]);
    }
    r["lines"] = picked;
    return r;
  }

  /* ── /picture-census — does ANY line hold more than one picture ───────────
     THE ONLY REASON THIS MATTERS. FurtherDescription is replaced WHOLESALE -
     there is no append - so if a line we rewrite holds two pictures and we send
     one, the second is DESTROYED and nothing says so.

     The photo manifest says one picture per line for all 554 of its rows, but
     the manifest is the output of an extractor nobody kept, so it cannot rule
     out that the extractor took only the first. This asks the BOOK instead, in
     one aggregate over the whole table.

     max_pictures = 1 closes it. Anything higher is a finding, and the composer
     needs a read-before-write on those lines before it may touch them. */
  /* VERBATIM on purpose. In a normal C# literal "\p" is not a valid
     escape and does not compile; @ turns escape processing off, so the marker
     is exactly the six characters SQL must match. */
  static readonly string PictMarker = @"{\pict";

  static Dictionary<string, object> PictureCensus(Dictionary<string, object> p) {
    var table = Or(Str(p, "Table"), "SODTL").ToUpperInvariant();
    if (Array.IndexOf(DtlTables, table) < 0)
      return Err("Table must be one of " + string.Join(", ", DtlTables) + " (got '" + table + "')");

    __DBLINE__
    using (var cn = new System.Data.SqlClient.SqlConnection(db.ConnectionString)) {
      cn.Open();
      var missing = new List<string>();
      var cols = ExistingColumns(cn, table, new[] { "FurtherDescription" }, missing);
      if (cols.Count == 0) { var e = Ok(null); e["table"] = table; e["column"] = null; return e; }

      using (var cmd = cn.CreateCommand()) {
        /* LEN() ignores trailing spaces but the marker is 6 characters of
           punctuation, so the subtraction is exact. */
        cmd.CommandText =
          "SELECT COUNT(*) AS lines_with_a_value, " +
          "       MAX((LEN(FurtherDescription) - LEN(REPLACE(FurtherDescription, '" + PictMarker + "', ''))) / 6) AS max_pictures, " +
          "       SUM(CASE WHEN (LEN(FurtherDescription) - LEN(REPLACE(FurtherDescription, '" + PictMarker + "', ''))) / 6 > 1 THEN 1 ELSE 0 END) AS lines_over_one " +
          "FROM [" + table + "] " +
          "WHERE FurtherDescription IS NOT NULL AND LEN(FurtherDescription) > 0";
        cmd.CommandTimeout = 180;
        using (var rd = cmd.ExecuteReader()) {
          var r = Ok(null);
          r["table"] = table;
          if (rd.Read()) {
            /* Convert, never GetInt32. LEN() over nvarchar(MAX) returns BIGINT,
               so the arithmetic that follows is bigint too, and GetInt32 throws
               "Specified cast is not valid" - which is what the first run of
               this route did, on the host, against the real table. */
            r["linesWithAValue"] = rd.IsDBNull(0) ? 0L : System.Convert.ToInt64(rd.GetValue(0));
            r["maxPictures"]     = rd.IsDBNull(1) ? 0L : System.Convert.ToInt64(rd.GetValue(1));
            r["linesOverOne"]    = rd.IsDBNull(2) ? 0L : System.Convert.ToInt64(rd.GetValue(2));
          }
          return r;
        }
      }
    }
  }

  static Dictionary<string, object> DocRead(Dictionary<string, object> p) {
    var docType = Str(p, "DocType").ToUpperInvariant();
    if (Array.IndexOf(DocTypes, docType) < 0)
      return Err("DocType must be one of " + string.Join(", ", DocTypes) + " (got '" + docType + "')");
    var docNo = Str(p, "DocNo");
    if (string.IsNullOrEmpty(docNo)) return Err("DocNo required");

    var hdrTable = docType;
    var dtlTable = docType + "DTL";

    __DBLINE__
    using (var cn = new System.Data.SqlClient.SqlConnection(db.ConnectionString)) {
      cn.Open();
      var missing = new List<string>();
      var header = ReadOne(cn, hdrTable, HeaderWanted, "DocNo = @d", docNo, missing);
      if (header == null) return Err("no " + docType + " with DocNo '" + docNo + "'");
      var lines = ReadMany(cn, dtlTable, DetailWanted,
                           "DocKey = (SELECT DocKey FROM " + hdrTable + " WHERE DocNo = @d)", docNo, missing);
      var r = Ok(null);
      r["docType"] = docType;
      r["header"] = header;
      r["lines"] = lines;
      r["missingColumns"] = missing;
      return r;
    }
  }

  /* Which of `wanted` actually exist on `table`. The ones that do not are
     APPENDED to `missing` rather than dropped silently: a caller asking "did
     the processing date update" needs to be told the difference between "it is
     null" and "there is no such column". */
  static List<string> ExistingColumns(System.Data.SqlClient.SqlConnection cn, string table, string[] wanted, List<string> missing) {
    var have = new List<string>();
    using (var cmd = cn.CreateCommand()) {
      cmd.CommandText = "SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@t)";
      var pt = cmd.CreateParameter(); pt.ParameterName = "@t"; pt.Value = table;
      cmd.Parameters.Add(pt);
      var all = new List<string>();
      using (var rd = cmd.ExecuteReader()) while (rd.Read()) all.Add(rd.GetString(0));
      foreach (var w in wanted) {
        if (all.Contains(w)) have.Add(w); else missing.Add(table + "." + w);
      }
    }
    return have;
  }

  static string SelectList(List<string> cols) {
    var q = new List<string>();
    foreach (var c in cols) q.Add("[" + c + "]");
    return string.Join(", ", q.ToArray());
  }

  static Dictionary<string, object> RowToDict(System.Data.SqlClient.SqlDataReader rd, List<string> cols) {
    var row = new Dictionary<string, object>();
    for (int i = 0; i < cols.Count; i++) {
      var v = rd.IsDBNull(i) ? null : rd.GetValue(i);
      if (v is DateTime) v = ((DateTime) v).ToString("yyyy-MM-dd HH:mm:ss");
      else if (v is decimal) v = (double) (decimal) v;
      row[cols[i]] = v;
    }
    return row;
  }

  static Dictionary<string, object> ReadOne(System.Data.SqlClient.SqlConnection cn, string table, string[] wanted, string where, string docNo, List<string> missing) {
    var cols = ExistingColumns(cn, table, wanted, missing);
    if (cols.Count == 0) return null;
    using (var cmd = cn.CreateCommand()) {
      cmd.CommandText = "SELECT TOP 1 " + SelectList(cols) + " FROM [" + table + "] WHERE " + where;
      var pd = cmd.CreateParameter(); pd.ParameterName = "@d"; pd.Value = docNo;
      cmd.Parameters.Add(pd);
      using (var rd = cmd.ExecuteReader()) return rd.Read() ? RowToDict(rd, cols) : null;
    }
  }

  static List<Dictionary<string, object>> ReadMany(System.Data.SqlClient.SqlConnection cn, string table, string[] wanted, string where, string docNo, List<string> missing) {
    var outp = new List<Dictionary<string, object>>();
    var cols = ExistingColumns(cn, table, wanted, missing);
    if (cols.Count == 0) return outp;
    using (var cmd = cn.CreateCommand()) {
      cmd.CommandText = "SELECT " + SelectList(cols) + " FROM [" + table + "] WHERE " + where + " ORDER BY [DtlKey]";
      var pd = cmd.CreateParameter(); pd.ParameterName = "@d"; pd.Value = docNo;
      cmd.Parameters.Add(pd);
      using (var rd = cmd.ExecuteReader()) while (rd.Read()) outp.Add(RowToDict(rd, cols));
    }
    return outp;
  }

  static List<Dictionary<string, object>> CreatedLines(string dtlTable, string docNo) {
    var hdr = dtlTable.Substring(0, dtlTable.Length - 3);
    var outp = new List<Dictionary<string, object>>();
    if (string.IsNullOrEmpty(docNo)) return outp;
    try {
      __DBLINE__
      using (var cn = new System.Data.SqlClient.SqlConnection(db.ConnectionString)) {
        cn.Open();
        using (var cmd = cn.CreateCommand()) {
          cmd.CommandText =
            "SELECT d.DtlKey, d.ItemCode, d.Desc2 FROM " + dtlTable + " d " +
            "JOIN " + hdr + " h ON h.DocKey = d.DocKey " +
            "WHERE h.DocNo = @no ORDER BY d.DtlKey";
          var pr = cmd.CreateParameter(); pr.ParameterName = "@no"; pr.Value = docNo;
          cmd.Parameters.Add(pr);
          using (var rd = cmd.ExecuteReader()) {
            var seq = 0;
            while (rd.Read()) {
              outp.Add(new Dictionary<string, object> {
                { "Seq", seq++ },
                { "DtlKey", rd.GetInt64(0) },
                { "ItemCode", rd.IsDBNull(1) ? "" : rd.GetString(1) },
                { "Desc2", rd.IsDBNull(2) ? "" : rd.GetString(2) },
              });
            }
          }
        }
      }
    } catch (Exception ex) {
      /* Never fail a CREATE that already succeeded just because the read-back
         did not. The document exists in AutoCount and the ERP must be told its
         DocNo; missing keys degrade to the refusal path on a later edit, which
         is visible and recoverable. Losing the DocNo would not be. */
      Log("  CreatedLines(" + dtlTable + ", " + docNo + ") failed: " + ex.Message);
      return new List<Dictionary<string, object>>();
    }
    return outp;
  }

  // ── session ───────────────────────────────────────────────────────────────
  static AutoCount.Authentication.UserSession Session() {
    __DBLINE__
    var s = new AutoCount.Authentication.UserSession(db);
    if (!s.Login(USER, USER)) throw new Exception("AutoCount login failed");
    return s;
  }

  // ── create (SO / PO) ──────────────────────────────────────────────────────
  /* A DOCUMENT NUMBER IS NOT OPTIONAL, and an absent one used to be silent.
     Str() answers "" for a key that is not there - not null, not an error - so
     `DocNo = Str(p, "DocNo")` on a payload without one saved a document with a
     BLANK number and answered {"ok":true,"docNo":"","lines":[]}. That reads as
     success and is worse than a failure: every route that addresses a document
     does it BY DocNo, so a blank-numbered document cannot be edited, cannot be
     converted, and cannot even be CANCELLED through this service. It can only
     be reached by hand in the AutoCount UI.

     Measured on the live book 2026-08-15, after doing exactly that by accident:
     SELECT COUNT(*) FROM SO WHERE DocNo IS NULL OR LTRIM(RTRIM(DocNo)) = ''
     returned 1, and it was the one just created. So the ERP has never done this
     - it always sends its own number (module guide 7g) - and nothing in the
     book depends on AutoCount auto-numbering a document for us. Refusing is
     therefore free, and it converts an unrecoverable silent success into a
     visible 400. */
  static void RequireDocNo(Dictionary<string, object> p, string what) {
    if (string.IsNullOrEmpty(Str(p, "DocNo").Trim()))
      throw new Exception("DocNo required for " + what + " - the ERP owns document numbering, and a blank number cannot be addressed, edited or cancelled afterwards");
  }

  static string CreateSo(Dictionary<string, object> p) {
    RequireDocNo(p, "/create-so");
    var s = Session();
    var cmd = AutoCount.Invoicing.Sales.SalesOrder.SalesOrderCommand.Create(s, s.DBSetting);
    var so = cmd.AddNew();
    so.DocNo = Str(p, "DocNo");
    so.DocDate = Date(p, "DocDate") ?? DateTime.Today;
    so.DebtorCode = Str(p, "DebtorCode");
    so.DebtorName = Str(p, "DebtorName");
    Set(() => so.Agent = Str(p, "Agent"));
    Set(() => so.SalesLocation = Str(p, "SalesLocation"));
    Set(() => so.Ref = Str(p, "Ref"));
    Set(() => so.Phone1 = Str(p, "Phone"));
    Set(() => so.Attention = Or(Str(p, "Attention"), Str(p, "DebtorName")));
    so.InvAddr1 = Str(p, "InvAddr1"); so.InvAddr2 = Str(p, "InvAddr2");
    so.InvAddr3 = Str(p, "InvAddr3"); so.InvAddr4 = Str(p, "InvAddr4");
    var d1 = Or(Str(p, "DeliverAddr1"), Str(p, "InvAddr1"));
    so.IsDeliveryAddressEditedManually = true;
    so.DeliverAddr1 = d1;
    so.DeliverAddr2 = Or(Str(p, "DeliverAddr2"), Str(p, "InvAddr2"));
    so.DeliverAddr3 = Or(Str(p, "DeliverAddr3"), Str(p, "InvAddr3"));
    so.DeliverAddr4 = Or(Str(p, "DeliverAddr4"), Str(p, "InvAddr4"));
    Set(() => so.DeliverContact = Or(Str(p, "DeliverContact"), Str(p, "DebtorName")));
    Set(() => so.DeliverPhone1 = Or(Str(p, "DeliverPhone1"), Str(p, "Phone")));
    /* The delivery date, in the field this book keeps it in — see the note in
       Edit(). Present-and-null blanks it; absent leaves AutoCount's default. */
    if (p.ContainsKey("SalesExemptionExpiryDate")) {
      var xd = Date(p, "SalesExemptionExpiryDate");
      Set(() => so.SalesExemptionExpiryDate = xd);
    }
    ApplyUdf(p, k => so.UDF[k], (k, v) => so.UDF[k] = v);
    foreach (var od in List(p, "Details")) {
      var it = (Dictionary<string, object>) od;
      var d = so.AddDetail();
      d.ItemCode = Str(it, "ItemCode");
      d.Description = Str(it, "Description");
      Set(() => d.Desc2 = Str(it, "Desc2"));
      d.Qty = Dec(it, "Qty", 1);
      d.UnitPrice = Dec(it, "UnitPrice", 0);
      Set(() => d.Location = Str(it, "Location"));
      /* PRESENT-AND-NULL BLANKS IT; ABSENT LEAVES AUTOCOUNT'S DEFAULT.
         Owner 2026-08-15: a line the ERP has no delivery date for was arriving
         carrying the DOCUMENT date, and it should be BLANK - which is what the
         cutover left, on 11,886 of this book's own 60,939 sales-order lines.
         This was `if (dd.HasValue)`, and that is exactly why it could not:
         Date() answers null for an absent key and a null one alike, so the old
         guard had no way to say "blank it" and every dateless line fell through
         to AutoCount's default. ContainsKey separates the two, the same way the
         Edit header loop below separates them. The property is
         DeliveryDate:Nullable`1 on all six detail classes, so the null is the
         SDK's own shape; Set() stays because a class that refused the null must
         cost the default, never the document. */
      if (it.ContainsKey("DeliveryDate")) {
        var dd = Date(it, "DeliveryDate"); Set(() => d.DeliveryDate = dd);
      }
    }
    so.Save();
    return so.DocNo;
  }

  static string CreatePo(Dictionary<string, object> p) {
    RequireDocNo(p, "/create-po");   // same reasoning as CreateSo above
    var s = Session();
    var cmd = AutoCount.Invoicing.Purchase.PurchaseOrder.PurchaseOrderCommand.Create(s, s.DBSetting);
    var po = cmd.AddNew();
    po.DocNo = Str(p, "DocNo");
    po.DocDate = Date(p, "DocDate") ?? DateTime.Today;
    po.CreditorCode = Str(p, "CreditorCode");
    po.CreditorName = Str(p, "CreditorName");
    Set(() => po.Agent = Str(p, "Agent"));
    Set(() => po.Ref = Str(p, "Ref"));
    Set(() => po.Description = Str(p, "Description"));
    ApplyUdf(p, k => po.UDF[k], (k, v) => po.UDF[k] = v);
    foreach (var od in List(p, "Details")) {
      var it = (Dictionary<string, object>) od;
      var d = po.AddDetail();
      d.ItemCode = Str(it, "ItemCode");
      d.Description = Str(it, "Description");
      Set(() => d.Desc2 = Str(it, "Desc2"));
      d.Qty = Dec(it, "Qty", 1);
      d.UnitPrice = Dec(it, "UnitPrice", 0);
      Set(() => d.Location = Str(it, "Location"));
      // Present-and-null blanks it; absent leaves AutoCount's default. See CreateSo.
      if (it.ContainsKey("DeliveryDate")) {
        var dd = Date(it, "DeliveryDate"); Set(() => d.DeliveryDate = dd);
      }
    }
    po.Save();
    return po.DocNo;
  }

  // ── conversions (SO->DO, PO->GR, DO->IV, GR->PI) ──────────────────────────
  /* One code path: PLAN the shape, create the target, set the master fields the
     vendor's own examples set FIRST, run the transfer, apply the rest of the
     header, Save.

     THE ORDER IS THE VENDOR'S, and it changed here on 2026-08-17. This method
     used to be AddNew() -> transfer -> SalesHeader() -> Save(), so every
     conversion ran its transfer against a target carrying no debtor and no
     creditor: neither SalesHeader nor PurchaseHeader sets one, and the only
     reason a GRN has a supplier at all is transferMaster:true copying it out of
     the source inside the SDK. All three vendor pages for this API set the
     account and the document date on the TARGET before calling the transfer:

       wiki.autocountsoft.com/wiki/Programmer:Goods_Received_Note_Transfer_from_Purchase_Order
       wiki.autocountsoft.com/wiki/Programmer:Sales_Invoice
       wiki.autocountsoft.com/wiki/Programmer:Delivery_Order

     LEFT AS A CONTRADICTION RATHER THAN BRIDGED. DO-011260 was written on
     2026-08-12 through the OLD order and it worked, so "the target has no
     debtor" cannot on its own be the whole of what has failed since. Something
     else changed between that document and HC-DO-2608-001; this reorder makes
     the call match the vendor's, it does not claim to be the proven cause. */
  static string Convert_(string fromType, string toType, Dictionary<string, object> p) {
    var s = Session();
    var fromDocNo = Str(p, "FromDocNo");
    var plan = PlanTransfer(p, fromType, fromDocNo);
    Log("  " + fromType + "->" + toType + " shape: " + plan.Why);

    /* LINE KEYS, for the two things that need them whatever the shape: the
       AddPartialTransferDetail primitive, and DescribeSourceKeys on a failure.
       A FULL transfer names DOCUMENTS, so its keys are resolved the way this
       service has always resolved them - every still-outstanding line on each
       named source, read out of the book. */
    long[] dtlKeys;
    if (plan.Full) {
      var all = new List<long>();
      foreach (var no in plan.FromDocNos) all.AddRange(DtlKeys(p, fromType, no));
      dtlKeys = all.ToArray();
    } else {
      dtlKeys = plan.DtlKeys;
    }
    if (dtlKeys.Length == 0)
      throw new Exception("no transferable lines on " + fromType + " " + Or(fromDocNo, "(the given DtlKeys)"));

    /* ONE CALL PER SOURCE DOCUMENT for the primitive. AddPartialTransferDetail
       takes an array of line keys, but they must all belong to the SAME source
       document: handed a mixed array AutoCount answers

         AutoCount.Invoicing.InvalidTransferItemException: Invalid transfer item.

       measured on the live book 2026-08-16 with two sales orders in one array.
       The documented FullTransfer takes an ARRAY of document numbers and has no
       such restriction, which is why the multi-source WHOLE-document case
       belongs there and this grouping is only the primitive's problem. */
    var keysByDoc = KeysBySourceDoc(fromType, dtlKeys);

    var x = new Xfer();
    x.FromType = fromType;
    x.ToType = toType;
    x.Plan = plan;
    x.DtlKeys = dtlKeys;
    x.KeysByDoc = keysByDoc;
    x.PurchaseSide = (toType == "GR" || toType == "PI");
    x.DocDate = Date(p, "DocDate");
    x.S = s;
    x.SourceDocNos = plan.Full ? plan.FromDocNos : new List<string>(keysByDoc.Keys).ToArray();
    ReadSourceAccount(x);

    /* THE FAILURE HAS TO NAME THE LINES. AutoCount answers a source line it
       will not take with

         AutoCount.Invoicing.InvalidTransferItemException: Invalid transfer item.

       and that sentence names nothing: not the key, not the document, not the
       reason. Serve's catch-all returns ex.Message alone, so the ERP's outbox
       row records those eleven words and nothing else. On 2026-08-16
       HC-DO-2608-001 spent all six of its attempts on it and HC-DO-2608-002
       five more, and none of the eleven runs produced a single new fact.

       WRAPS THE WHOLE ARM, not just the transfer call - where the SDK raises
       this is not established from off the host, and narrowing the catch would
       be a guess about the frame that costs the diagnostic on the runs that
       need it. */
    try {
      switch (toType) {
        case "DO": {
          var cmd = AutoCount.Invoicing.Sales.DeliveryOrder.DeliveryOrderCommand.Create(s, s.DBSetting);
          var doc = cmd.AddNew();
          x.Primitive = () => { foreach (var g in keysByDoc) doc.AddPartialTransferDetail(fromType, g.Value.ToArray(), false); };
          RunTransfer(doc, x);
          SalesHeader(doc, p);
          doc.Save();
          return doc.DocNo;
        }
        case "IV": {
          var cmd = AutoCount.Invoicing.Sales.Invoice.InvoiceCommand.Create(s, s.DBSetting);
          var doc = cmd.AddNew();
          x.Primitive = () => { foreach (var g in keysByDoc) doc.AddPartialTransferDetail(fromType, g.Value.ToArray(), false); };
          RunTransfer(doc, x);
          SalesHeader(doc, p);
          doc.Save();
          return doc.DocNo;
        }
        case "GR": {
          var cmd = AutoCount.Invoicing.Purchase.GoodsReceivedNote.GoodsReceivedNoteCommand.Create(s, s.DBSetting);
          var doc = cmd.AddNew();
          /* This conversion has failed since 2026-08-12 with
               IndexOutOfRangeException: There is no row at position -1
             inside GeneralPurchasePartialTransferDetail..ctor - a master lookup
             returning -1 and used as an index. The frame names its arguments but
             not their VALUES, so they go in the log before the call. */
          Log("  po-to-gr: fromType=" + fromType + " transferMaster=true keys=[" + string.Join(",", Array.ConvertAll(dtlKeys, k => k.ToString())) + "]");
          // transferMaster MUST be true on the purchase side. That flag copies the
          // source PO's header master (supplier/currency/terms) onto the target; with
          // false the GRN is built with no supplier, the purchase detail ctor looks
          // that row up in the master table, IndexOf returns -1, and Save() dies with
          // "there is no row at position -1". The sales classes tolerate false, so they
          // are left alone — DO-011260 and DO-011262 were both created that way.
          //
          // ReadSourceAccount now also sets the creditor EXPLICITLY before the transfer,
          // which is the vendor's order; the flag stays true because that is what has
          // been running, and dropping it would be a second unverifiable change inside
          // one call. Run status does not belong in a comment:
          // docs/generated/autocount-coverage.md is the one place that states it.
          x.Primitive = () => { foreach (var g in keysByDoc) doc.AddPartialTransferDetail(fromType, g.Value.ToArray(), true); };
          RunTransfer(doc, x);
          PurchaseHeader(doc, p);
          Set(() => doc.SupplierDONo = Str(p, "SupplierDONo"));
          doc.Save();
          return doc.DocNo;
        }
        case "PI": {
          var cmd = AutoCount.Invoicing.Purchase.PurchaseInvoice.PurchaseInvoiceCommand.Create(s, s.DBSetting);
          var doc = cmd.AddNew();
          // see the GR case above — purchase side needs transferMaster = true
          x.Primitive = () => { foreach (var g in keysByDoc) doc.AddPartialTransferDetail(fromType, g.Value.ToArray(), true); };
          RunTransfer(doc, x);
          PurchaseHeader(doc, p);
          Set(() => doc.SupplierInvoiceNo = Str(p, "SupplierInvoiceNo"));
          doc.Save();
          return doc.DocNo;
        }
      }
    } catch (Exception ex) {
      var why = DescribeSourceKeys(fromType, dtlKeys);
      Log("  " + fromType + "->" + toType + " refused: " + ex.GetType().FullName + ": " + ex.Message.Trim());
      Log("  source lines as the book holds them: " + why);
      /* The SDK's own exception is the INNER one, so /last-errors and the log
         still carry its type and stack; the message the ERP stores is the one
         that names the lines. */
      throw new Exception(
        ex.Message.Trim() + " || source " + fromType + " lines as the book holds them: " + why, ex);
    }
    throw new Exception("unsupported target " + toType);
  }

  /* ── WHICH SHAPE: FULL or PARTIAL, and the ERP decides it ─────────────────
     Owner 2026-08-16: 「你要确保它是可以 partially transfer 跟 fully transfer 的。
     跟着我们的 ERP 就对了」 - both shapes have to work, and ours is the authority
     on which one this document is.

     ONE PLACE, and it is this method. The signal is what the payload SAYS, never
     what the numbers happen to add up to:

       DtlKeys ABSENT   -> FULL. The ERP is moving the whole source document:
                           every line, full quantity. FullTransfer takes an ARRAY
                           of document numbers, so several sources into one
                           target is native here and needs no grouping.
       DtlKeys PRESENT  -> PARTIAL BY LINE. The ERP has NAMED the lines it took.
                           It stays partial even when the named set turns out to
                           be everything still outstanding: promoting it because
                           the numbers match today would be this service
                           deciding, and they are only equal until the next
                           document.
       Details[].Qty    -> PARTIAL BY QUANTITY. The ERP is taking part of a LINE
                           - 3 of 5 - and that number is the number AutoCount
                           must receive.

     WHAT THE PAYLOAD CANNOT SAY TODAY, stated rather than papered over: the four
     conversions send { DocNo, DocDate?, Ref?, DtlKeys? } and no per-line
     quantity at all (autocount-outbox.ts, enqueueConvert). Every documented
     PartialTransfer overload takes a Decimal quantity, so none of them can be
     filled from what this service is actually told, and a by-line partial moves
     each named line at its OUTSTANDING quantity - which is what
     AddPartialTransferDetail does and what has always happened here. For the ERP
     to express "3 of 5" it has to send Details:[{ DtlKey, Qty }]. This method
     reads that the moment it appears, and RunTransfer REFUSES rather than
     shipping a quantity nobody asked for. */
  class TransferPlan {
    public bool Full;
    public string[] FromDocNos;
    public long[] DtlKeys;
    public Dictionary<long, decimal> QtyByKey;
    public string Why;
  }

  static TransferPlan PlanTransfer(Dictionary<string, object> p, string fromType, string fromDocNo) {
    var plan = new TransferPlan();
    plan.QtyByKey = new Dictionary<long, decimal>();
    foreach (var od in List(p, "Details")) {
      var it = od as Dictionary<string, object>;
      if (it == null || !it.ContainsKey("DtlKey") || !it.ContainsKey("Qty")) continue;
      plan.QtyByKey[System.Convert.ToInt64(it["DtlKey"])] = Dec(it, "Qty", 0);
    }

    var keys = LongList(p, "DtlKeys");
    if (keys.Length == 0) {
      if (plan.QtyByKey.Count > 0)
        throw new Exception("a per-line Qty was sent without DtlKeys - a partial quantity has to name the line it is a quantity OF");
      var nos = new List<string>();
      foreach (var o in List(p, "FromDocNos")) {
        var no = o == null ? "" : o.ToString().Trim();
        if (no.Length > 0 && !nos.Contains(no)) nos.Add(no);
      }
      if (nos.Count == 0 && !string.IsNullOrEmpty(fromDocNo)) nos.Add(fromDocNo);
      if (nos.Count == 0)
        throw new Exception("FromDocNo (or FromDocNos) required when DtlKeys is not given - it is how the source documents are named");
      plan.Full = true;
      plan.FromDocNos = nos.ToArray();
      plan.Why = "FULL - the ERP named no lines, so " + string.Join(" + ", plan.FromDocNos) + " transfers whole";
      return plan;
    }

    plan.Full = false;
    plan.DtlKeys = keys;
    if (plan.QtyByKey.Count == 0) {
      plan.Why = "PARTIAL BY LINE - the ERP named " + keys.Length +
        " source line(s) and no quantity, so each moves at its outstanding quantity";
      return plan;
    }
    foreach (var k in keys)
      if (!plan.QtyByKey.ContainsKey(k))
        throw new Exception("DtlKey " + k + " was named with no Qty while other lines on the same document carry one - " +
          "a partial quantity is all-or-nothing per document, because a line with no number would silently move its whole outstanding quantity");
    var parts = new List<string>();
    foreach (var k in keys) parts.Add(k + "=" + plan.QtyByKey[k]);
    plan.Why = "PARTIAL BY QUANTITY - the ERP is taking " + string.Join(", ", parts.ToArray());
    return plan;
  }

  /* Everything one transfer needs, so the four arms above read as four
     documents rather than four copies of the same dozen arguments. */
  class Xfer {
    public string FromType, ToType;
    public TransferPlan Plan;
    public long[] DtlKeys;
    public Dictionary<string, List<long>> KeysByDoc;
    public string[] SourceDocNos;
    public bool PurchaseSide;
    public DateTime? DocDate;
    public string AccountCode, AccountName;
    public AutoCount.Authentication.UserSession S;
    /* AddPartialTransferDetail, bound to the arm's own document. The documented
       call for "these lines, whatever is outstanding", and the fallback for
       everything else. */
    public Action Primitive;
    public Dictionary<long, Dictionary<string, object>> LineCache =
      new Dictionary<long, Dictionary<string, object>>();
  }

  /* WHOSE DOCUMENT THIS IS, off the SOURCE header in the book.
     The conversion payload carries no debtor and no creditor - it never has -
     so the account cannot come from the ERP without a contract change. The
     source document's own header is the next authority, and it is the same row
     transferMaster copies from inside the SDK.

     Two sources with two different accounts is a FINDING, not something to pick
     from: it is logged and nothing is set, because a document written to the
     wrong customer is worse than one written with none. */
  static void ReadSourceAccount(Xfer x) {
    try {
      if (Array.IndexOf(DocTypes, x.FromType) < 0) return;
      var hdr = x.FromType;
      var codeCol = x.PurchaseSide ? "CreditorCode" : "DebtorCode";
      var nameCol = x.PurchaseSide ? "CreditorName" : "DebtorName";
      __DBLINE__
      using (var cn = new System.Data.SqlClient.SqlConnection(db.ConnectionString)) {
        cn.Open();
        var absent = new List<string>();
        var cols = ExistingColumns(cn, hdr, new string[] { codeCol, nameCol }, absent);
        if (cols.IndexOf(codeCol) < 0) {
          Log("  source account: " + hdr + " has no " + codeCol + " column - leaving the target's account to the transfer");
          return;
        }
        var seen = new Dictionary<string, string>();
        using (var cmd = cn.CreateCommand()) {
          var names = new List<string>();
          for (int i = 0; i < x.SourceDocNos.Length; i++) {
            var nm = "@d" + i;
            names.Add(nm);
            var pr = cmd.CreateParameter(); pr.ParameterName = nm; pr.Value = x.SourceDocNos[i];
            cmd.Parameters.Add(pr);
          }
          cmd.CommandText = "SELECT " + SelectList(cols) + " FROM [" + hdr + "] WHERE DocNo IN (" +
            string.Join(", ", names.ToArray()) + ")";
          using (var rd = cmd.ExecuteReader()) {
            while (rd.Read()) {
              var row = RowToDict(rd, cols);
              var code = row.ContainsKey(codeCol) && row[codeCol] != null ? row[codeCol].ToString().Trim() : "";
              if (code.Length == 0) continue;
              seen[code] = row.ContainsKey(nameCol) && row[nameCol] != null ? row[nameCol].ToString() : "";
            }
          }
        }
        if (seen.Count == 0) { Log("  source account: no " + codeCol + " on " + string.Join(" + ", x.SourceDocNos)); return; }
        if (seen.Count > 1) {
          var all = new List<string>(seen.Keys);
          Log("  source account: the named sources carry DIFFERENT " + codeCol + "s (" + string.Join(", ", all.ToArray()) +
              ") - setting none, because one document cannot belong to two accounts");
          return;
        }
        foreach (var kv in seen) { x.AccountCode = kv.Key; x.AccountName = kv.Value; }
        Log("  source account: " + codeCol + "=" + x.AccountCode + " read off " + string.Join(" + ", x.SourceDocNos));
      }
    } catch (Exception ex) {
      /* A diagnostic read must never cost the conversion: with no account the
         transfer behaves exactly as it did before this change. */
      Log("  source account could not be read: " + ex.Message);
    }
  }

  /* ── the transfer itself ──────────────────────────────────────────────────
     Master fields first (the vendor's order), then the diagnostics that used to
     report to nobody, then the call the shape asks for. Worst case is exactly
     what ran yesterday. */
  static void RunTransfer(object doc, Xfer x) {
    SetMaster(doc, x);
    LogTransferApi(doc);
    PreflightTransferFromSupported(doc);
    SubscribeTransferDiagnostics(doc);
    if (!x.Plan.Full) PreflightValidItems(x);

    /* A by-line partial carries no quantity, and every PartialTransfer overload
       demands one. AddPartialTransferDetail is not a workaround for this shape:
       it is the documented call for "these lines, at whatever is outstanding",
       and the only one whose arguments the ERP actually sends. */
    if (!x.Plan.Full && x.Plan.QtyByKey.Count == 0) {
      Log("  transfer: AddPartialTransferDetail per source document - the ERP named lines and no quantity");
      x.Primitive();
      return;
    }

    string why;
    if (TryDocumentedTransfer(doc, x, out why)) return;

    if (x.Plan.QtyByKey.Count > 0)
      /* NOT falling back, on purpose. AddPartialTransferDetail moves each line's
         whole OUTSTANDING quantity, so falling back on a plan that says "3 of 5"
         would ship 5 and answer ok. A refusal is recoverable; a live account
         book holding a quantity nobody authorised is not. */
      throw new Exception("this conversion is a PARTIAL QUANTITY transfer and the documented PartialTransfer call could not be used (" +
        why + "). Refusing rather than falling back, because the fallback moves each line's whole outstanding quantity, " +
        @"which is not what the ERP asked for. The overloads this host's assemblies actually expose, with their parameter names, are in C:\Temp\ac-sync-service.log immediately above this line.");

    Log("  transfer: falling back to AddPartialTransferDetail (" + why + ")");
    x.Primitive();
  }

  /* The debtor/creditor and the document date, BEFORE the transfer.
     Logged either way - a master field that silently fails to apply is how this
     service spent a week transferring into a document with no account. */
  static void SetMaster(object doc, Xfer x) {
    if (x.DocDate.HasValue) {
      try {
        doc.GetType().GetProperty("DocDate", Reach).SetValue(doc, x.DocDate.Value, null);
        Log("  master: DocDate=" + x.DocDate.Value.ToString("yyyy-MM-dd") + " set BEFORE the transfer");
      } catch (Exception ex) { Log("  master: DocDate NOT applied: " + ex.Message); }
    }
    if (string.IsNullOrEmpty(x.AccountCode)) { Log("  master: no account to set - the transfer decides it"); return; }
    var codeProp = x.PurchaseSide ? "CreditorCode" : "DebtorCode";
    var nameProp = x.PurchaseSide ? "CreditorName" : "DebtorName";
    try {
      doc.GetType().GetProperty(codeProp, Reach).SetValue(doc, x.AccountCode, null);
      Log("  master: " + codeProp + "=" + x.AccountCode + " set BEFORE the transfer");
    } catch (Exception ex) { Log("  master: " + codeProp + " NOT applied: " + ex.Message); }
    if (!string.IsNullOrEmpty(x.AccountName)) {
      try { doc.GetType().GetProperty(nameProp, Reach).SetValue(doc, x.AccountName, null); }
      catch (Exception ex) { Log("  master: " + nameProp + " NOT applied: " + ex.Message); }
    }
  }

  /* Public instance members INCLUDING inherited ones. Named, and used
     everywhere below, because leaving it out is the whole bug this file is
     being corrected for. */
  const BindingFlags Reach = BindingFlags.Public | BindingFlags.Instance | BindingFlags.FlattenHierarchy;

  /* ── what the assemblies on THIS host actually expose ─────────────────────
     Printed once per document class per process, with parameter NAMES.

     THIS IS THE PART THAT PAYS FOR ITSELF. The header of this file asserted for
     a week that FullTransfer and PartialTransfer do not exist, on the strength
     of a reflection run taken with BindingFlags.DeclaredOnly - which skips
     inherited members, and every one of them is inherited from SalesDocument /
     PurchaseDocument. A dump nobody can re-take is how that survived seven days
     of work built on top of it. This one re-takes itself on every service
     start, into the log the operator already reads through /last-errors. */
  static readonly Dictionary<string, bool> LoggedApis = new Dictionary<string, bool>();

  static string Sig(System.Reflection.MethodInfo m) {
    var ps = new List<string>();
    foreach (var pi in m.GetParameters()) ps.Add(pi.ParameterType.Name + " " + pi.Name);
    return m.DeclaringType.Name + "." + m.Name + "(" + string.Join(", ", ps.ToArray()) + ")";
  }

  static void LogTransferApi(object doc) {
    try {
      var t = doc.GetType();
      if (LoggedApis.ContainsKey(t.FullName)) return;
      LoggedApis[t.FullName] = true;
      foreach (var want in new string[] { "FullTransfer", "PartialTransfer", "AddPartialTransferDetail" }) {
        var found = 0;
        foreach (var m in t.GetMethods(Reach)) {
          if (m.Name != want) continue;
          found++;
          Log("  SDK " + t.Name + ": " + Sig(m));
        }
        if (found == 0)
          Log("  SDK " + t.Name + ": NO " + want + " (searched with FlattenHierarchy, so inherited members ARE included)");
      }
    } catch (Exception ex) { Log("  SDK api dump failed: " + ex.Message); }
  }

  /* IsTransferFromSupported - the pre-flight this service never made.
     FALSE means the document CLASS will not be built by transfer at all, which
     is a different failure from a source line being rejected, and the two are
     indistinguishable inside "Invalid transfer item." */
  static void PreflightTransferFromSupported(object doc) {
    try {
      var pi = doc.GetType().GetProperty("IsTransferFromSupported", Reach);
      if (pi == null) { Log("  IsTransferFromSupported: not exposed on " + doc.GetType().Name); return; }
      var v = pi.GetValue(doc, null);
      if (v is bool && !((bool) v))
        Log("  IsTransferFromSupported = FALSE on " + doc.GetType().Name +
            " - this document class will not accept a transfer at all, so nothing below is about the source lines");
      else
        Log("  IsTransferFromSupported = " + v);
    } catch (Exception ex) { Log("  IsTransferFromSupported could not be read: " + ex.Message); }
  }

  /* WHICH OF OUR KEYS AUTOCOUNT ITSELF CALLS VALID, asked before a document
     exists. TransferHelper.CheckAndGetValidPartialTransferItem is the vendor's
     own validator and the most likely origin of

       AutoCount.Invoicing.InvalidTransferItemException: Invalid transfer item.

     thrown inside GeneralSalesPartialTransferDetail..ctor. Calling it here moves
     that throw to a point where the keys are still in hand and nothing has been
     written, and the DataTable it returns on success says exactly which keys
     survived - the fact eleven production attempts never produced. */
  static void PreflightValidItems(Xfer x) {
    try {
      var t = x.PurchaseSide
        ? AutoCount.Invoicing.Purchase.TransferHelper.CheckAndGetValidPartialTransferItem(x.FromType, x.DtlKeys, x.S.DBSetting)
        : AutoCount.Invoicing.Sales.TransferHelper.CheckAndGetValidPartialTransferItem(x.FromType, x.DtlKeys, x.S.DBSetting);
      if (t == null) { Log("  valid-transfer-item check: returned NULL for " + x.DtlKeys.Length + " key(s)"); return; }
      var cols = new List<string>();
      foreach (System.Data.DataColumn c in t.Columns) cols.Add(c.ColumnName);
      Log("  valid-transfer-item check: " + t.Rows.Count + " row(s) for " + x.DtlKeys.Length +
          " key(s); columns = " + string.Join(", ", cols.ToArray()));
      if (t.Rows.Count < x.DtlKeys.Length)
        Log("  valid-transfer-item check: AutoCount kept FEWER rows than keys given - the shortfall IS the invalid transfer item(s)");
    } catch (Exception ex) {
      Log("  valid-transfer-item check THREW " + ex.GetType().FullName + ": " + ex.Message.Trim() +
          " - that is the vendor's own validator refusing these keys, before any document was created");
    }
  }

  /* ── the three things the SDK tries to say, and used to say to nobody ─────
     The header of this file argued the over-transfer event cannot be subscribed
     because its EventArgs type is not public. A public args type is not needed:
     .NET's relaxed delegate binding lets a handler declared with `object`
     parameters bind to a delegate whose parameters are any reference types, so
     Delegate.CreateDelegate binds one without ever naming them.

     LOG ONLY. Nothing here answers a confirmation or cancels anything - the
     handler reads the event's arguments back by reflection and writes them to
     the log. Answering "yes" to an over-transfer prompt would silently accept
     shipping more than was ordered, which is the one outcome this service must
     never produce on its own.

     A delegate that RETURNS something is deliberately NOT subscribed: a void
     handler cannot bind to it, and inventing a return value is answering a
     question the SDK asked. Its signature is logged instead. */
  static void SubscribeTransferDiagnostics(object doc) {
    Watch(doc, "OnSalesDocumentTransferConflict");
    Watch(doc, "ConfirmOverTransferedQtyEvent");
    Watch(doc, "ShowEditTransferDetailFormEvent");
  }

  class TransferWatch {
    public string Evt;
    public void On1(object a) { Report(new object[] { a }); }
    public void On2(object a, object b) { Report(new object[] { a, b }); }
    public void On3(object a, object b, object c) { Report(new object[] { a, b, c }); }

    void Report(object[] args) {
      /* An exception thrown out of an event handler unwinds through the SDK's
         own transfer code. Whatever this costs, it must not be the document. */
      try {
        var parts = new List<string>();
        /* args[0] is the sender on every .NET event shape; the interesting half
           is what follows it. A one-argument delegate has no sender to skip. */
        for (int i = args.Length > 1 ? 1 : 0; i < args.Length; i++) parts.Add(Describe(args[i]));
        Log("  SDK EVENT " + Evt + ": " + string.Join(" | ", parts.ToArray()));
      } catch (Exception ex) {
        try { Log("  SDK EVENT " + Evt + " fired but could not be read: " + ex.Message); } catch { }
      }
    }

    static string Describe(object o) {
      if (o == null) return "null";
      var t = o.GetType();
      if (o is string || t.IsPrimitive || o is decimal || o is DateTime) return t.Name + "=" + o;
      var parts = new List<string>();
      foreach (var pi in t.GetProperties(Reach)) {
        if (pi.GetIndexParameters().Length > 0) continue;
        string v;
        try { var raw = pi.GetValue(o, null); v = raw == null ? "null" : raw.ToString(); }
        catch (Exception ex) { v = "(unreadable: " + ex.Message + ")"; }
        if (v.Length > 200) v = v.Substring(0, 200) + "...";
        parts.Add(pi.Name + "=" + v);
      }
      if (parts.Count == 0) return t.FullName + " (no readable properties)";
      return t.Name + " { " + string.Join(", ", parts.ToArray()) + " }";
    }
  }

  static void Watch(object doc, string evtName) {
    try {
      var ev = doc.GetType().GetEvent(evtName, Reach);
      if (ev == null) { Log("  transfer event " + evtName + ": not on " + doc.GetType().Name); return; }
      var invoke = ev.EventHandlerType.GetMethod("Invoke");
      if (invoke == null) { Log("  transfer event " + evtName + ": " + ev.EventHandlerType.Name + " has no Invoke"); return; }
      if (invoke.ReturnType != typeof(void)) {
        Log("  transfer event " + evtName + " NOT subscribed: " + ev.EventHandlerType.Name + " returns " +
            invoke.ReturnType.Name + ", and answering it would be this service deciding");
        return;
      }
      var n = invoke.GetParameters().Length;
      if (n < 1 || n > 3) {
        Log("  transfer event " + evtName + " NOT subscribed: " + n + " argument(s), no reporter of that arity");
        return;
      }
      var watch = new TransferWatch();
      watch.Evt = evtName;
      var handler = Delegate.CreateDelegate(ev.EventHandlerType, watch, "On" + n, false, false);
      if (handler == null) {
        Log("  transfer event " + evtName + " NOT subscribed: " + ev.EventHandlerType.Name +
            " would not bind to an all-object reporter of " + n + " argument(s)");
        return;
      }
      ev.AddEventHandler(doc, handler);
      Log("  transfer event " + evtName + " subscribed (" + ev.EventHandlerType.Name + ", " + n + " arg)");
    } catch (Exception ex) { Log("  transfer event " + evtName + " could not be subscribed: " + ex.Message); }
  }

  /* ── the documented call, bound by the assembly's OWN parameter names ─────
     LATE-BOUND ON PURPOSE, and this is the one decision here that needs
     defending. FullTransfer's third argument is a FullTransferOption and
     PartialTransfer's are three or four unnamed strings and decimals; neither
     the option type's shape nor the argument ORDER can be established from off
     the host, and this file compiles nowhere but the office machine. Writing
     `TransferFrom.SalesOrder` and being wrong costs a failed build and another
     round trip; writing PartialTransfer's decimals in the wrong order and being
     wrong costs a live account book holding a quantity nobody sent.

     So nothing is bound by POSITION. Every argument is matched against the
     parameter's own NAME and TYPE out of the assembly's metadata, and an
     overload with one parameter this service cannot name is not called at all.
     The TransferFrom value is not guessed either: TransferHelper's own
     DocumentTypeToTransferFrom converts the doc-type strings already in hand.

     A bool parameter is deliberately UNFILLABLE. FullTransfer's trailing
     Boolean has no established meaning here, so the three-argument overload is
     the one that binds - presumably why the vendor ships it. */
  static object TransferFromValue(Xfer x) {
    if (x.PurchaseSide) return AutoCount.Invoicing.Purchase.TransferHelper.DocumentTypeToTransferFrom(x.FromType);
    return AutoCount.Invoicing.Sales.TransferHelper.DocumentTypeToTransferFrom(x.FromType);
  }

  static bool TryDocumentedTransfer(object doc, Xfer x, out string why) {
    why = "";
    object transferFrom;
    try {
      transferFrom = TransferFromValue(x);
      Log("  TransferFrom for '" + x.FromType + "' = " + transferFrom + " (" + transferFrom.GetType().FullName + ")");
    } catch (Exception ex) {
      why = "TransferHelper.DocumentTypeToTransferFrom('" + x.FromType + "') threw " + ex.GetType().Name + ": " + ex.Message;
      Log("  " + why);
      return false;
    }

    /* A FULL transfer is ONE call naming every source document. A PARTIAL BY
       QUANTITY is one call PER LINE, because every PartialTransfer overload
       carries a single item and a single quantity. Every call is bound before
       any of them is invoked, so a set this service cannot express is refused
       whole rather than transferred halfway. */
    var lines = new List<long>();
    if (x.Plan.Full) lines.Add(0L); else lines.AddRange(x.Plan.DtlKeys);

    var wanted = x.Plan.Full ? "FullTransfer" : "PartialTransfer";
    var calls = new List<object[]>();
    System.Reflection.MethodInfo chosen = null;
    var rejected = new List<string>();
    /* Reflected ONCE, so "the same overload" below is reference identity on the
       same MethodInfo instances rather than on whatever a second GetMethods
       call happens to hand back. */
    var methods = doc.GetType().GetMethods(Reach);

    foreach (var key in lines) {
      System.Reflection.MethodInfo best = null;
      object[] bestArgs = null;
      foreach (var m in methods) {
        if (m.Name != wanted) continue;
        if (chosen != null && m != chosen) continue;   // every line uses the same overload
        var ps = m.GetParameters();
        var args = new object[ps.Length];
        var ok = true;
        for (int i = 0; i < ps.Length; i++) {
          object v;
          if (!BindTransferArg(ps[i], x, transferFrom, key, out v)) {
            rejected.Add(Sig(m) + " -> cannot fill '" + ps[i].Name + "' (" + ps[i].ParameterType.Name + ")");
            ok = false;
            break;
          }
          args[i] = v;
        }
        if (!ok) continue;
        /* Fewest parameters wins: each extra one is another flag whose meaning
           is not established, and the vendor ships the short overload for
           callers with nothing to say about them. */
        if (best == null || ps.Length < best.GetParameters().Length) { best = m; bestArgs = args; }
      }
      if (best == null) {
        why = "no " + wanted + " overload could be filled without guessing" +
              (rejected.Count == 0 ? " (the class exposes none)" : "; " + string.Join(" ; ", rejected.ToArray()));
        Log("  " + why);
        return false;
      }
      chosen = best;
      calls.Add(bestArgs);
    }

    try {
      Log("  transfer: calling " + Sig(chosen) + " x" + calls.Count);
      foreach (var args in calls) chosen.Invoke(doc, args);
      Log("  transfer: " + chosen.Name + " returned without throwing");
      return true;
    } catch (System.Reflection.TargetInvocationException tie) {
      var inner = tie.InnerException == null ? (Exception) tie : tie.InnerException;
      why = chosen.Name + " threw " + inner.GetType().FullName + ": " + inner.Message.Trim();
      Log("  " + why);
      /* A throw PART WAY THROUGH a per-line loop leaves the in-memory document
         holding some of the lines. The caller must not then run the primitive
         on top of it, which is why a partial-quantity plan refuses instead of
         falling back. */
      return false;
    } catch (Exception ex) {
      why = chosen.Name + " could not be invoked: " + ex.GetType().Name + ": " + ex.Message;
      Log("  " + why);
      return false;
    }
  }

  /* One argument, filled or refused. Type first, because the enum and the
     option type are unmistakable; then the parameter NAME, lower-cased, because
     the vendor's own metadata is the only non-guessed source for what a string
     or a decimal in this position means. Every value comes from the ERP's
     payload or from the SOURCE LINE's own row in the book - never from a
     literal invented here. */
  static bool BindTransferArg(System.Reflection.ParameterInfo pi, Xfer x, object transferFrom, long key, out object value) {
    value = null;
    var t = pi.ParameterType;
    var n = (pi.Name ?? "").ToLowerInvariant();

    if (t.IsInstanceOfType(transferFrom)) { value = transferFrom; return true; }
    if (t == typeof(string[])) {
      if (!x.Plan.Full) return false;
      value = x.Plan.FromDocNos;
      return true;
    }
    if (t == typeof(long[])) return false;   // source DocKeys, which this service does not hold
    if (t == typeof(bool)) return false;     // meaning not established - see the note above

    if (t == typeof(string)) {
      if (n.Contains("docno")) {
        var no = SourceDocNoOf(x, key);
        if (no == null) return false;
        value = no;
        return true;
      }
      /* itemCode / location / uom / batchNo, read off the source line itself. */
      var col = SourceLineColumn(n);
      if (col == null) return false;
      var cell = SourceLineCell(x, key, col);
      if (cell == null) return false;
      value = cell;
      return true;
    }
    if (t == typeof(decimal)) {
      if (n.Contains("qty") && x.Plan.QtyByKey.ContainsKey(key)) { value = x.Plan.QtyByKey[key]; return true; }
      return false;
    }
    if (t == typeof(long)) {
      /* Only a PARTIAL call addresses one line, so `key` means nothing on a
         full transfer and must not be filled in as a zero. */
      if (!x.Plan.Full && n.Contains("dtlkey")) { value = key; return true; }
      return false;
    }

    /* Whatever FullTransferOption turns out to be. An enum or a struct has a
       zero value; anything else is left alone rather than constructed. Both the
       type and, for an enum, every member it carries are logged, so ONE run on
       the host turns this unknown into a recorded fact. */
    if (t.IsEnum) {
      value = Enum.ToObject(t, 0);
      Log("  bind: '" + pi.Name + "' is " + t.FullName + ", using its default " + value +
          "; the members are " + string.Join(", ", Enum.GetNames(t)));
      return true;
    }
    if (t.IsValueType) {
      value = Activator.CreateInstance(t);
      Log("  bind: '" + pi.Name + "' is the value type " + t.FullName + ", using its default value");
      return true;
    }
    return false;
  }

  /* Which source document a named line sits on. KeysBySourceDoc already read it
     out of the book, so this is a lookup and not a second query. */
  static string SourceDocNoOf(Xfer x, long key) {
    if (x.Plan.Full) return x.SourceDocNos.Length == 1 ? x.SourceDocNos[0] : null;
    foreach (var g in x.KeysByDoc) if (g.Value.Contains(key)) return g.Key;
    return null;
  }

  /* A parameter name this service is willing to answer, and the detail column
     that answers it. Anything not on this list is refused rather than filled
     with a plausible value. */
  static string SourceLineColumn(string lowerName) {
    if (lowerName.Contains("itemcode")) return "ItemCode";
    if (lowerName.Contains("location")) return "Location";
    if (lowerName.Contains("uom")) return "UOM";
    if (lowerName.Contains("batch")) return "BatchNo";
    return null;
  }

  /* Cached PER REQUEST, on the Xfer, and deliberately not in a static: this
     service is long-lived, a DtlKey's row can be edited between two calls, and
     a process-wide cache of the account book is a stale answer waiting to
     happen. */
  static string SourceLineCell(Xfer x, long key, string column) {
    try {
      Dictionary<string, object> row;
      if (!x.LineCache.TryGetValue(key, out row)) {
        var dtl = x.FromType + "DTL";
        if (Array.IndexOf(DtlTables, dtl) < 0) return null;
        __DBLINE__
        using (var cn = new System.Data.SqlClient.SqlConnection(db.ConnectionString)) {
          cn.Open();
          var absent = new List<string>();
          var cols = ExistingColumns(cn, dtl, new string[] { "ItemCode", "Location", "UOM", "BatchNo" }, absent);
          if (cols.Count == 0) return null;
          using (var cmd = cn.CreateCommand()) {
            cmd.CommandText = "SELECT " + SelectList(cols) + " FROM [" + dtl + "] WHERE DtlKey = @k";
            var pr = cmd.CreateParameter(); pr.ParameterName = "@k"; pr.Value = key;
            cmd.Parameters.Add(pr);
            using (var rd = cmd.ExecuteReader()) {
              if (!rd.Read()) return null;
              row = RowToDict(rd, cols);
            }
          }
        }
        x.LineCache[key] = row;
      }
      if (!row.ContainsKey(column) || row[column] == null) return null;
      return row[column].ToString();
    } catch (Exception ex) {
      Log("  source line " + key + "." + column + " could not be read: " + ex.Message);
      return null;
    }
  }

  /* WHAT THE BOOK HOLDS for a set of source line keys, as one line of text.
     Only ever reached on a failure path, so its cost does not matter - and its
     OWN failure must never replace the exception it exists to explain, which is
     why the whole body is wrapped and degrades to a sentence.

     The detail columns go through ExistingColumns, the same way /doc-read's do
     and for the same reason: a column this book does not carry must cost that
     FIELD, not the whole explanation, and "no such column" has to read
     differently from "null". That lesson was bought once already, when a wanted
     list built from SDK property names reported SO.Agent as missing because the
     column is called SalesAgent.

     A key that is on no row at all is printed as NOT FOUND rather than left out
     of the list: an absence is the easiest finding to read straight past. */
  static string DescribeSourceKeys(string fromType, long[] keys) {
    try {
      string dtl, hdr;
      switch (fromType) {
        case "SO": dtl = "SODTL"; hdr = "SO"; break;
        case "PO": dtl = "PODTL"; hdr = "PO"; break;
        case "DO": dtl = "DODTL"; hdr = "DO"; break;
        case "GR": dtl = "GRDTL"; hdr = "GR"; break;
        default: return "unsupported source " + fromType;
      }
      if (keys == null || keys.Length == 0) return "(no source line keys were sent)";
      var seen = new Dictionary<long, string>();
      var absent = new List<string>();
      __DBLINE__
      using (var cn = new System.Data.SqlClient.SqlConnection(db.ConnectionString)) {
        cn.Open();
        /* DocNo and Cancelled on the header, Qty and TransferedQty on the line,
           are the four DtlKeys() itself reads, so they are proven to exist on
           every one of these tables by the query that runs in production today.
           ItemCode and Transferable are the two that are only WANTED. */
        var cols = ExistingColumns(cn, dtl,
          new string[] { "DtlKey", "ItemCode", "Qty", "TransferedQty", "Transferable" }, absent);
        if (cols.IndexOf("DtlKey") < 0) return dtl + " has no DtlKey column - nothing can be said about these keys";
        var sel = new List<string>();
        foreach (var c in cols) sel.Add("d.[" + c + "]");
        sel.Add("h.[DocNo]");
        sel.Add("h.[Cancelled]");
        using (var cmd = cn.CreateCommand()) {
          var names = new List<string>();
          for (int i = 0; i < keys.Length; i++) {
            var nm = "@k" + i;
            names.Add(nm);
            var pr = cmd.CreateParameter(); pr.ParameterName = nm; pr.Value = keys[i];
            cmd.Parameters.Add(pr);
          }
          cmd.CommandText =
            "SELECT " + string.Join(", ", sel.ToArray()) +
            " FROM [" + dtl + "] d JOIN [" + hdr + "] h ON h.DocKey = d.DocKey" +
            " WHERE d.DtlKey IN (" + string.Join(", ", names.ToArray()) + ") ORDER BY d.DtlKey";
          using (var rd = cmd.ExecuteReader()) {
            while (rd.Read()) {
              var row = new Dictionary<string, object>();
              for (int i = 0; i < rd.FieldCount; i++) row[rd.GetName(i)] = rd.IsDBNull(i) ? null : rd.GetValue(i);
              var k = System.Convert.ToInt64(row["DtlKey"]);
              seen[k] = k + " on " + hdr + " " + Cell(row, "DocNo") + " [" + Cell(row, "ItemCode") + "]"
                + " Qty=" + Cell(row, "Qty") + " TransferedQty=" + Cell(row, "TransferedQty")
                + " Transferable=" + Cell(row, "Transferable") + " docCancelled=" + Cell(row, "Cancelled")
                + " outstanding=" + Outstanding(row);
            }
          }
        }
      }
      var parts = new List<string>();
      foreach (var k in keys) parts.Add(seen.ContainsKey(k) ? seen[k] : (k + " NOT FOUND in " + dtl));
      var line = string.Join("; ", parts.ToArray());
      if (absent.Count > 0) line += " (columns this book does not have: " + string.Join(", ", absent.ToArray()) + ")";
      return line;
    } catch (Exception ex) {
      return "(the book could not be read for these keys: " + ex.Message + ")";
    }
  }

  /* One field of a row read by NAME, distinguishing the three answers that get
     confused with each other: no such column, a null, and a value. */
  static string Cell(Dictionary<string, object> row, string name) {
    if (!row.ContainsKey(name)) return "(no " + name + " column)";
    var v = row[name];
    return (v == null || v == DBNull.Value) ? "NULL" : System.Convert.ToString(v);
  }

  /* AutoCount's own outstanding quantity, spelled the way its predicate spells
     it. A NULL Qty is called out in words because it is the failure that reads
     as nothing: Qty - ISNULL(TransferedQty,0) > 0 is NULL, never true, so the
     line is invisible to every outstanding query while looking correct in every
     list. A purchase line did exactly that on 2026-08-16. */
  static string Outstanding(Dictionary<string, object> row) {
    if (!row.ContainsKey("Qty")) return "(no Qty column)";
    var qty = row["Qty"];
    if (qty == null || qty == DBNull.Value)
      return "NULL - a NULL Qty is never outstanding, so this line can never be transferred";
    var done = row.ContainsKey("TransferedQty") ? row["TransferedQty"] : null;
    var q = System.Convert.ToDecimal(qty);
    var t = (done == null || done == DBNull.Value) ? 0m : System.Convert.ToDecimal(done);
    return (q - t).ToString();
  }

  /* OVER-TRANSFER: now REPORTED, having been declared unreachable.
     This block used to argue that ConfirmOverTransferedQtyEvent "cannot be
     subscribed from outside the SDK" because reflection found the delegate and
     no matching public EventArgs type, and that the condition was instead made
     impossible by only ever transferring what is outstanding. The first half is
     wrong: a delegate does not need a public argument type to be bound.
     Delegate.CreateDelegate matches a handler declared with `object` parameters
     to a delegate whose parameters are any reference types (relaxed delegate
     binding, .NET 2.0 onwards), which is what Watch() above does - it never
     names the args type, so nothing has to compile against it.

     The second half stopped being true the day the ERP started naming DtlKeys:
     DtlKeys() returns a supplied list VERBATIM, so the
     (Qty - TransferedQty) > 0 predicate is never evaluated for those lines and
     the over-transfer condition is reachable from a payload.

     What happens now: the event is subscribed, its arguments are read back by
     reflection and written to the log, and NOTHING is answered. A handler that
     confirmed the prompt would silently accept shipping more than was ordered.
     If AutoCount refuses instead, the refusal is returned as an error, which is
     the outcome this service wants. */

  /* SO -> PO, which is NOT one of the four above and cannot use Convert_.
     AddPartialTransferDetail("SO", keys, ...) is the sales-side primitive; a
     purchase document transferring FROM a sales order has its own method, one
     key at a time:
         AddSOToPOTransferDetail(Int64)      (sdk-api-reference.txt, the
                                              PurchaseOrder METH list)
     The ERP only sends this when every purchase line maps 1:1 to a sales line
     the book already has a key for. A consolidated purchase -- one line serving
     several customers plus stock, which is a shape Houzs buys in deliberately
     (mig 0235) -- is sent as a plain /create-po instead, because a transfer
     would split it or drop the stock quantity. That decision is made ERP-side
     in scm/shared/po-transfer-shape.ts; this route only executes it.

     DtlKeys is REQUIRED here, unlike the four conversions. Those may omit it
     and fall through to "every still-outstanding line on the parent", which is
     a safe default when the two documents are the same document one step on.
     A purchase order is not: the ERP decides what it buys, and guessing would
     transfer sales lines nobody ordered from this supplier. */
  static string SoToPo(Dictionary<string, object> p) {
    var s = Session();
    var fromDocNo = Str(p, "FromDocNo");
    if (string.IsNullOrEmpty(fromDocNo)) throw new Exception("FromDocNo required");
    var keys = LongList(p, "DtlKeys");
    if (keys.Length == 0) throw new Exception("DtlKeys required for /so-to-po - the ERP decides which sales lines this purchase order buys");

    /* THE CREDITOR IS NOT OPTIONAL, and leaving it out does not fail where you
       would look for it. Measured on the live book 2026-08-15:

         ERROR /so-to-po: AutoCount.Data.ForeignKeyException:
           Foreign Key Error (Constraint Name=FK_PO_DisplayTerm)

       DisplayTerm is the PAYMENT TERM, and AutoCount defaults it FROM THE
       CREDITOR. This route sent the lines across with AddSOToPOTransferDetail
       and then called PurchaseHeader, which writes DocDate/DocNo/Ref/
       Description/UDF and NOT the creditor - so the purchase order reached
       Save() with no supplier, therefore no term, and the insert died on the
       term's foreign key rather than on anything mentioning a creditor.

       That is why /create-po passed the same night while /so-to-po did not:
       CreatePo assigns CreditorCode directly. The payload had always carried
       one; this route simply dropped it. */
    var creditor = Str(p, "CreditorCode");
    if (string.IsNullOrEmpty(creditor))
      throw new Exception("CreditorCode required for /so-to-po - AutoCount defaults the payment term from the supplier, and without one the save dies on FK_PO_DisplayTerm, which names the term and not the supplier");

    /* EVERY LINE NEEDS A QUANTITY, and it must be checked BEFORE anything is
       written. Measured on the live book 2026-08-16, reading the PO back the
       moment it was created:

         PO line 906183: Qty=  TransferedQty=0  Transferable=T

       Qty is NULL. AddSOToPOTransferDetail does NOT carry the sales line's
       quantity across. AutoCount's outstanding predicate is
       Qty - ISNULL(TransferedQty, 0) > 0, which is NULL and never true for such
       a line, so the purchase order saves, looks right in every list, and can
       never be converted: /po-to-gr answers "no transferable lines on PO" and
       the failure surfaces a step later on a different document than the one at
       fault.

       Checked against the PAYLOAD rather than the saved document on purpose -
       this refuses before a single row is written, and PurchaseOrder exposes no
       Details collection to walk afterwards anyway. */
    var qtyByKey = new Dictionary<long, decimal>();
    foreach (var od in List(p, "Details")) {
      var itq = od as Dictionary<string, object>;
      if (itq == null || !itq.ContainsKey("DtlKey")) continue;
      if (itq.ContainsKey("Qty")) qtyByKey[System.Convert.ToInt64(itq["DtlKey"])] = Dec(itq, "Qty", 0);
    }
    foreach (var k in keys) {
      decimal q;
      if (!qtyByKey.TryGetValue(k, out q) || q <= 0)
        throw new Exception("/so-to-po needs a positive Qty in Details for source DtlKey " + k +
          " - AddSOToPOTransferDetail does not carry the sales quantity across, and a purchase order whose line has no quantity saves but can never be converted");
    }

    var cmd = AutoCount.Invoicing.Purchase.PurchaseOrder.PurchaseOrderCommand.Create(s, s.DBSetting);
    var po = cmd.AddNew();
    po.CreditorCode = creditor;
    Set(() => po.CreditorName = Str(p, "CreditorName"));
    /* PHASE ONE: transfer, then SAVE. Nothing else.

       AddSOToPOTransferDetail does NOT return a purchase line - it returns an
       AutoCount.Invoicing.Purchase.TransferSOToPODetail, a transfer INSTRUCTION
       with a different shape and no Qty at all. Every earlier attempt to set the
       cost and quantity on it went through Set(), which logs and swallows, so
       the type mismatch was invisible and the purchase order saved with a NULL
       Qty. Proven on the live book, from the service's own log:

         set skipped: 'AutoCount.Invoicing.Purchase.TransferSOToPODetail'
                      does not contain a definition for 'Qty'

       A NULL Qty is fatal in a way that reads as nothing: AutoCount's
       outstanding predicate is Qty - ISNULL(TransferedQty, 0) > 0, which is NULL
       and never true, so the document looks correct in every list and can never
       be converted onward.

       So the overrides are applied in a SECOND pass, after Save, when the
       purchase lines finally exist and have keys of their own that EditDetail
       can address. This does not depend on what TransferSOToPODetail exposes,
       which is deliberate: that type is not in sdk-api-reference.txt and is not
       being guessed at. */
    /* THE TYPED PRIMITIVE FIRST, because the untyped one leaves no type behind.
       Measured on the live book 2026-08-16: every PODTL row this route has ever
       written carries FromDocNo but FromDocType NULL, while every DODTL row from
       Convert_ carries both. The reason is in the two signatures —

           AddPartialTransferDetail(String fromDocType, Int64[] keys, Boolean)
           AddSOToPOTransferDetail(Int64)

       — the first is TOLD the type and records it; the second has nowhere to
       take one from. AutoCount's own transfer relationship reads that column, so
       a PO written by the second is linked on one side only.

       transferMaster is FALSE here, unlike the purchase-side conversions. That
       flag copies the SOURCE document's master, and this source is a SALES
       order: true would put a debtor onto a purchase document. PurchaseHeader
       below sets the creditor explicitly, which is what /po-to-gr needed
       transferMaster for and this route does not.

       FALLING BACK IS THE POINT. AddPartialTransferDetail with a sales type on a
       purchase document is not in sdk-api-reference.txt as a supported pairing,
       and this file cannot be compiled or run anywhere but the office host. If
       it throws, the old call runs and the document is written exactly as it is
       written today — one-sided link and all. The worst case is what we already
       have; the best case is the link AutoCount actually reads. */
    /* THE SAME DIAGNOSTICS THE FOUR CONVERSIONS NOW GET. This route shares
       their failure mode - it transfers sales lines into a purchase document
       through the same SDK machinery - and it had the same blind spots: no
       record of which overloads the host actually exposes, no pre-flight, and
       three transfer events reporting to nobody. The creditor is already set
       above, which is the vendor's order and the one thing this route had
       right when Convert_ did not.

       WHICH SHAPE IS NOT DECIDED HERE, and that is deliberate: the ERP decides
       whether a purchase order is a transfer at all, in
       scm/shared/po-transfer-shape.ts, and it decides the quantity in
       Details[].Qty, which phase two below applies line by line. A consolidated
       purchase never reaches this route. */
    LogTransferApi(po);
    PreflightTransferFromSupported(po);
    SubscribeTransferDiagnostics(po);
    /* The SO-SPECIFIC validator, not the general one Convert_ uses. SO -> PO is
       a sales source on a purchase target, and the purchase TransferHelper
       ships a method for exactly that pairing -
       CheckAndGetValidSOTransferItem(Int64, DBSetting) - so a refusal here is
       about the sales line and not about a doc-type the general validator was
       never meant to be handed. */
    foreach (var k in keys) {
      try {
        var row = AutoCount.Invoicing.Purchase.TransferHelper.CheckAndGetValidSOTransferItem(k, s.DBSetting);
        Log("  valid-SO-transfer-item " + k + ": " + (row == null ? "NULL - AutoCount will not take this sales line" : "ok"));
      } catch (Exception ex) {
        Log("  valid-SO-transfer-item " + k + " THREW " + ex.GetType().FullName + ": " + ex.Message.Trim());
      }
    }

    var typedTransfer = false;
    try {
      po.AddPartialTransferDetail("SO", keys, false);
      typedTransfer = true;
    } catch (Exception ex) {
      Log("so-to-po: typed AddPartialTransferDetail(\"SO\") refused (" + ex.Message
        + ") - falling back to AddSOToPOTransferDetail, which leaves FromDocType null");
    }
    if (!typedTransfer) foreach (var k in keys) po.AddSOToPOTransferDetail(k);
    PurchaseHeader(po, p);
    po.Save();
    var docNo = po.DocNo;

    /* PHASE TWO: reopen and apply what the ERP agreed with the supplier.

       The transfer brings the SALES price across, and a purchase order owes the
       COST. Lines are matched by ORDER: AddSOToPOTransferDetail was called once
       per key, in the order of DtlKeys, so the Nth purchase line answers to the
       Nth source key. CreatedLines reads them back in DtlKey order, which is
       creation order. */
    var made = CreatedLines("PODTL", docNo);
    if (made.Count != keys.Length)
      throw new Exception("SO-to-PO transferred " + keys.Length + " line(s) but the saved purchase order has " +
        made.Count + " - refusing to guess which override belongs to which line");

    var newKeyBySourceKey = new Dictionary<long, long>();
    for (int i = 0; i < keys.Length; i++)
      newKeyBySourceKey[keys[i]] = System.Convert.ToInt64(made[i]["DtlKey"]);

    var po2 = AutoCount.Invoicing.Purchase.PurchaseOrder.PurchaseOrderCommand.Create(s, s.DBSetting).Edit(docNo);
    if (po2 == null) throw new Exception("SO-to-PO saved " + docNo + " but it could not be reopened to apply the costs");

    var applied = 0;
    foreach (var od in List(p, "Details")) {
      var it = (Dictionary<string, object>) od;
      if (!it.ContainsKey("DtlKey")) continue;
      var srcKey = System.Convert.ToInt64(it["DtlKey"]);
      long newKey;
      if (!newKeyBySourceKey.TryGetValue(srcKey, out newKey))
        throw new Exception("/so-to-po was given an override for DtlKey " + srcKey + ", which is not one of the source lines it transferred");
      var d = po2.EditDetail(newKey);
      if (d == null) throw new Exception("purchase line " + newKey + " could not be opened to apply its cost");

      /* NOT Set(). Set() swallows, and swallowing is what let a NULL Qty reach
         the book in the first place. A cost or quantity that fails to apply must
         fail the request. */
      if (it.ContainsKey("UnitPrice")) d.UnitPrice = Dec(it, "UnitPrice", 0);
      if (it.ContainsKey("Qty"))       d.Qty = Dec(it, "Qty", 1);
      if (it.ContainsKey("Location"))  Set(() => d.Location = Str(it, "Location"));
      if (it.ContainsKey("DeliveryDate")) { var dd = Date(it, "DeliveryDate"); Set(() => d.DeliveryDate = dd); }
      applied++;
    }
    if (applied > 0) po2.Save();
    Log("  so-to-po " + docNo + ": " + keys.Length + " transferred, " + applied + " line(s) costed in phase two");
    return docNo;
  }

  /* THE ERP'S AMOUNT IS THE AMOUNT, INCLUDING ZERO. Owner 2026-08-16: "我填写
     多少就多少，我填写 0 就 0". AutoCount disagrees by default - every document
     class carries EnableZeroNetTotalChecking, and with it on a document whose
     net total is zero is refused on Save. That check exists for humans typing
     into the entry screen; here the number came from the ERP deliberately, and
     a zero-value purchase order is a real thing (free replacement, warranty
     supply, a line priced later).

     Turned off through Set(): a class that does not expose it must cost the
     flag, never the document. */
  static void AllowZeroValue(dynamic doc) {
    Set(() => doc.EnableZeroNetTotalChecking = false);
  }

  static void SalesHeader(dynamic doc, Dictionary<string, object> p) {
    AllowZeroValue(doc);
    var dt = Date(p, "DocDate"); if (dt.HasValue) Set(() => doc.DocDate = dt.Value);
    if (p.ContainsKey("DocNo") && !string.IsNullOrEmpty(Str(p, "DocNo"))) Set(() => doc.DocNo = Str(p, "DocNo"));
    Set(() => doc.Ref = Str(p, "Ref"));
    Set(() => doc.Description = Str(p, "Description"));
    /* DisplayTerm is the payment term. It is normally defaulted from the
       debtor/creditor, so it is sent only when the ERP has one to say - the
       ContainsKey rule, because a blank here is a foreign key error, not an
       empty field (FK_PO_DisplayTerm, live book 2026-08-15). */
    if (p.ContainsKey("DisplayTerm")) Set(() => doc.DisplayTerm = Str(p, "DisplayTerm"));
    ApplyUdf(p, k => doc.UDF[k], (k, v) => doc.UDF[k] = v);
  }

  static void PurchaseHeader(dynamic doc, Dictionary<string, object> p) {
    AllowZeroValue(doc);
    /* The purchase-side twin of SalesLocation, and it has never been sent.
       FK_SO_SalesLocation proved the sales header needs its location; nothing
       had tested whether the purchase header does. /create-po saves without it,
       so it is not a hard foreign key - but the GRN's partial-transfer
       constructor dies on "there is no row at position -1", which is a master
       lookup returning -1 and being used as an index, and an empty
       PurchaseLocation is a candidate for that lookup. Sent when the ERP has
       one; a blank would be its own foreign key error. */
    if (p.ContainsKey("PurchaseLocation") && !string.IsNullOrEmpty(Str(p, "PurchaseLocation")))
      Set(() => doc.PurchaseLocation = Str(p, "PurchaseLocation"));
    var dt = Date(p, "DocDate"); if (dt.HasValue) Set(() => doc.DocDate = dt.Value);
    if (p.ContainsKey("DocNo") && !string.IsNullOrEmpty(Str(p, "DocNo"))) Set(() => doc.DocNo = Str(p, "DocNo"));
    Set(() => doc.Ref = Str(p, "Ref"));
    Set(() => doc.Description = Str(p, "Description"));
    /* DisplayTerm is the payment term. It is normally defaulted from the
       debtor/creditor, so it is sent only when the ERP has one to say - the
       ContainsKey rule, because a blank here is a foreign key error, not an
       empty field (FK_PO_DisplayTerm, live book 2026-08-15). */
    if (p.ContainsKey("DisplayTerm")) Set(() => doc.DisplayTerm = Str(p, "DisplayTerm"));
    ApplyUdf(p, k => doc.UDF[k], (k, v) => doc.UDF[k] = v);
  }

  /* Source line keys: either the caller names them (partial delivery — the ERP
     decides which lines ship) or we take every outstanding line on the source
     document. Read straight from the book's own detail table so the set always
     matches what AutoCount considers untransferred. */
  /* The payload's DtlKeys, and NOTHING ELSE. DtlKeys() below falls back to
     "every outstanding line on the parent" when the list is empty; /so-to-po
     must not, so it reads the list through this instead. */
  static long[] LongList(Dictionary<string, object> p, string key) {
    var outp = new List<long>();
    foreach (var k in List(p, key)) if (k != null) outp.Add(System.Convert.ToInt64(k));
    return outp.ToArray();
  }

  /* Which source document each line key belongs to. Read from the book: a
     caller naming keys from two documents is legitimate, but AutoCount needs
     them handed over one document at a time, and only the book knows which is
     which. */
  static Dictionary<string, List<long>> KeysBySourceDoc(string fromType, long[] keys) {
    string dtl, hdr;
    switch (fromType) {
      case "SO": dtl = "SODTL"; hdr = "SO"; break;
      case "PO": dtl = "PODTL"; hdr = "PO"; break;
      case "DO": dtl = "DODTL"; hdr = "DO"; break;
      case "GR": dtl = "GRDTL"; hdr = "GR"; break;
      default: throw new Exception("unsupported source " + fromType);
    }
    var outp = new Dictionary<string, List<long>>();
    __DBLINE__
    using (var cn = new System.Data.SqlClient.SqlConnection(db.ConnectionString)) {
      cn.Open();
      using (var cmd = cn.CreateCommand()) {
        var names = new List<string>();
        for (int i = 0; i < keys.Length; i++) {
          var nm = "@k" + i;
          names.Add(nm);
          var pr = cmd.CreateParameter(); pr.ParameterName = nm; pr.Value = keys[i];
          cmd.Parameters.Add(pr);
        }
        cmd.CommandText =
          "SELECT h.DocNo, d.DtlKey FROM " + dtl + " d JOIN " + hdr + " h ON h.DocKey = d.DocKey " +
          "WHERE d.DtlKey IN (" + string.Join(", ", names.ToArray()) + ") ORDER BY d.DtlKey";
        using (var rd = cmd.ExecuteReader()) {
          while (rd.Read()) {
            var no = rd.GetString(0);
            if (!outp.ContainsKey(no)) outp[no] = new List<long>();
            outp[no].Add(rd.GetInt64(1));
          }
        }
      }
    }
    var found = 0;
    foreach (var kv in outp) found += kv.Value.Count;
    if (found != keys.Length)
      throw new Exception("of " + keys.Length + " line key(s) given, only " + found + " exist on a " + fromType +
        " - refusing to transfer a set the book does not recognise");
    return outp;
  }

  static long[] DtlKeys(Dictionary<string, object> p, string fromType, string fromDocNo) {
    var given = List(p, "DtlKeys");
    var outp = new List<long>();
    foreach (var k in given) if (k != null) outp.Add(System.Convert.ToInt64(k));
    if (outp.Count > 0) return outp.ToArray();

    string dtl, hdr;
    switch (fromType) {
      case "SO": dtl = "SODTL"; hdr = "SO"; break;
      case "PO": dtl = "PODTL"; hdr = "PO"; break;
      case "DO": dtl = "DODTL"; hdr = "DO"; break;
      case "GR": dtl = "GRDTL"; hdr = "GR"; break;
      default: throw new Exception("unsupported source " + fromType);
    }
    __DBLINE__
    var cs = db.ConnectionString;
    using (var cn = new System.Data.SqlClient.SqlConnection(cs)) {
      cn.Open();
      using (var cmd = cn.CreateCommand()) {
        cmd.CommandText =
          "SELECT d.DtlKey FROM " + dtl + " d JOIN " + hdr + " h ON h.DocKey = d.DocKey " +
          "WHERE h.DocNo = @no AND h.Cancelled = 'F' AND (d.Qty - ISNULL(d.TransferedQty,0)) > 0 " +
          "ORDER BY d.DtlKey";
        var pr = cmd.CreateParameter(); pr.ParameterName = "@no"; pr.Value = fromDocNo;
        cmd.Parameters.Add(pr);
        using (var rd = cmd.ExecuteReader()) while (rd.Read()) outp.Add(rd.GetInt64(0));
      }
    }
    return outp.ToArray();
  }

  // ── cancel ────────────────────────────────────────────────────────────────
  static void Cancel(Dictionary<string, object> p) {
    var s = Session();
    var type = Str(p, "DocType").ToUpper();
    var docNo = Str(p, "DocNo");
    if (string.IsNullOrEmpty(docNo)) throw new Exception("DocNo required");
    bool ok;
    switch (type) {
      case "SO": ok = AutoCount.Invoicing.Sales.SalesOrder.SalesOrderCommand.Create(s, s.DBSetting).CancelDocument(docNo, USER); break;
      case "DO": ok = AutoCount.Invoicing.Sales.DeliveryOrder.DeliveryOrderCommand.Create(s, s.DBSetting).CancelDocument(docNo, USER); break;
      case "IV": ok = AutoCount.Invoicing.Sales.Invoice.InvoiceCommand.Create(s, s.DBSetting).CancelDocument(docNo, USER); break;
      case "PO": ok = AutoCount.Invoicing.Purchase.PurchaseOrder.PurchaseOrderCommand.Create(s, s.DBSetting).CancelDocument(docNo, USER); break;
      case "GR": ok = AutoCount.Invoicing.Purchase.GoodsReceivedNote.GoodsReceivedNoteCommand.Create(s, s.DBSetting).CancelDocument(docNo, USER); break;
      case "PI": ok = AutoCount.Invoicing.Purchase.PurchaseInvoice.PurchaseInvoiceCommand.Create(s, s.DBSetting).CancelDocument(docNo, USER); break;
      default: throw new Exception("unsupported DocType " + type);
    }
    if (!ok) throw new Exception("AutoCount refused to cancel " + type + " " + docNo +
      " (already transferred to a downstream document, or already cancelled)");
  }

  /* ── masters ────────────────────────────────────────────────────────────────
     A document naming a master AutoCount does not have does not fail politely:
     it fails on a FOREIGN KEY, and the whole document is lost. That is not a
     theory — the live book answered FK_SODTL_Location to a create whose lines
     carried no stock location, and the same shape is waiting behind every new
     SKU, every new salesperson and every new customer the ERP opens.

     So the ERP declares the masters a document needs and this route makes them
     exist FIRST. It is idempotent by construction: each one is looked up and
     only created when the lookup comes back empty, so the ERP may declare the
     same set on every push without inventing anything.

     WHAT IT DELIBERATELY WILL NOT DO:
     - It never EDITS a master that already exists. An item's costing method or
       a debtor's credit limit is Finance's, not the sync's, and overwriting one
       from an ERP field would be a silent business change. Existing masters are
       reported as `existed` and left exactly as they are.
     - It never creates a UDF LIST. An unknown list NAME is a spelling mistake
       on our side, not a missing option, and inventing the list would hide it.
       An OPTION on a list that exists is appended (read-modify-write, below).
     - Everything it creates is stamped in Desc2/Description so Finance can find
       them: an auto-opened master is a thing to review, not a thing to hide.

     WHAT IT DOES DO, AND THIS COMMENT USED TO DENY IT: it CREATES A LOCATION.
     The Locations loop below calls lm.SaveLocation(e) and logs
     "ensure-masters CREATED location". The bullet that stood here said the
     opposite — "It never creates a LOCATION ... refused on the ERP side
     instead (MissingLocationError)" — and was already false when it was
     written: the code is newer than the comment, MissingLocationError refuses
     only a line with NO location at all, and a warehouse code the book has
     never held is passed through raw and opened. Corrected 2026-08-14 (audit
     finding 12); the owner's decision on 2026-08-11 was "开everything", and the
     module guide records it, so the CODE was right and this text was the lie.
     The consequence is real and stays visible rather than being hidden here:
     19 of 25 scm.warehouses codes are in neither LOCATION_MAP nor the book's
     location list (measured 2026-08-14), so the first document naming one opens
     a new stock location in a licensed book. A location is created EMPTY — a
     code and a description — so everything a warehouse really needs stays for a
     human. */
  static Dictionary<string, object> EnsureMasters(Dictionary<string, object> p) {
    var s = Session();
    var created = new List<string>();
    var existed = new List<string>();
    var failed = new List<Dictionary<string, object>>();

    foreach (var o in List(p, "Items")) {
      var it = o as Dictionary<string, object>;
      if (it == null) continue;
      var code = Str(it, "ItemCode");
      if (code.Length == 0) continue;
      try {
        var da = AutoCount.Stock.Item.ItemDataAccess.Create(s, s.DBSetting);
        if (ItemExists(da, code)) { existed.Add("item:" + code); continue; }
        var e = da.NewItem();
        e.ItemCode = code;
        e.Description = Or(Str(it, "Description"), code);
        Set(() => e.Desc2 = Str(it, "Desc2"));
        /* ItemGroup is a FOREIGN KEY (FK_Item_ItemGroup), not a label. An item
           opened without one is refused by the live book, which is what a new
           SKU coming from the ERP hits on its very first document. OTHER exists
           in AED_HOUZS for exactly this - a group that classifies nothing and
           blocks nothing. Proved 2026-08-12: the same call fails with
           FK_Item_ItemGroup and then succeeds with the group supplied. */
        Set(() => e.ItemGroup = Or(Str(it, "ItemGroup"), "OTHER"));
        Set(() => e.StockControl = true);
        Set(() => e.IsSalesItem = true);
        Set(() => e.IsPurchaseItem = true);
        /* An item with no UOM cannot be put on a document line: the detail's
           own UOM foreign-keys to ItemUOM. One base UOM at rate 1. */
        var uom = Or(Str(it, "UOM"), "UNIT");
        Set(() => e.NewUom(uom, 1m));
        Set(() => e.BaseUom = uom);
        da.SaveData(e, USER);
        created.Add("item:" + code);
        Log("  ensure-masters CREATED item " + code);
      } catch (Exception ex) {
        failed.Add(new Dictionary<string, object> { { "master", "item:" + code }, { "error", ex.Message } });
      }
    }

    foreach (var o in List(p, "Agents")) {
      var it = o as Dictionary<string, object>;
      if (it == null) continue;
      var code = Str(it, "Agent");
      if (code.Length == 0) continue;
      try {
        var cmd = AutoCount.GeneralMaint.SalesAgent.SalesAgentCommand.Create(s, s.DBSetting);
        if (AgentExists(cmd, code)) { existed.Add("agent:" + code); continue; }
        var e = cmd.NewSalesAgent();
        e.SalesAgent = code;
        Set(() => e.Description = Or(Str(it, "Description"), code));
        cmd.SaveSalesAgent(e);
        created.Add("agent:" + code);
        Log("  ensure-masters CREATED agent " + code);
      } catch (Exception ex) {
        failed.Add(new Dictionary<string, object> { { "master", "agent:" + code }, { "error", ex.Message } });
      }
    }

    /* A PURCHASE agent is a DIFFERENT master from a sales agent - a different
       table (dbo.PurchaseAgent) behind a different foreign key
       (FK_PO_PurchaseAgent) reached through a different command. Opening
       'OTHERS' as a sales agent does nothing for a purchase order that names
       it, and the PO is refused with the whole document. Found 2026-08-12 by
       /create-po failing on the live book after /ensure-masters had reported
       agent:OTHERS as already existing - the third foreign key in this chain,
       after FK_SO_SalesAgent and FK_SO_SalesLocation, each one only visible
       once the previous was satisfied. */
    foreach (var o in List(p, "PurchaseAgents")) {
      var it = o as Dictionary<string, object>;
      if (it == null) continue;
      var code = Or(Str(it, "PurchaseAgent"), Str(it, "Agent"));
      if (code.Length == 0) continue;
      try {
        var cmd = AutoCount.GeneralMaint.PurchaseAgent.PurchaseAgentCommand.Create(s, s.DBSetting);
        if (PurchaseAgentExists(cmd, code)) { existed.Add("purchase-agent:" + code); continue; }
        var e = cmd.NewPurchaseAgent();
        e.PurchaseAgent = code;
        Set(() => e.Description = Or(Str(it, "Description"), code));
        Set(() => e.IsActive = true);
        cmd.SavePurchaseAgent(e);
        created.Add("purchase-agent:" + code);
        Log("  ensure-masters CREATED purchase agent " + code);
      } catch (Exception ex) {
        failed.Add(new Dictionary<string, object> { { "master", "purchase-agent:" + code }, { "error", ex.Message } });
      }
    }

    foreach (var o in List(p, "Debtors")) {
      var it = o as Dictionary<string, object>;
      if (it == null) continue;
      var acc = Str(it, "AccNo");
      if (acc.Length == 0) continue;
      try {
        var da = AutoCount.ARAP.Debtor.DebtorDataAccess.Create(s, s.DBSetting);
        if (DebtorExists(da, acc)) { existed.Add("debtor:" + acc); continue; }
        var e = da.NewDebtor();
        e.AccNo = acc;
        Set(() => e.CompanyName = Or(Str(it, "CompanyName"), acc));
        Set(() => e.ControlAccount = Str(it, "ControlAccount"));
        da.SaveDebtor(e, USER);
        created.Add("debtor:" + acc);
        Log("  ensure-masters CREATED debtor " + acc);
      } catch (Exception ex) {
        failed.Add(new Dictionary<string, object> { { "master", "debtor:" + acc }, { "error", ex.Message } });
      }
    }

    /* A PURCHASE ORDER NAMES A CREDITOR, and CreditorCode is applied
       unconditionally by CreatePo - so a supplier the account book does not
       have fails the same foreign key a missing item does, and takes the whole
       PO with it. Same shape as the Location that FK'd on the live book; the
       only reason it was not found the same way is that no PO has been pushed
       yet. */
    foreach (var o in List(p, "Creditors")) {
      var it = o as Dictionary<string, object>;
      if (it == null) continue;
      var acc = Str(it, "AccNo");
      if (acc.Length == 0) continue;
      try {
        var da = AutoCount.ARAP.Creditor.CreditorDataAccess.Create(s, s.DBSetting);
        if (CreditorExists(da, acc)) { existed.Add("creditor:" + acc); continue; }
        var e = da.NewCreditor();
        e.AccNo = acc;
        Set(() => e.CompanyName = Or(Str(it, "CompanyName"), acc));
        Set(() => e.ControlAccount = Str(it, "ControlAccount"));
        da.SaveCreditor(e, USER);
        created.Add("creditor:" + acc);
        Log("  ensure-masters CREATED creditor " + acc);
      } catch (Exception ex) {
        failed.Add(new Dictionary<string, object> { { "master", "creditor:" + acc }, { "error", ex.Message } });
      }
    }

    /* A STOCK LOCATION. The live book answered FK_SODTL_Location to a line
       whose Location was empty, so a warehouse the book does not have fails the
       document the same way a missing item does. Opening one has real
       consequences - it is a place stock can sit - so it is created EMPTY:
       a code and a description, nothing else. Everything a warehouse actually
       needs (addresses, payment accounts, defaults) stays for a human. */
    foreach (var o in List(p, "Locations")) {
      var it = o as Dictionary<string, object>;
      if (it == null) continue;
      var code = Str(it, "Location");
      if (code.Length == 0) continue;
      try {
        var lm = AutoCount.Stock.Location.LocationMaintenance.CreateLocationMaint(s, s.DBSetting);
        if (LocationExists(lm, code)) { existed.Add("location:" + code); continue; }
        var e = lm.NewLocation();
        e.Location = code;
        Set(() => e.Description = Or(Str(it, "Description"), code));
        lm.SaveLocation(e);
        created.Add("location:" + code);
        Log("  ensure-masters CREATED location " + code);
      } catch (Exception ex) {
        failed.Add(new Dictionary<string, object> { { "master", "location:" + code }, { "error", ex.Message } });
      }
    }

    /* A UDF DROPDOWN OPTION (BRANDING, VENUE).
       READ, APPEND, WRITE BACK THE WHOLE SET - never Add() with just the new
       one. AutoCount.UDF.List exposes GetItems() and SetItems(), so the current
       options can be read first and the new value appended to them. Calling
       Add(name, new[]{ value }) and hoping it appends would, if it replaces,
       delete every other option in a live book - roughly 95 of them on VENUE.
       The read-modify-write shape makes that impossible rather than unlikely.

       A list that does not exist at all is NOT created: an unknown list NAME is
       a spelling mistake on our side, not a missing option, and inventing one
       would hide it. */
    var udfWanted = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
    foreach (var o in List(p, "UdfOptions")) {
      var it = o as Dictionary<string, object>;
      if (it == null) continue;
      var listName = Str(it, "List");
      var val = Str(it, "Value");
      if (listName.Length == 0 || val.Length == 0) continue;
      if (!udfWanted.ContainsKey(listName)) udfWanted[listName] = new List<string>();
      if (!udfWanted[listName].Contains(val)) udfWanted[listName].Add(val);
    }
    if (udfWanted.Count > 0) {
      try {
        var udfl = new AutoCount.UDF.UDFList(s.DBSetting);
        var names = new List<string>(udfl.GetNames());
        var dirty = false;
        foreach (var kv in udfWanted) {
          var listName = names.Find(n => string.Equals(n, kv.Key, StringComparison.OrdinalIgnoreCase));
          if (listName == null) {
            failed.Add(new Dictionary<string, object> {
              { "master", "udf-list:" + kv.Key },
              { "error", "no such user-defined list in this book - check the name, do not invent the list" },
            });
            continue;
          }
          var list = udfl[listName];
          var items = new List<string>(list.GetItems() ?? new string[0]);
          foreach (var v in kv.Value) {
            if (items.Exists(x => string.Equals(x, v, StringComparison.OrdinalIgnoreCase))) {
              existed.Add("udf:" + listName + "=" + v);
              continue;
            }
            items.Add(v);
            created.Add("udf:" + listName + "=" + v);
            dirty = true;
            Log("  ensure-masters ADDED udf option " + listName + " = " + v);
          }
          list.SetItems(items.ToArray());
        }
        if (dirty) udfl.Save();
      } catch (Exception ex) {
        failed.Add(new Dictionary<string, object> { { "master", "udf-options" }, { "error", ex.Message } });
      }
    }

    var res = new Dictionary<string, object> {
      { "ok", failed.Count == 0 },
      { "created", created },
      { "existed", existed },
      { "failed", failed },
    };
    /* A partial answer is still an answer: the caller needs to know WHICH master
       it may not name, and a bare 500 would lose that. */
    if (failed.Count > 0) res["error"] = failed.Count + " master(s) could not be opened";
    return res;
  }

  /* Existence is asked of the SDK, not of a table name we would have to guess.
     A getter that throws means "not there" — the same answer as a null. */
  static bool ItemExists(AutoCount.Stock.Item.ItemDataAccess da, string code) {
    try { return da.LoadItem(code, AutoCount.Stock.Item.ItemEntryAction.Edit) != null; }
    catch { return false; }
  }
  static bool PurchaseAgentExists(AutoCount.GeneralMaint.PurchaseAgent.PurchaseAgentCommand cmd, string code) {
    try { return cmd.GetPurchaseAgent(code) != null; } catch { return false; }
  }

  static bool AgentExists(AutoCount.GeneralMaint.SalesAgent.SalesAgentCommand cmd, string code) {
    try { return cmd.GetSalesAgent(code) != null; } catch { return false; }
  }
  static bool DebtorExists(AutoCount.ARAP.Debtor.DebtorDataAccess da, string acc) {
    try { return da.GetDebtor(acc) != null; } catch { return false; }
  }
  static bool CreditorExists(AutoCount.ARAP.Creditor.CreditorDataAccess da, string acc) {
    try { return da.GetCreditor(acc) != null; } catch { return false; }
  }
  static bool LocationExists(AutoCount.Stock.Location.LocationMaintenance lm, string code) {
    try { return lm.GetLocation(code) != null; } catch { return false; }
  }

  // ── edit (header + lines, incl. variants in Desc2) ─────────────────────────
  static void Edit(Dictionary<string, object> p) {
    var s = Session();
    var type = Str(p, "DocType").ToUpper();
    var docNo = Str(p, "DocNo");
    if (string.IsNullOrEmpty(docNo)) throw new Exception("DocNo required");
    dynamic doc;
    switch (type) {
      case "SO": doc = AutoCount.Invoicing.Sales.SalesOrder.SalesOrderCommand.Create(s, s.DBSetting).Edit(docNo); break;
      case "DO": doc = AutoCount.Invoicing.Sales.DeliveryOrder.DeliveryOrderCommand.Create(s, s.DBSetting).Edit(docNo); break;
      case "IV": doc = AutoCount.Invoicing.Sales.Invoice.InvoiceCommand.Create(s, s.DBSetting).Edit(docNo); break;
      case "PO": doc = AutoCount.Invoicing.Purchase.PurchaseOrder.PurchaseOrderCommand.Create(s, s.DBSetting).Edit(docNo); break;
      case "GR": doc = AutoCount.Invoicing.Purchase.GoodsReceivedNote.GoodsReceivedNoteCommand.Create(s, s.DBSetting).Edit(docNo); break;
      case "PI": doc = AutoCount.Invoicing.Purchase.PurchaseInvoice.PurchaseInvoiceCommand.Create(s, s.DBSetting).Edit(docNo); break;
      default: throw new Exception("unsupported DocType " + type);
    }
    if (doc == null) throw new Exception(type + " " + docNo + " not found");

    var h = Dict(p, "Header");
    if (h != null) {
      var dt = Date(h, "DocDate"); if (dt.HasValue) Set(() => doc.DocDate = dt.Value);
      /* THE DELIVERY DATE, WHICH THIS BOOK KEEPS IN SalesExemptionExpiryDate.
         Owner 2026-08-16: "就是用我们 delivery date 放进去 sales exemption date
         而已，一样的东西". AutoCount's sales-order HEADER has no delivery date of
         its own — SDK line 464 lists DeliveryDate on the six DETAIL classes and
         nowhere else — so this book uses the exemption expiry for it, and
         Inistate (the connector the ERP replaces) writes it there.

         Handled HERE and not in the string loop below: that loop reads every key
         with Str() and assigns through reflection, and a Nullable<DateTime>
         property given a string throws — inside Set(), which swallows it. The
         field would have looked wired and written nothing.

         ContainsKey, not HasValue, for the same reason as the line delivery
         date: present-and-null is how the ERP says BLANK IT, and absent is how
         it says leave the book's own alone. */
      if (h.ContainsKey("SalesExemptionExpiryDate")) {
        var xd = Date(h, "SalesExemptionExpiryDate");
        Set(() => doc.SalesExemptionExpiryDate = xd);
      }
      foreach (var key in new string[] { "DebtorName", "CreditorName", "Attention", "Agent", "Ref",
                                         "Description", "SalesLocation", "Phone1",
                                         "InvAddr1", "InvAddr2", "InvAddr3", "InvAddr4",
                                         "DeliverAddr1", "DeliverAddr2", "DeliverAddr3", "DeliverAddr4",
                                         "DeliverContact", "DeliverPhone1",
                                         "Remark1", "Remark2", "Remark3", "Remark4", "Note" }) {
        if (!h.ContainsKey(key)) continue;
        var val = Str(h, key);
        var prop = ((object) doc).GetType().GetProperty(key);
        if (prop != null && prop.CanWrite) Set(() => prop.SetValue(doc, val, null));
      }
      ApplyUdf(h, k => doc.UDF[k], (k, v) => doc.UDF[k] = v);
    }

    /* Lines are addressed by the AutoCount DtlKey the ERP stored at import, so
       an edit updates the SAME line instead of appending a duplicate.

       A KEYLESS LINE IS REFUSED unless the ERP explicitly asserts IsNewLine.
       This is the whole point of the guard and it is not defensive padding:
       every migrated document in production carries NULL DtlKeys on every line
       (measured 2026-08-11 on prod: 0 of 13,907 SO lines and 0 of 864 PO lines
       had one), so a fallback to AddDetail() does not add "the new line" — it
       appends a SECOND COPY of every line the operator did not change, into a
       live licensed account book. On a PO that duplicate can never be removed:
       PurchaseOrder exposes neither DeleteDetail nor any line-level Cancelled
       flag in this SDK, only SalesOrder has DeleteDetail. Refusing costs a
       failed outbox row the operator can see; appending costs an account book
       nobody can repair.

       Validated in a PRE-FLIGHT PASS, before a single detail is touched, so a
       refusal leaves the document exactly as AutoCount already had it rather
       than half-applied and discarded. */
    var lines = new List<Dictionary<string, object>>();
    foreach (var od in List(p, "Lines")) lines.Add((Dictionary<string, object>) od);
    for (var i = 0; i < lines.Count; i++) {
      var it = lines[i];
      var hasKey = it.ContainsKey("DtlKey") && it["DtlKey"] != null;
      if (hasKey) continue;
      if (Bool(it, "IsNewLine")) continue;
      throw new Exception(
        "REFUSED: line " + (i + 1) + " of " + lines.Count + " on " + type + " " + docNo +
        " (ItemCode '" + Str(it, "ItemCode") + "') carries no DtlKey and does not declare " +
        "IsNewLine. Appending it would duplicate a line in the live account book, and on a " +
        "PO a duplicate cannot be removed. Store the line's AutoCount DtlKey " +
        "(scm.*_items.linked_ac_dtlkey) or mark the line IsNewLine, then retry.");
    }

    foreach (var it in lines) {
      dynamic d;
      if (it.ContainsKey("DtlKey") && it["DtlKey"] != null) {
        d = doc.EditDetail(System.Convert.ToInt64(it["DtlKey"]));
        if (d == null) throw new Exception("line " + it["DtlKey"] + " not found on " + docNo);
      } else {
        d = doc.AddDetail();
        Set(() => d.ItemCode = Str(it, "ItemCode"));
      }

      /* RETIREMENT. The owner's rule is that nothing is ever deleted, only
         cancelled — and no detail class in this SDK exposes Cancelled/Void/
         Status at line level, so "cancelled" has to be expressed in the fields
         that do exist. Qty = 0 is the load-bearing one, not a cosmetic touch:
         AutoCount's own outstanding predicate is
             Qty - ISNULL(TransferedQty, 0) > 0
         (the same one DtlKeys() reads above), so ONLY zeroing the quantity
         makes AutoCount's outstanding set agree with an ERP line that has been
         retired. Transferable = false stops it being pulled into a later DO or
         GRN, and the Desc2 marker is what a human reads.

         Deliberately NOT wrapped in Set(): Set swallows the exception, and a
         silently-skipped Qty = 0 would leave the line outstanding in AutoCount
         while the ERP believes it is cancelled — the precise divergence this
         exists to prevent. It must fail the whole edit instead.

         PrintOut is left alone on purpose. A retired line stays visible on the
         printed document, marked; hiding it would be deletion wearing a
         different hat. */
      if (Bool(it, "Retire")) {
        d.Qty = 0;
        Set(() => d.Transferable = false);
        var keep = it.ContainsKey("Desc2") ? Str(it, "Desc2") : SafeDesc2(d);
        Set(() => d.Desc2 = (RETIRED_MARK + " " + keep).Trim());
        continue;
      }

      if (it.ContainsKey("Description")) Set(() => d.Description = Str(it, "Description"));
      if (it.ContainsKey("Desc2"))       Set(() => d.Desc2 = Str(it, "Desc2"));
      /* FurtherDescription — the photograph field. Two shapes, and the second
         is the one the ERP uses:
           FurtherDescription : "<rtf>"   verbatim, for probes and for a value
                                          read back out of the book unchanged
           Photos : [ { Jpeg, Caption? } ] the JPEGs; this host renders them

         NOT wrapped in Set(). Set() swallows the exception and logs it, which is
         right for a cosmetic field but wrong here: a silently-skipped write
         would leave the ERP believing the photographs reached AutoCount when
         the line still holds whatever it held before. A conversion that fails
         must fail the whole edit and be visible in the response. */
      if (it.ContainsKey("FurtherDescription")) {
        var fd = Str(it, "FurtherDescription");
        d.FurtherDescription = fd;
      } else if (it.ContainsKey("Photos")) {
        int n;
        var rtf = PhotoRtf(List(it, "Photos"), out n);
        d.FurtherDescription = rtf;
        Log("  FurtherDescription: " + n + " picture(s), " + rtf.Length + " chars");
      }
      if (it.ContainsKey("Qty"))         Set(() => d.Qty = Dec(it, "Qty", 1));
      if (it.ContainsKey("UnitPrice"))   Set(() => d.UnitPrice = Dec(it, "UnitPrice", 0));
      if (it.ContainsKey("Location"))    Set(() => d.Location = Str(it, "Location"));
      /* Same ContainsKey rule as CreateSo — but the ERP never sends a NULL here.
         composeEdit drops the key on a line the book already holds, because a
         blank there would ERASE a date an operator may have set in AutoCount
         itself. A date the ERP DOES hold still travels. */
      if (it.ContainsKey("DeliveryDate")) {
        var dd = Date(it, "DeliveryDate"); Set(() => d.DeliveryDate = dd);
      }
    }
    doc.Save();
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  /* EVERY UDF VALUE WENT IN AS A STRING, AND ONE OF THEM IS NOT A STRING.

     Owner 2026-08-16: editing a sales order's Processing Date does not reach
     AutoCount. Measured on production the same day (outbox rows for
     HC-SO-2608-002, run 31943942030):

       create_so  UDF = {VENUE, ToPONo, BRANDING}       <- no PDate, no BALANCE
       edit       UDF = {..., BALANCE, PAYEMENT}        <- both new on the edit
       edit       UDF = {PDate "2026-08-16", ...}

     The book holds BALANCE and PAYEMENT as the LAST EDIT sent them and neither
     was ever sent by the create - so the edit path does apply UDFs. It holds
     UDF_PDate as the document's own DocDate, which no payload ever sent. So the
     loss is PER KEY, and PDate is the only key in that payload whose column is a
     DATE: the fidelity export reads UDF_VENUE / UDF_BRANDING through
     LTRIM(RTRIM(...)), UDF_BALANCE through ISNULL(...,0) and UDF_PDate through
     CONVERT(varchar(10), ..., 120), and one of the 2,500 exported values carries
     a time (SO-010311 = "2026-07-22 01:00:00").

     WHY IT WAS INVISIBLE. `Set()` catches and logs `set skipped: <message>` with
     no key, no value and no route, and the request still answers {"ok":true}, so
     the outbox row goes to `sent`. That is the same swallow that hid a NULL Qty
     on every /so-to-po until the log was read by hand.

     THE LADDER, and why it is a ladder rather than a cast. The SDK's `UDF`
     member is INHERITED, and sdk-api-reference.txt was dumped with
     BindingFlags.DeclaredOnly, so the indexer's parameter type is not recorded
     anywhere we can check and must not be guessed at. So the STRING is still
     attempted first and unchanged - a key that lands today lands the same way
     today - and a typed value is only ever tried after the book has already
     refused the string. Worst case is what happens now, plus a log line that
     names the field.

     A BLANK STILL BLANKS. Present-and-null arrives as "" and blanks the field
     (#2218); absent is not in this dictionary at all and leaves the book's own.
     On a date column "" is not a date either, so the empty string gets the same
     ladder - null, then DBNull - rather than being swallowed as it is today. */
  static void ApplyUdf(Dictionary<string, object> p, Func<string, object> get, Action<string, object> set) {
    var udf = Dict(p, "UDF");
    if (udf == null) return;
    foreach (var kv in udf) {
      var k = kv.Key; var v = kv.Value == null ? "" : kv.Value.ToString();
      SetUdf(k, v, set);
    }
  }

  /* NOT Set(): a UDF that does not land has to say which one. */
  static void SetUdf(string k, string v, Action<string, object> set) {
    var shapes = new List<string>();
    var values = new List<object>();
    shapes.Add("String"); values.Add(v);
    if (v.Length == 0) {
      shapes.Add("null");   values.Add(null);
      shapes.Add("DBNull"); values.Add(DBNull.Value);
    } else {
      decimal dec; DateTime dt;
      /* Decimal is asked FIRST because it is the narrower test: "0.00" is a
         number and not a date, while a date is never a decimal. */
      if (decimal.TryParse(v, System.Globalization.NumberStyles.Number,
                           System.Globalization.CultureInfo.InvariantCulture, out dec)) {
        shapes.Add("Decimal"); values.Add(dec);
      } else if (DateTime.TryParse(v, System.Globalization.CultureInfo.InvariantCulture,
                                   System.Globalization.DateTimeStyles.None, out dt)) {
        shapes.Add("DateTime"); values.Add(dt);
      }
    }
    var refused = new List<string>();
    for (var i = 0; i < values.Count; i++) {
      try {
        set(k, values[i]);
        if (i > 0) Log("  UDF " + k + ": applied as " + shapes[i] + " (" + string.Join("; ", refused.ToArray()) + ")");
        return;
      } catch (Exception ex) {
        refused.Add(shapes[i] + " refused: " + ex.Message);
      }
    }
    Log("  UDF " + k + " = '" + v + "' NOT APPLIED, the account book keeps its own value - "
        + string.Join(" | ", refused.ToArray()));
  }
  static Dictionary<string, object> Ok(string docNo) {
    var d = new Dictionary<string, object> { { "ok", true } };
    if (docNo != null) d["docNo"] = docNo;
    return d;
  }
  /* Create answers with the line keys too — see CreatedLines(). Without them a
     document the ERP creates has NULL DtlKeys forever, and the very next edit
     of it hits the keyless-line refusal in Edit(). */
  static Dictionary<string, object> Ok(string docNo, List<Dictionary<string, object>> lines) {
    var d = Ok(docNo);
    if (lines != null) d["lines"] = lines;
    return d;
  }
  /* Length-independent comparison. A shared secret on a public hostname should
     not also answer "how much of it did you get right". */
  static bool SameKey(string given, string want) {
    if (given == null) return false;
    var diff = given.Length ^ want.Length;
    for (int i = 0; i < given.Length && i < want.Length; i++) diff |= given[i] ^ want[i];
    return diff == 0;
  }
  static Dictionary<string, object> Err(string m) { return new Dictionary<string, object> { { "ok", false }, { "error", m } }; }
  static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }
  static string Or(string a, string b) { return string.IsNullOrEmpty(a) ? b : a; }
  static decimal Dec(Dictionary<string, object> d, string k, decimal dflt) { object v; return d.TryGetValue(k, out v) && v != null ? System.Convert.ToDecimal(v) : dflt; }
  static DateTime? Date(Dictionary<string, object> d, string k) {
    object v; if (!d.TryGetValue(k, out v) || v == null || v.ToString().Length == 0) return null;
    DateTime dt; return DateTime.TryParse(v.ToString(), out dt) ? dt : (DateTime?) null;
  }
  static Dictionary<string, object> Dict(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null; }
  static bool Bool(Dictionary<string, object> d, string k) {
    object v; if (!d.TryGetValue(k, out v) || v == null) return false;
    if (v is bool) return (bool) v;
    var s = v.ToString().Trim();
    return s == "1" || s.Equals("true", StringComparison.OrdinalIgnoreCase);
  }
  /* Desc2 is a settable property on every detail class, but reading it back off
     the dynamic wrapper is not guaranteed on every one — fall back to empty
     rather than losing the retirement over a missing getter. */
  static string SafeDesc2(dynamic d) { try { return (string) d.Desc2 ?? ""; } catch { return ""; } }
  static IEnumerable<object> List(Dictionary<string, object> d, string k) { object v; if (d.TryGetValue(k, out v) && v is object[]) return (object[]) v; return new object[0]; }
  static void Set(Action a) { try { a(); } catch (Exception ex) { Log("  set skipped: " + ex.Message); } }

  // ── FurtherDescription: photographs, in the form AutoCount itself writes ───
  /* WHY THE CONVERSION IS HERE AND NOT IN THE WORKER.
     Read off the LIVE book on 2026-08-15 (docs/autocount-further-description-
     photos.md section 4.2): all three sampled SODTL lines store the picture as
     `\wmetafile8` — a Windows metafile — and none as `\jpegblip` or `\pngblip`.
     A JPEG therefore cannot go in verbatim. Turning one into a metafile needs
     GDI, which exists on this host and nowhere in a Cloudflare Worker, so the
     ERP sends the JPEG bytes and the conversion happens here.

     MM_ANISOTROPIC (8) is not a choice: it is the number IN the keyword
     `\wmetafile8`, so the bits have to be fetched in that mapping mode for the
     declaration to be true. */
  const int MM_ANISOTROPIC = 8;
  [DllImport("gdi32.dll")] static extern uint GetWinMetaFileBits(IntPtr hemf, uint cbData16, byte[] pData16, int iMapMode, IntPtr hdcRef);
  [DllImport("gdi32.dll")] static extern bool DeleteEnhMetaFile(IntPtr hemf);

  static byte[] JpegToWmf(byte[] picture, out int widthPx, out int heightPx) {
    using (var ms = new MemoryStream(picture))
    using (var src = Image.FromStream(ms)) {
      widthPx = src.Width; heightPx = src.Height;
      /* A 1x1 bitmap only exists to lend a screen-compatible HDC: both the
         metafile and GetWinMetaFileBits need a reference DC, and neither
         draws on it. */
      using (var refBmp = new Bitmap(1, 1))
      using (var refG = Graphics.FromImage(refBmp)) {
        IntPtr hdc = refG.GetHdc();
        try {
          using (var buf = new MemoryStream())
          using (var mf = new Metafile(buf, hdc, new Rectangle(0, 0, widthPx, heightPx), MetafileFrameUnit.Pixel, EmfType.EmfOnly)) {
            using (var g = Graphics.FromImage(mf)) g.DrawImage(src, 0, 0, widthPx, heightPx);
            /* GetHenhmetafile hands OWNERSHIP over; the Metafile must not
               free it and we must. */
            IntPtr hemf = mf.GetHenhmetafile();
            try {
              uint n = GetWinMetaFileBits(hemf, 0, null, MM_ANISOTROPIC, hdc);
              if (n == 0) throw new Exception("GetWinMetaFileBits returned a zero size");
              var wmf = new byte[n];
              if (GetWinMetaFileBits(hemf, n, wmf, MM_ANISOTROPIC, hdc) == 0) throw new Exception("GetWinMetaFileBits failed to fill the buffer");
              return wmf;
            } finally { DeleteEnhMetaFile(hemf); }
          }
        } finally { refG.ReleaseHdc(hdc); }
      }
    }
  }

  /* 96 dpi, and it is MEASURED, not assumed: on all three sampled lines
     picwgoal/1440 against picw gives exactly 96 (3600/1440 in against 240 px,
     and the same for 2220/148 and 750/50). picw/pich are pixels, the *goal
     pair is twips. */
  const int PhotoDpi = 96;
  static int Twips(int px) { return (int) Math.Round((double) px * 1440.0 / PhotoDpi); }

  static string RtfHex(byte[] b) {
    var sb = new StringBuilder(b.Length * 2 + b.Length / 32);
    for (int i = 0; i < b.Length; i++) {
      sb.Append(b[i].ToString("x2"));
      if ((i + 1) % 32 == 0) sb.Append('\n');
    }
    return sb.ToString();
  }

  static string RtfEscape(string s) {
    var sb = new StringBuilder();
    foreach (char ch in s ?? "") {
      if (ch == '\\' || ch == '{' || ch == '}') { sb.Append('\\').Append(ch); continue; }
      if (ch == '\n') { sb.Append("\\par\n"); continue; }
      if (ch == '\r') continue;
      if (ch < 0x80) { sb.Append(ch); continue; }
      sb.Append("\\u").Append(((short) ch).ToString()).Append('?');
    }
    return sb.ToString();
  }

  /* Builds the WHOLE field value from the photographs the ERP holds for one
     line, in the shape the live book was observed to use: a caption paragraph,
     then the picture, per photograph.

     THE CAPTION IS NOT DECORATION. Section 4.2 found `Image on 8/12/2024
     5:01:16 PM` sitting before the {\pict group on every sampled line, so a
     writer that emitted pictures alone would DESTROY text AutoCount put there.
     The ERP sends the caption it read back, or we stamp today's.

     The field is ONE string and is replaced wholesale — there is no append — so
     the caller must send every photograph the line should end up with, not just
     the new ones. That rule is section 6.3's, and it belongs to the composer;
     this function only renders what it is given. */
  static string PhotoRtf(IEnumerable<object> photos, out int converted) {
    var parts = new List<string>();
    converted = 0;
    foreach (var o in photos) {
      var ph = o as Dictionary<string, object>;
      if (ph == null) throw new Exception("each entry of Photos must be an object");
      var b64 = Str(ph, "Jpeg");
      if (string.IsNullOrEmpty(b64)) throw new Exception("a Photos entry carries no Jpeg");
      byte[] jpeg;
      try { jpeg = Convert.FromBase64String(b64); }
      catch (Exception ex) { throw new Exception("a Photos entry is not valid base64: " + ex.Message); }

      int w, h;
      var wmf = JpegToWmf(jpeg, out w, out h);

      var caption = ph.ContainsKey("Caption")
        ? Str(ph, "Caption")
        : "Image on " + DateTime.Now.ToString("M/d/yyyy h:mm:ss tt");
      if (!string.IsNullOrEmpty(caption)) parts.Add(RtfEscape(caption));

      parts.Add("{\\pict\\wmetafile8\\picw" + w + "\\pich" + h
                + "\\picwgoal" + Twips(w) + "\\pichgoal" + Twips(h) + "\n"
                + RtfHex(wmf) + "}");
      converted++;
    }
    if (parts.Count == 0) throw new Exception("Photos was empty — omit the key instead of sending nothing");
    return "{\\rtf1\\ansi\\deff0\n{\\fonttbl{\\f0 Arial;}}\n\\viewkind4\\uc1\\pard\\fs20 "
           + string.Join("\n\\par\n", parts.ToArray())
           + "\n\\fs20\\par\n}";
  }

  static void Json(HttpListenerContext ctx, int code, Dictionary<string, object> obj) {
    var s = new JavaScriptSerializer().Serialize(obj);
    var b = Encoding.UTF8.GetBytes(s);
    ctx.Response.StatusCode = code;
    ctx.Response.ContentType = "application/json";
    ctx.Response.ContentLength64 = b.Length;
    ctx.Response.OutputStream.Write(b, 0, b.Length);
    ctx.Response.Close();
  }
}
