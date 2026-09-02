# -*- coding: utf-8 -*-
"""
export-ac-line-photos.py — pull EVERY line photograph out of the live AED_HOUZS
book and lay it on disk as a JPEG, with a manifest the round-1 attach scripts
already know how to read.

READ-ONLY against AutoCount. It issues `SELECT` only, opens no ERP database,
and holds no credential beyond the password file AC_CRED_FILE names. It never
prints that password.

WHAT THIS IS FOR
  Round 1 (2026-08-09..12) extracted 554 SO + 190 PO images and uploaded them
  to R2 under deterministic keys. The BOOK holds more than that, and — the part
  that actually forced this script — **the round-1 extractor was not kept**
  (docs/autocount-further-description-photos.md §2.1). There was no way to take
  the photographs out again. This is that missing half, written down.

  Pipeline, end to end (docs/ac-resync-runbook.md 阶段 3b):
      export (this script)  ->  upload-line-photos-r2.mjs  ->
      import-so-line-photos.mjs / import-po-line-photos.mjs APPLY=1  ->  verify

WHAT IT DOES *NOT* REUSE, AND WHY THAT IS SAID OUT LOUD
  The RTF READER is reused, not reimplemented: every picture group is taken out
  by `backend/scripts/further-description-rtf.mjs inspect --extract`, which is
  the tested reader (backend/tests/rtfPicture.test.mjs) and carries the guards
  that fail QUIETLY otherwise — the `{\\*\\blipuid}` sub-group that prepends 16
  bytes of somebody's identifier, and the odd-hex-nibble case.

  There is **no WMF->raster path in this repository to reuse.** That was checked
  before it was written, not assumed: `rtf-picture.mjs` declares `wmetafile`
  `producible: false` and says in its own header that a metafile "needs the JPEG
  decoded to pixels", and `docs/autocount-further-description-photos.md` §3
  records that this repo carries no image library at all. The book stores
  `\\wmetafile8` (§4.2, measured on three live lines). So `wmf_to_jpeg()` below
  is NEW code, and it is the only new decoding in this file.

  It reproduces round 1's stated path — `WMF -> DIB -> JPEG` — by lifting the
  device-independent bitmap straight out of the metafile record and letting
  Pillow re-encode it. That keeps the ORIGINAL pixels at their original size:
  no GDI, no rendering dpi to choose, no resampling. Pillow's own WMF renderer
  (Windows GDI) is the FALLBACK, used only when a metafile carries no DIB
  record, and every use of it is counted and printed — a fallback nobody counts
  is a fallback nobody notices.

SELF-TEST ON STARTUP
  The DIB scanner is a matcher, and CLAUDE.md's rule is that a checker which
  cannot match must refuse rather than report a clean run. `_self_test()` builds
  a 2x2 metafile in memory, runs the real scanner over it, and exits 3 if the
  round trip does not come back. A silent zero here would otherwise read exactly
  like "the book holds no photographs".

RESUME
  Interrupt it and run it again — the ZeroTier link drops, and the RTF is heavy
  (one measured value is 458,878 bytes for ONE line). Per side it keeps
  `<OUT_DIR>/<side>/.done.jsonl` (one manifest row per extracted image) and
  `<OUT_DIR>/<side>/.state.json` (the highest DtlKey finished). A second run
  starts at `DtlKey > checkpoint`, so the rows already done are never fetched
  again — the saving is the download, which is the expensive part.

  RE-RUN: idempotent. A second run with nothing new to do re-reads the sidecar,
  rewrites the manifest from it, prints `new: 0`, and touches no other file. It
  never deletes a JPEG. FORCE=1 re-extracts from the top, overwriting the JPEGs
  and rebuilding both sidecars.

Env:  AC_HOST (default 10.147.17.100,55500)   AC_DB (default AED_HOUZS)
      AC_USER (default sa2)                   AC_CRED_FILE (password file, required)
      OUT_DIR  (default: this script's data/line-photos)
      SIDE     so | po | both               (default both)
      LIMIT    stop after N lines per side  (default 0 = every line)
      FORCE    1 = ignore the checkpoint and re-extract           (default off)
      BATCH    lines fetched per round trip (default 25)

Usage:
  AC_CRED_FILE=<path> python backend/scripts/export-ac-line-photos.py
  AC_CRED_FILE=<path> SIDE=so LIMIT=20 python backend/scripts/export-ac-line-photos.py
"""
import gzip
import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import tempfile

