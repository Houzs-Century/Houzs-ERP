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
// Headless safety: the SDK raises WinForms dialogs for over-transfer and
// transfer conflicts. We subscribe ConfirmOverTransferedQtyEvent and answer it
// programmatically so a service call can never block on a hidden dialog.
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
//   /create-so       -> { docNo }      payload = header + Details[]
//   /create-po       -> { docNo }
//   /so-to-do        -> { docNo }      { FromDocNo, DtlKeys[]?, DocDate?, ... }
//   /po-to-gr        -> { docNo }
//   /do-to-iv        -> { docNo }
//   /gr-to-pi        -> { docNo }
//   /cancel          -> { ok }         { DocType, DocNo }
//   /edit            -> { ok }         { DocType, DocNo, Header{}, Lines[] }
//
// The SQL connection line (__DBLINE__) is injected at build time so the DB
// password never lives in source control; the API key is read from
// C:\Temp\ac-svc-key.txt.
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Reflection;
using System.Collections.Generic;
using System.Web.Script.Serialization;

class AcSyncService {
  const string AC   = @"C:\Program Files\AutoCount\Accounting 2.2";
  const string BOOK = "AED_HOUZS";
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

    string docNo;
    switch (path) {
      case "/create-so": docNo = CreateSo(p); break;
      case "/create-po": docNo = CreatePo(p); break;
      case "/so-to-do":  docNo = Convert_("SO", "DO", p); break;
      case "/po-to-gr":  docNo = Convert_("PO", "GR", p); break;
      case "/do-to-iv":  docNo = Convert_("DO", "IV", p); break;
      case "/gr-to-pi":  docNo = Convert_("GR", "PI", p); break;
      case "/cancel":    Cancel(p); Json(ctx, 200, Ok(null)); return;
      case "/edit":      Edit(p);   Json(ctx, 200, Ok(null)); return;
      default: Json(ctx, 404, Err("unknown route " + path)); return;
    }
    Json(ctx, 200, Ok(docNo));
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
        doc.ConfirmOverTransferedQtyEvent += OverQty;
        doc.AddPartialTransferDetail(fromType, dtlKeys, false);
        SalesHeader(doc, p);
        doc.Save();
        return doc.DocNo;
      }
      case "IV": {
        var cmd = AutoCount.Invoicing.Sales.Invoice.InvoiceCommand.Create(s, s.DBSetting);
        var doc = cmd.AddNew();
        doc.ConfirmOverTransferedQtyEvent += OverQty;
        doc.AddPartialTransferDetail(fromType, dtlKeys, false);
        SalesHeader(doc, p);
        doc.Save();
        return doc.DocNo;
      }
      case "GR": {
        var cmd = AutoCount.Invoicing.Purchase.GoodsReceivedNote.GoodsReceivedNoteCommand.Create(s, s.DBSetting);
        var doc = cmd.AddNew();
        doc.ConfirmOverTransferedQtyEvent += OverQty;
        doc.AddPartialTransferDetail(fromType, dtlKeys, false);
        PurchaseHeader(doc, p);
        Set(() => doc.SupplierDONo = Str(p, "SupplierDONo"));
        doc.Save();
        return doc.DocNo;
      }
      case "PI": {
        var cmd = AutoCount.Invoicing.Purchase.PurchaseInvoice.PurchaseInvoiceCommand.Create(s, s.DBSetting);
        var doc = cmd.AddNew();
        doc.ConfirmOverTransferedQtyEvent += OverQty;
        doc.AddPartialTransferDetail(fromType, dtlKeys, false);
        PurchaseHeader(doc, p);
        Set(() => doc.SupplierInvoiceNo = Str(p, "SupplierInvoiceNo"));
        doc.Save();
        return doc.DocNo;
      }
    }
    throw new Exception("unsupported target " + toType);
  }

  /* The SDK's over-transfer dialog, answered in code. Refusing is the safe
     default: an ERP that thinks it is shipping more than the PO ordered is a
     data bug, and silently accepting it here would hide it inside AutoCount. */
  static void OverQty(object sender, AutoCount.Invoicing.ConfirmOverTransferedQtyEventArgs e) {
    Set(() => e.IsConfirmed = false);
  }

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
       an edit updates the SAME line instead of appending a duplicate. A line
       with no DtlKey is a genuinely new line. Deleting lines is NOT offered:
       only SalesOrder exposes DeleteDetail in this SDK, so a "delete" would
       behave differently per document type — the ERP cancels and re-issues
       instead, which is what the accounts expect anyway. */
    foreach (var od in List(p, "Lines")) {
      var it = (Dictionary<string, object>) od;
      dynamic d;
      if (it.ContainsKey("DtlKey") && it["DtlKey"] != null) {
        d = doc.EditDetail(System.Convert.ToInt64(it["DtlKey"]));
        if (d == null) throw new Exception("line " + it["DtlKey"] + " not found on " + docNo);
      } else {
        d = doc.AddDetail();
        Set(() => d.ItemCode = Str(it, "ItemCode"));
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
  static Dictionary<string, object> Err(string m) { return new Dictionary<string, object> { { "ok", false }, { "error", m } }; }
  static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }
  static string Or(string a, string b) { return string.IsNullOrEmpty(a) ? b : a; }
  static decimal Dec(Dictionary<string, object> d, string k, decimal dflt) { object v; return d.TryGetValue(k, out v) && v != null ? System.Convert.ToDecimal(v) : dflt; }
  static DateTime? Date(Dictionary<string, object> d, string k) {
    object v; if (!d.TryGetValue(k, out v) || v == null || v.ToString().Length == 0) return null;
    DateTime dt; return DateTime.TryParse(v.ToString(), out dt) ? dt : (DateTime?) null;
  }
  static Dictionary<string, object> Dict(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null; }
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
