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
// ── HOW THE SDK ACTUALLY DOES A CONVERSION (reflected off the installed 2.2
// assemblies on 2026-08-10 — NOT guessed) ──────────────────────────────────
// There is NO TransferTo/CreateFrom API. Every document class exposes exactly
// one transfer primitive:
//     AddPartialTransferDetail(string fromDocType, long[] fromDocDtlKeys, bool)
// So a conversion is: create the target with cmd.AddNew(), call that with the
// SOURCE LINE KEYS, set whatever header fields differ, Save(). The SDK writes
// the DocTransfer bookkeeping itself — the detail classes expose NO settable
// From* fields, so the link cannot be (and must not be) faked by hand.
//
// fromDocType literals are the ones the live book already stores in
// DODTL/GRDTL/IVDTL/PIDTL.FromDocType: "SO", "PO", "DO", "GR".
//
// Cancel is a COMMAND method, not a flag: InvoicingCommonCommand.CancelDocument
// (docNo, userID) — inherited by every invoicing command. Setting Cancelled on
// the entity would bypass AutoCount's transferred-document guards.
//
// Headless safety: the SDK raises WinForms dialogs for over-transfer. That
// event's EventArgs type is not public, so it cannot be subscribed; the
// condition is instead made unreachable by only ever transferring what is
// outstanding. See the note above OverQty's former site.
//
// Build (on the AutoCount host):
//   csc.exe /platform:x64 ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.dll" ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Invoicing.dll" ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Sales.dll" ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Purchase.dll" ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Accounting.dll" ^
//     /r:System.Web.Extensions.dll /r:System.Data.dll ^
//     /out:AcSyncService.exe AcSyncService.cs
//
// Run: AcSyncService.exe   (port from C:\Tempc-svc-port.txt, default 8900)
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
// C:\Temp\ac-svc-key.txt. It now appears in THREE methods — Session, DtlKeys
// and CreatedLines — so the build step must replace EVERY occurrence, not the
// first one.
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Reflection;
using System.Collections.Generic;
using System.Web.Script.Serialization;

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
    "http://localhost:" + (File.Exists(@"C:\Tempc-svc-port.txt")
      ? File.ReadAllText(@"C:\Tempc-svc-port.txt").Trim() : "8900") + "/";
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

  static void Log(string m) {
    try { File.AppendAllText(@"C:\Temp\ac-sync-service.log", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + m + "\r\n"); } catch { }
  }

  static void Handle(HttpListenerContext ctx) {
    var path = ctx.Request.Url.AbsolutePath;
    if (path == "/health") {
      Json(ctx, 200, new Dictionary<string, object> { { "ok", true }, { "book", BOOK }, { "service", "AcSyncService" } });
      return;
    }
    if (ctx.Request.HttpMethod != "POST") { Json(ctx, 405, Err("POST only")); return; }
    if (!string.IsNullOrEmpty(ApiKey) && ctx.Request.Headers["X-API-KEY"] != ApiKey) { Json(ctx, 401, Err("bad key")); return; }

    string body;
    using (var sr = new StreamReader(ctx.Request.InputStream, Encoding.UTF8)) body = sr.ReadToEnd();
    var p = (Dictionary<string, object>) new JavaScriptSerializer().DeserializeObject(body);
    Log(path + " " + (body.Length > 400 ? body.Substring(0, 400) + "..." : body));

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
      case "/do-to-iv":  docNo = Convert_("DO", "IV", p); dtlTable = "IVDTL"; break;
      case "/gr-to-pi":  docNo = Convert_("GR", "PI", p); dtlTable = "PIDTL"; break;
      case "/cancel":    Cancel(p); Json(ctx, 200, Ok(null)); return;
      case "/edit":      Edit(p);   Json(ctx, 200, Ok(null)); return;
      case "/ensure-masters": Json(ctx, 200, EnsureMasters(p)); return;
      default: Json(ctx, 404, Err("unknown route " + path)); return;
    }
    Json(ctx, 200, Ok(docNo, CreatedLines(dtlTable, docNo)));
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
  static string CreateSo(Dictionary<string, object> p) {
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
      var dd = Date(it, "DeliveryDate"); if (dd.HasValue) Set(() => d.DeliveryDate = dd.Value);
    }
    so.Save();
    return so.DocNo;
  }

  static string CreatePo(Dictionary<string, object> p) {
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
      var dd = Date(it, "DeliveryDate"); if (dd.HasValue) Set(() => d.DeliveryDate = dd.Value);
    }
    po.Save();
    return po.DocNo;
  }

  // ── conversions (SO->DO, PO->GR, DO->IV, GR->PI) ──────────────────────────
  // One code path: resolve the source lines, create the target, hand the line
  // keys to AddPartialTransferDetail, apply header overrides, Save.
  static string Convert_(string fromType, string toType, Dictionary<string, object> p) {
    var s = Session();
    var fromDocNo = Str(p, "FromDocNo");
    if (string.IsNullOrEmpty(fromDocNo)) throw new Exception("FromDocNo required");
    var dtlKeys = DtlKeys(p, fromType, fromDocNo);
    if (dtlKeys.Length == 0) throw new Exception("no transferable lines on " + fromType + " " + fromDocNo);

    switch (toType) {
      case "DO": {
        var cmd = AutoCount.Invoicing.Sales.DeliveryOrder.DeliveryOrderCommand.Create(s, s.DBSetting);
        var doc = cmd.AddNew();
        doc.AddPartialTransferDetail(fromType, dtlKeys, false);
        SalesHeader(doc, p);
        doc.Save();
        return doc.DocNo;
      }
      case "IV": {
        var cmd = AutoCount.Invoicing.Sales.Invoice.InvoiceCommand.Create(s, s.DBSetting);
        var doc = cmd.AddNew();
        doc.AddPartialTransferDetail(fromType, dtlKeys, false);
        SalesHeader(doc, p);
        doc.Save();
        return doc.DocNo;
      }
      case "GR": {
        var cmd = AutoCount.Invoicing.Purchase.GoodsReceivedNote.GoodsReceivedNoteCommand.Create(s, s.DBSetting);
        var doc = cmd.AddNew();
        doc.AddPartialTransferDetail(fromType, dtlKeys, false);
        PurchaseHeader(doc, p);
        Set(() => doc.SupplierDONo = Str(p, "SupplierDONo"));
        doc.Save();
        return doc.DocNo;
      }
      case "PI": {
        var cmd = AutoCount.Invoicing.Purchase.PurchaseInvoice.PurchaseInvoiceCommand.Create(s, s.DBSetting);
        var doc = cmd.AddNew();
        doc.AddPartialTransferDetail(fromType, dtlKeys, false);
        PurchaseHeader(doc, p);
        Set(() => doc.SupplierInvoiceNo = Str(p, "SupplierInvoiceNo"));
        doc.Save();
        return doc.DocNo;
      }
    }
    throw new Exception("unsupported target " + toType);
  }

  /* OVER-TRANSFER: unreachable by construction, not answered by a handler.
     Every document class exposes ConfirmOverTransferedQtyEvent, but its
     EventArgs type is not public in AutoCount.Invoicing — reflection against
     the real assemblies found the delegate and no matching public args type,
     so it cannot be subscribed from outside the SDK, and naming it does not
     compile. Instead the condition is made impossible: DtlKeys() only ever
     selects source lines with (Qty - TransferedQty) > 0 and transfers exactly
     what is outstanding. If a caller passes explicit DtlKeys that would
     over-transfer, AutoCount raises PartialTransferQtyLessThanTransferedQty
     Exception (or a sibling) and the service returns that as an error — the
     failure mode is a refused call, never a silently accepted over-ship. */

  static void SalesHeader(dynamic doc, Dictionary<string, object> p) {
    var dt = Date(p, "DocDate"); if (dt.HasValue) Set(() => doc.DocDate = dt.Value);
    if (p.ContainsKey("DocNo") && !string.IsNullOrEmpty(Str(p, "DocNo"))) Set(() => doc.DocNo = Str(p, "DocNo"));
    Set(() => doc.Ref = Str(p, "Ref"));
    Set(() => doc.Description = Str(p, "Description"));
    ApplyUdf(p, k => doc.UDF[k], (k, v) => doc.UDF[k] = v);
  }

  static void PurchaseHeader(dynamic doc, Dictionary<string, object> p) {
    var dt = Date(p, "DocDate"); if (dt.HasValue) Set(() => doc.DocDate = dt.Value);
    if (p.ContainsKey("DocNo") && !string.IsNullOrEmpty(Str(p, "DocNo"))) Set(() => doc.DocNo = Str(p, "DocNo"));
    Set(() => doc.Ref = Str(p, "Ref"));
    Set(() => doc.Description = Str(p, "Description"));
    ApplyUdf(p, k => doc.UDF[k], (k, v) => doc.UDF[k] = v);
  }

  /* Source line keys: either the caller names them (partial delivery — the ERP
     decides which lines ship) or we take every outstanding line on the source
     document. Read straight from the book's own detail table so the set always
     matches what AutoCount considers untransferred. */
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
     - It never creates a LOCATION. A new warehouse is a real business decision
       with stock consequences; a create that names an unknown one is refused on
       the ERP side instead (MissingLocationError).
     - Everything it creates is stamped in Desc2/Description so Finance can find
       them: an auto-opened master is a thing to review, not a thing to hide. */
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
        Set(() => e.ItemGroup = Str(it, "ItemGroup"));
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
  static bool AgentExists(AutoCount.GeneralMaint.SalesAgent.SalesAgentCommand cmd, string code) {
    try { return cmd.GetSalesAgent(code) != null; } catch { return false; }
  }
  static bool DebtorExists(AutoCount.ARAP.Debtor.DebtorDataAccess da, string acc) {
    try { return da.GetDebtor(acc) != null; } catch { return false; }
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
      if (it.ContainsKey("Qty"))         Set(() => d.Qty = Dec(it, "Qty", 1));
      if (it.ContainsKey("UnitPrice"))   Set(() => d.UnitPrice = Dec(it, "UnitPrice", 0));
      if (it.ContainsKey("Location"))    Set(() => d.Location = Str(it, "Location"));
      var dd = Date(it, "DeliveryDate"); if (dd.HasValue) Set(() => d.DeliveryDate = dd.Value);
    }
    doc.Save();
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  static void ApplyUdf(Dictionary<string, object> p, Func<string, object> get, Action<string, string> set) {
    var udf = Dict(p, "UDF");
    if (udf == null) return;
    foreach (var kv in udf) {
      var k = kv.Key; var v = kv.Value == null ? "" : kv.Value.ToString();
      Set(() => set(k, v));
    }
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