# ── configuration ──────────────────────────────────────────────────────────
HOST = os.environ.get("AC_HOST", "10.147.17.100,55500")
DB = os.environ.get("AC_DB", "AED_HOUZS")
USER = os.environ.get("AC_USER", "sa2")
CRED = os.environ.get("AC_CRED_FILE")
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_BACKEND = os.path.dirname(HERE)
OUT = os.environ.get("OUT_DIR", os.path.join(HERE, "data", "line-photos"))
SIDE = os.environ.get("SIDE", "both").lower()
LIMIT = int(os.environ.get("LIMIT", "0") or 0)
FORCE = os.environ.get("FORCE") == "1"
BATCH = int(os.environ.get("BATCH", "25") or 25)
RTF_CLI = os.path.join(HERE, "further-description-rtf.mjs")

# The two document sides. Header table, detail table, and the manifest the
# round-1 attach script reads for that side — the names are NOT invented here,
# they are what import-so-line-photos.mjs / import-po-line-photos.mjs open.
SIDES = {
    "so": {"hdr": "SO", "dtl": "SODTL", "manifest": "ac-photo-manifest.json.gz", "desc2": False},
    "po": {"hdr": "PO", "dtl": "PODTL", "manifest": "ac-po-photo-manifest.json.gz", "desc2": True},
}


def log(msg):
    print(msg, flush=True)


# ── WMF -> DIB -> JPEG ─────────────────────────────────────────────────────
# The metafile records that can carry a device-independent bitmap. Values are
# from the WMF specification's RecordFunction enumeration.
DIB_RECORDS = {
    0x0F43: "META_STRETCHDIB",
    0x0B41: "META_DIBSTRETCHBLT",
    0x0D33: "META_SETDIBITSTODEVICE",
    0x0940: "META_DIBBITBLT",
}
# Header sizes a BITMAPINFOHEADER may declare. 12 is the OS/2 BITMAPCOREHEADER;
# 40 is the one AutoCount's metafiles actually carry; 52/56/108/124 are the
# later V2..V5 extensions, accepted so a newer writer does not fall to GDI.
DIB_HEADER_SIZES = (12, 40, 52, 56, 108, 124)
BI_RGB, BI_BITFIELDS = 0, 3


def _dib_is_plausible(buf, off):
    """True when `off` looks like the start of a real DIB header.

    Guessing a record's parameter layout is how this goes wrong quietly: the
    DIB sits at a different offset in each of the four record types, and a
    variant without a source bitmap has no DIB at all. So the offset is not
    computed from the record type — it is FOUND, by validating the candidate
    header. Width, height, planes and bit count are all constrained, which is
    what makes a false positive implausible rather than merely unlikely.
    """
    if off + 16 > len(buf):
        return False
    (size,) = struct.unpack_from("<I", buf, off)
    if size not in DIB_HEADER_SIZES:
        return False
    if size == 12:
        w, h, planes, bpp = struct.unpack_from("<hhHH", buf, off + 4)
    else:
        w, h, planes, bpp = struct.unpack_from("<iiHH", buf, off + 4)
    if planes != 1 or bpp not in (1, 4, 8, 16, 24, 32):
        return False
    # Height is signed: negative means a top-down bitmap, which is legal.
    return 0 < w <= 20000 and 0 < abs(h) <= 20000


def _dib_to_bmp(dib):
    """Wrap raw DIB bytes in the 14-byte BITMAPFILEHEADER that makes a .bmp.

    The only arithmetic here is where the pixels start, and getting it wrong
    shifts the whole image rather than failing — hence the palette rules being
    spelled out instead of assumed.
    """
    (size,) = struct.unpack_from("<I", dib, 0)
    if size == 12:
        bpp = struct.unpack_from("<H", dib, 10)[0]
        clr_used, compression = 0, BI_RGB
        entry = 3  # BITMAPCOREHEADER palettes are RGBTRIPLE, not RGBQUAD
    else:
        bpp = struct.unpack_from("<H", dib, 14)[0]
        compression = struct.unpack_from("<I", dib, 16)[0]
        clr_used = struct.unpack_from("<I", dib, 32)[0]
        entry = 4
    palette = clr_used if clr_used else (1 << bpp if bpp <= 8 else 0)
    offset = 14 + size + palette * entry
    # BI_BITFIELDS on a v1 header puts three 4-byte masks before the pixels.
    if compression == BI_BITFIELDS and size == 40:
        offset += 12
    return b"BM" + struct.pack("<IHHI", 14 + len(dib), 0, 0, offset) + dib


