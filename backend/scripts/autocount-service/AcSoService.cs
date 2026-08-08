// AutoCount Sales-Order write-back service (self-hosted HTTP, .NET Framework 4).
//
// This is the AutoCount-SIDE half of the ERP -> AutoCount write-back. It runs ON
// the machine that has AutoCount 2.2 installed + licensed + SQL access, listens on
// a local port, and creates an AutoCount Sales Order from a JSON payload using the
// AutoCount SDK (no UI, no UltraViewer at runtime). The ERP (Cloudflare Worker)
// posts to it through the cloudflared tunnel.
//
// Build (on the AutoCount host):
//   csc.exe /platform:x64 ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.dll" ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Invoicing.dll" ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Sales.dll" ^
//     /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Accounting.dll" ^
//     /r:System.Web.Extensions.dll ^
//     /out:AcSoService.exe AcSoService.cs
//
// Run:  AcSoService.exe   (listens on http://localhost:8899/)
// Later: register as a Windows service / scheduled task set to run at startup so no
// human is needed. Front it with the cloudflared tunnel on your own Cloudflare domain.
//
// The SQL connection line (__DBLINE__) is injected at build time from an existing
// file so the DB password never lives in source control. API key is read from
// C:\Temp\ac-svc-key.txt so it is not hard-coded either.

using System;
using System.IO;
using System.Net;
using System.Text;
using System.Reflection;
using System.Collections.Generic;
using System.Web.Script.Serialization;

class AcSoService {
  const string AC   = @"C:\Program Files\AutoCount\Accounting 2.2";
  const string BOOK = "AED_HOUZS";
  const string URL  = "http://localhost:8899/";

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
    l.Prefixes.Add(URL);
    l.Start();
    Console.WriteLine("AcSoService listening on " + URL + "  (book=" + BOOK + ")");
    while (true) {
      var ctx = l.GetContext();
      try { Handle(ctx); }
      catch (Exception ex) {
        var msg = ex.Message;
        for (var e = ex.InnerException; e != null; e = e.InnerException) msg += " | " + e.Message;
        Json(ctx, 500, new Dictionary<string, object> { { "ok", false }, { "error", msg } });
      }
    }
  }

  static void Handle(HttpListenerContext ctx) {
    var path = ctx.Request.Url.AbsolutePath;
    if (path == "/health") { Json(ctx, 200, new Dictionary<string, object> { { "ok", true }, { "book", BOOK } }); return; }
    if (ctx.Request.HttpMethod != "POST" || path != "/create-so") {
      Json(ctx, 404, new Dictionary<string, object> { { "ok", false }, { "error", "POST /create-so or GET /health" } }); return;
    }
    if (ApiKey != null && ctx.Request.Headers["X-Api-Key"] != ApiKey) {
      Json(ctx, 401, new Dictionary<string, object> { { "ok", false }, { "error", "bad api key" } }); return;
    }
    string body;
    using (var r = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding)) body = r.ReadToEnd();
    var p = (Dictionary<string, object>) new JavaScriptSerializer().DeserializeObject(body);
    var docNo = CreateSo(p);
    Json(ctx, 200, new Dictionary<string, object> { { "ok", true }, { "docNo", docNo } });
  }

  static string CreateSo(Dictionary<string, object> p) {
    __DBLINE__
    var s = new AutoCount.Authentication.UserSession(db);
    if (!s.Login("ADMIN", "ADMIN")) throw new Exception("AutoCount login failed");
    var cmd = AutoCount.Invoicing.Sales.SalesOrder.SalesOrderCommand.Create(s, s.DBSetting);
    var so = cmd.AddNew();

    so.DocNo = Str(p, "DocNo");
    so.DocDate = p.ContainsKey("DocDate") && p["DocDate"] != null ? DateTime.Parse(Str(p, "DocDate")) : DateTime.Today;
    so.DebtorCode = Str(p, "DebtorCode");
    so.DebtorName = Str(p, "DebtorName");
    Set(() => so.Agent = Str(p, "Agent"));
    Set(() => so.SalesLocation = Str(p, "SalesLocation"));
    Set(() => so.Ref = Str(p, "Ref"));
    Set(() => so.Phone1 = Str(p, "Phone"));
    Set(() => so.Attention = Str(p, "DebtorName"));
    so.InvAddr1 = Str(p, "InvAddr1"); so.InvAddr2 = Str(p, "InvAddr2");
    so.InvAddr3 = Str(p, "InvAddr3"); so.InvAddr4 = Str(p, "InvAddr4");
    // delivery defaults to billing unless a DeliverAddr1 is supplied
    var d1 = Str(p, "DeliverAddr1"); if (string.IsNullOrEmpty(d1)) d1 = Str(p, "InvAddr1");
    so.IsDeliveryAddressEditedManually = true;
    so.DeliverAddr1 = d1;
    so.DeliverAddr2 = Or(Str(p, "DeliverAddr2"), Str(p, "InvAddr2"));
    so.DeliverAddr3 = Or(Str(p, "DeliverAddr3"), Str(p, "InvAddr3"));
    so.DeliverAddr4 = Or(Str(p, "DeliverAddr4"), Str(p, "InvAddr4"));
    Set(() => so.DeliverContact = Str(p, "DebtorName"));
    Set(() => so.DeliverPhone1 = Str(p, "Phone"));

    var udf = Dict(p, "UDF");
    if (udf != null) foreach (var kv in udf) Set(() => so.UDF[kv.Key] = kv.Value == null ? "" : kv.Value.ToString());

    foreach (var od in List(p, "Details")) {
      var it = (Dictionary<string, object>) od;
      var d = so.AddDetail();
      d.ItemCode = Str(it, "ItemCode");
      d.Description = Str(it, "Description");
      Set(() => d.Desc2 = Str(it, "Desc2"));
      d.Qty = Dec(it, "Qty", 1);
      d.UnitPrice = Dec(it, "UnitPrice", 0);
      if (it.ContainsKey("DeliveryDate") && it["DeliveryDate"] != null)
        Set(() => d.DeliveryDate = DateTime.Parse(Str(it, "DeliveryDate")));
    }
    so.Save();
    return so.DocNo;
  }

  // ---- helpers ----
  static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }
  static string Or(string a, string b) { return string.IsNullOrEmpty(a) ? b : a; }
  static decimal Dec(Dictionary<string, object> d, string k, decimal dflt) { object v; return d.TryGetValue(k, out v) && v != null ? Convert.ToDecimal(v) : dflt; }
  static Dictionary<string, object> Dict(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null; }
  static IEnumerable<object> List(Dictionary<string, object> d, string k) { object v; if (d.TryGetValue(k, out v) && v is object[]) return (object[]) v; return new object[0]; }
  static void Set(Action a) { try { a(); } catch { } }

  static void Json(HttpListenerContext ctx, int code, Dictionary<string, object> obj) {
    var bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(obj));
    ctx.Response.StatusCode = code;
    ctx.Response.ContentType = "application/json";
    ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
    ctx.Response.Close();
  }
}
