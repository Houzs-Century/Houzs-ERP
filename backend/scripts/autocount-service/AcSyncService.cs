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
        // transferMaster MUST be true on the purchase side. That flag copies the
        // source PO's header master (supplier/currency/terms) onto the target; with
        // false the GRN is built with no supplier, the purchase detail ctor looks
        // that row up in the master table, IndexOf returns -1, and Save() dies with
        // "there is no row at position -1". The sales classes tolerate false, so they
        // are left alone — DO-011260 and DO-011262 were both created that way.
        //
        // This comment said "DO and IV are PROVEN with it" and cited those same two
        // numbers. Both are DELIVERY ORDER numbers; the IV half had nothing behind it
        // and /do-to-iv has still never run. Run status does not belong in a comment:
        // docs/generated/autocount-coverage.md is the one place that states it.
        doc.AddPartialTransferDetail(fromType, dtlKeys, true);
        PurchaseHeader(doc, p);
        Set(() => doc.SupplierDONo = Str(p, "SupplierDONo"));
        doc.Save();
        return doc.DocNo;
      }
      case "PI": {
        var cmd = AutoCount.Invoicing.Purchase.PurchaseInvoice.PurchaseInvoiceCommand.Create(s, s.DBSetting);
        var doc = cmd.AddNew();
        // see the GR case above — purchase side needs transferMaster = true
        doc.AddPartialTransferDetail(fromType, dtlKeys, true);
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
    foreach (var k in keys) po.AddSOToPOTransferDetail(k);
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

  static void SalesHeader(dynamic doc, Dictionary<string, object> p) {
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