def extract_dibs(wmf):
    """Every DIB inside a Windows metafile, in record order.

    Walks the record list rather than scanning the whole file for a header
    pattern: a record length tells us where the next record starts, so a
    candidate found INSIDE the pixel data of a preceding record cannot be
    mistaken for a new image.
    """
    pos = 0
    # A placeable metafile prefixes 22 bytes before the real header.
    if len(wmf) >= 4 and struct.unpack_from("<I", wmf, 0)[0] == 0x9AC6CDD7:
        pos = 22
    if len(wmf) < pos + 18:
        return []
    pos += 18  # METAHEADER
    out = []
    while pos + 6 <= len(wmf):
        rec_words, func = struct.unpack_from("<IH", wmf, pos)
        rec_bytes = rec_words * 2
        if rec_bytes < 6 or pos + rec_bytes > len(wmf):
            break  # truncated or not a record boundary — stop, do not guess
        if func in DIB_RECORDS:
            end = pos + rec_bytes
            # The DIB is somewhere in the parameters; find the header rather
            # than trusting a per-record offset table.
            for off in range(pos + 6, min(pos + 40, end)):
                if _dib_is_plausible(wmf, off):
                    out.append(wmf[off:end])
                    break
        if func == 0x0000:  # META_EOF
            break
        pos += rec_bytes
    return out


def wmf_to_jpeg(wmf, quality=92):
    """(jpeg_bytes, width, height, how) for one metafile.

    `how` is 'dib' when the original pixels were lifted straight out, and
    'gdi-render' when Pillow had to rasterise the metafile instead. The caller
    counts the second kind: it is a different picture from the one AutoCount
    stored, even when it looks identical.
    """
    from PIL import Image

    for dib in extract_dibs(wmf):
        try:
            img = Image.open(io.BytesIO(_dib_to_bmp(dib)))
            img.load()
        except Exception:
            continue  # a record that validated but does not decode is not a find
        return _encode_jpeg(img, quality) + ("dib",)
    # No DIB record: rasterise. Windows-only (Pillow needs GDI for this), which
    # is fine — the book is reachable from this machine and nowhere else.
    img = Image.open(io.BytesIO(wmf))
    img.load()
    return _encode_jpeg(img, quality) + ("gdi-render",)


def _encode_jpeg(img, quality):
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue(), img.width, img.height


def raster_to_jpeg(raw, quality=92):
    """A picture group that was already a raster (jpegblip / pngblip / dibitmap).

    A JPEG is passed through untouched — re-encoding it would lose quality for
    no reason and break byte-for-byte comparison against the round-1 files.
    """
    from PIL import Image

    if raw[:3] == b"\xff\xd8\xff":
        img = Image.open(io.BytesIO(raw))
        img.load()
        return raw, img.width, img.height, "passthrough"
    img = Image.open(io.BytesIO(raw))
    img.load()
    return _encode_jpeg(img, quality) + ("re-encode",)


def _self_test():
    """Prove the DIB scanner is alive before trusting a zero from it."""
    try:
        from PIL import Image  # noqa: F401
    except Exception as e:
        log("SELF-TEST FAILED: Pillow is not importable (%s). pip install Pillow" % e)
        sys.exit(3)
    # A 2x2 24-bit bottom-up DIB: header, then two padded rows.
    hdr = struct.pack("<IiiHHIIiiII", 40, 2, 2, 1, 24, BI_RGB, 16, 2835, 2835, 0, 0)
    pixels = bytes([0, 0, 255, 0, 255, 0, 0, 0]) + bytes([255, 0, 0, 255, 255, 255, 0, 0])
    dib = hdr + pixels
    params = struct.pack("<IHhhhhhhhh", 0x00CC0020, 0, 2, 2, 0, 0, 2, 2, 0, 0)
    body = params + dib
    rec = struct.pack("<IH", (6 + len(body)) // 2, 0x0F43) + body
    wmf = struct.pack("<HHHIHIH", 1, 9, 0x0300, 0, 0, 0, 0) + rec + struct.pack("<IH", 3, 0)
    found = extract_dibs(wmf)
    if len(found) != 1 or found[0][:4] != dib[:4]:
        log("SELF-TEST FAILED: the DIB scanner found %d bitmaps in a metafile holding 1." % len(found))
        log("  Refusing to run: a scanner that cannot match reports an empty book as a clean one.")
        sys.exit(3)
    jpeg, w, h, how = wmf_to_jpeg(wmf)
    if how != "dib" or (w, h) != (2, 2) or jpeg[:3] != b"\xff\xd8\xff":
        log("SELF-TEST FAILED: round trip gave how=%s size=%sx%s" % (how, w, h))
        sys.exit(3)
    log("self-test: DIB scanner OK (2x2 metafile -> %d-byte JPEG via %s)" % (len(jpeg), how))


# ── RTF -> picture bytes, via the tested reader ────────────────────────────
def pictures_of(rtf_text, tmpdir):
    """Every picture in one FurtherDescription, as (bytes, form).

    Shells out to further-description-rtf.mjs rather than re-parsing RTF here.
    That CLI is the half this repository already tests, and its guards — the
    `\\*\\blipuid` sub-group, the odd hex nibble — are exactly the failures that
    would otherwise produce a corrupt file no length check notices.
    """
    src = os.path.join(tmpdir, "value.rtf")
    with open(src, "w", encoding="utf-8") as fh:
        fh.write(rtf_text)
    dst = os.path.join(tmpdir, "out")
    proc = subprocess.run(
        ["node", RTF_CLI, "inspect", src, "--extract", dst],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("further-description-rtf.mjs exited %d: %s" % (proc.returncode, proc.stderr.strip()[:200]))
    forms, files = [], []
    for line in proc.stdout.splitlines():
        s = line.strip()
        if s.startswith("[") and "form=" in s:
            forms.append(s.split("form=", 1)[1].strip())
        elif s.startswith("-> "):
            files.append(s[3:].strip())
    out = []
    for i, path in enumerate(files):
        with open(path, "rb") as fh:
            out.append((fh.read(), forms[i] if i < len(forms) else "?"))
    return out


def to_jpeg(raw, form):
    if form.startswith("wmetafile") or form.startswith("emfblip"):
        return wmf_to_jpeg(raw)
    return raster_to_jpeg(raw)


# ── sidecars ───────────────────────────────────────────────────────────────
def side_dir(side):
    d = os.path.join(OUT, side)
    os.makedirs(d, exist_ok=True)
    return d


def load_done(side):
    """Rows already extracted, plus the DtlKey to resume after."""
    path = os.path.join(side_dir(side), ".done.jsonl")
    rows = []
    if os.path.exists(path) and not FORCE:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        # A run killed mid-write leaves a half line. Drop it and
                        # let the checkpoint re-fetch that DtlKey.
                        log("  (dropping a truncated sidecar line -- its line will be re-fetched)")
    state_path = os.path.join(side_dir(side), ".state.json")
    checkpoint = 0
    if os.path.exists(state_path) and not FORCE:
        try:
            checkpoint = int(json.load(open(state_path))["last_dtlkey"])
        except Exception:
            checkpoint = 0
    if FORCE:
        for p in (path, state_path):
            if os.path.exists(p):
                os.remove(p)
    return rows, checkpoint


def append_done(side, rows):
    with open(os.path.join(side_dir(side), ".done.jsonl"), "a", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")


def save_checkpoint(side, dtlkey):
    with open(os.path.join(side_dir(side), ".state.json"), "w", encoding="utf-8") as fh:
        json.dump({"last_dtlkey": int(dtlkey)}, fh)


def write_manifest(side, rows):
    """Rebuild the side's manifest from the sidecar, newest wins on DtlKey+n.

    Written on every flush, not only at the end: an interrupted run must still
    leave a manifest that matches the JPEGs on disk.
    """
    seen, ordered = set(), []
    for r in rows:
        if r["file"] in seen:
            continue
        seen.add(r["file"])
        ordered.append(r)
    ordered.sort(key=lambda r: (r["DtlKey"], r["file"]))
    path = os.path.join(OUT, SIDES[side]["manifest"])
    with gzip.open(path, "wb") as fh:
        fh.write(json.dumps(ordered, ensure_ascii=False).encode("utf-8"))
    return path, len(ordered)


# ── the export ─────────────────────────────────────────────────────────────
def export_side(cn, side):
    cfg = SIDES[side]
    done, checkpoint = load_done(side)
    have = {r["file"] for r in done}
    log("")
    log("== %s ==  already extracted: %d image(s); resuming after DtlKey %d"
        % (side.upper(), len(done), checkpoint))

    desc2 = ", ISNULL(d.Desc2,'') AS Desc2" if cfg["desc2"] else ""
    sql = (
        "SELECT TOP %d LTRIM(RTRIM(h.DocNo)) AS DocNo, d.DtlKey, "
        "LTRIM(RTRIM(ISNULL(d.ItemCode,''))) AS ItemCode%s, d.FurtherDescription "
        "FROM %s d JOIN %s h ON h.DocKey = d.DocKey "
        "WHERE d.FurtherDescription IS NOT NULL "
        "AND d.FurtherDescription LIKE '%%{\\pict%%' "
        "AND h.DocNo NOT LIKE 'HC-%%' AND h.DocNo NOT LIKE 'ZZ%%' "
        "AND d.DtlKey > ? ORDER BY d.DtlKey"
    ) % (BATCH, desc2, cfg["dtl"], cfg["hdr"])

    seen_lines, new_rows, forms, hows, failures = 0, 0, {}, {}, []
    pending = []
    while True:
        cur = cn.cursor()
        cur.execute(sql, checkpoint)
        batch = cur.fetchall()
        cur.close()
        if not batch:
            break
        for row in batch:
            doc_no, dtlkey, item_code = row[0], int(row[1]), row[2]
            d2 = row[3] if cfg["desc2"] else None
            rtf = row[-1]
            checkpoint = dtlkey
            seen_lines += 1
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    pics = pictures_of(rtf, tmp)
                    for i, (raw, form) in enumerate(pics, start=1):
                        forms[form] = forms.get(form, 0) + 1
                        name = "%s__%d_%d.jpg" % (doc_no, dtlkey, i)
                        dst = os.path.join(side_dir(side), name)
                        if name in have and os.path.exists(dst) and not FORCE:
                            continue
                        jpeg, w, h, how = to_jpeg(raw, form)
                        hows[how] = hows.get(how, 0) + 1
                        with open(dst, "wb") as fh:
                            fh.write(jpeg)
                        rec = {
                            "DocNo": doc_no, "DtlKey": dtlkey, "ItemCode": item_code,
                            "file": name, "sha256": hashlib.sha256(jpeg).hexdigest(),
                            "bytes": len(jpeg), "w": w, "h": h,
                        }
                        if cfg["desc2"]:
                            rec["Desc2"] = d2
                        pending.append(rec)
                        done.append(rec)
                        have.add(name)
                        new_rows += 1
            except Exception as e:
                # One bad line must not cost the other 2,000. Named, not counted.
                failures.append((doc_no, dtlkey, str(e)[:160]))
                log("  !! %s DtlKey=%d could not be extracted: %s" % (doc_no, dtlkey, str(e)[:160]))
            if seen_lines % 100 == 0:
                append_done(side, pending)
                pending = []
                save_checkpoint(side, checkpoint)
                write_manifest(side, done)
                log("  ... %d lines read, %d images written (DtlKey %d)" % (seen_lines, new_rows, checkpoint))
            if LIMIT and seen_lines >= LIMIT:
                break
        if LIMIT and seen_lines >= LIMIT:
            break

    append_done(side, pending)
    save_checkpoint(side, checkpoint)
    path, total = write_manifest(side, done)
    log("  lines read this run: %d; images written this run: %d" % (seen_lines, new_rows))
    log("  picture forms: %s" % (", ".join("%s=%d" % kv for kv in sorted(forms.items())) or "(none)"))
    log("  conversion:    %s" % (", ".join("%s=%d" % kv for kv in sorted(hows.items())) or "(none)"))
    if hows.get("gdi-render"):
        log("  NOTE: %d metafile(s) carried no DIB and were RASTERISED by GDI -- those pixels are"
            % hows["gdi-render"])
        log("        ours, not AutoCount's. Worth an eye before they are uploaded.")
    if failures:
        log("  FAILED lines: %d" % len(failures))
        for doc_no, dtlkey, err in failures[:20]:
            log("    %s DtlKey=%d: %s" % (doc_no, dtlkey, err))
    log("  manifest: %s (%d image rows, the whole side including earlier runs)" % (path, total))
    return {"lines": seen_lines, "new": new_rows, "total": total, "failed": len(failures)}


def main():
    if SIDE not in ("so", "po", "both"):
        log("SIDE must be so | po | both (got %r)" % SIDE)
        sys.exit(2)
    if not CRED or not os.path.exists(CRED):
        log("AC_CRED_FILE must point at a file holding only the DB password")
        sys.exit(2)
    if not os.path.exists(RTF_CLI):
        log("missing the RTF reader: %s" % RTF_CLI)
        sys.exit(2)
    _self_test()

    import pyodbc

    pwd = open(CRED).read().strip()
    cn = pyodbc.connect(
        "DRIVER={SQL Server Native Client 11.0};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s" % (HOST, DB, USER, pwd),
        timeout=30,
    )
    os.makedirs(OUT, exist_ok=True)
    log("book=%s@%s  out=%s  mode=%s%s" % (DB, HOST, OUT, "FORCE re-extract" if FORCE else "resume",
                                           "  LIMIT=%d/side" % LIMIT if LIMIT else ""))
    result = {}
    for side in (["so", "po"] if SIDE == "both" else [SIDE]):
        result[side] = export_side(cn, side)
    cn.close()
    log("")
    log("EXPORT DONE. " + "; ".join(
        "%s: %d new image(s), %d in manifest, %d failed line(s)" % (s.upper(), r["new"], r["total"], r["failed"])
        for s, r in result.items()))
    _swap_advice(result)
    log("")
    log("Next: upload with backend/scripts/upload-line-photos-r2.mjs, then attach with")
    log("      import-so-line-photos.mjs / import-po-line-photos.mjs (APPLY=1).")
    if any(r["failed"] for r in result.values()):
        sys.exit(1)


def _swap_advice(result):
    """Say whether this manifest is fit to REPLACE the round-1 snapshot.

    The attach scripts read `data/<manifest>`, not this run's output, so a new
    manifest only reaches them when a human swaps it in — deliberately, as a
    reviewed commit, which is the rule every other snapshot here follows.

    A partial run must never be swapped in. `LIMIT=20` produces a perfectly
    valid 20-row manifest, and a 20-row manifest dropped over the round-1 file
    silently un-plans 534 photographs. So the comparison is made HERE, where the
    counts are, rather than left to whoever reads the runbook at 2am.
    """
    live_dir = os.path.join(HERE, "data")
    log("")
    for side, r in result.items():
        name = SIDES[side]["manifest"]
        mine = os.path.join(OUT, name)
        live = os.path.join(live_dir, name)
        if os.path.abspath(mine) == os.path.abspath(live):
            log("  %s: written straight over %s (OUT_DIR is the live data dir)" % (side.upper(), name))
            continue
        old = None
        if os.path.exists(live):
            try:
                old = len(json.loads(gzip.open(live, "rb").read().decode("utf-8")))
            except Exception:
                old = None
        if LIMIT:
            log("  %s: LIMIT was set, so this is a PARTIAL manifest (%d rows). DO NOT swap it in."
                % (side.upper(), r["total"]))
        elif old is not None and r["total"] < old:
            log("  %s: this run has %d rows, the one in data/ has %d. FEWER -- do NOT swap it in"
                % (side.upper(), r["total"], old))
            log("        until you know why; a short manifest silently un-plans photographs.")
        else:
            log("  %s: %d rows%s. To let the attach scripts see them, swap the snapshot in"
                % (side.upper(), r["total"], "" if old is None else " vs %d in data/" % old))
            log("        and commit it (the snapshot rule: replace whole, add a ledger line):")
            log("        cp %s %s" % (mine, live))


if __name__ == "__main__":
    main()
