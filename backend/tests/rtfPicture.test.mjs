// The provable half of the FurtherDescription photo question.
//
// What this file CAN establish, and does: a JPEG survives the trip into RTF and
// back out of it byte for byte, the declared geometry is the JPEG's own and not
// a guess, and the reader recognises every picture form the RTF specification
// defines — including the ones this module deliberately refuses to WRITE.
//
// What no test here can establish: whether AutoCount RENDERS what we build.
// Nothing in this repository can open the licensed application. That step is
// docs/autocount-further-description-photos.md §5, and it is a host procedure,
// not an assertion.
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  AC_SYNC_MAX_BODY_BYTES,
  BLIPS,
  escapeRtfText,
  furtherDescriptionRtf,
  jpegDimensions,
  parseRtfPictures,
  rtfHex,
  rtfPayloadBytes,
  rtfPicture,
  stripNestedGroups,
} from '../scripts/lib/rtf-picture.mjs';

/* A REAL baseline JPEG, 24x16, 689 bytes — not a hand-assembled marker
   sequence. It has to be real: a fabricated header would let a dimension parser
   that reads the wrong offset pass, which is the one thing this fixture exists
   to prevent. Generated deterministically (a 24x16 PNG through `sips -s format
   jpeg`), then stripped of its APP1/APP13 metadata so the fixture stays small.
   Its frame header is FF C0 with height 0x0010 and width 0x0018. */
const JPEG_24x16 = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAAQABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAEC'
  + 'AwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAk'
  + 'M2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJ'
  + 'ipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3'
  + '+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEE'
  + 'BSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RV'
  + 'VldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbH'
  + 'yMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwAJCQkJCQkQCQkQFhAQEBYeFhYWFh4mHh4eHh4m'
  + 'LiYmJiYmJi4uLi4uLi4uNzc3Nzc3QEBAQEBISEhISEhISEhI/9sAQwELDAwSERIfEREfSzMqM0tLS0tLS0tL'
  + 'S0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tL/90ABAAC/9oADAMBAAIRAxEAPwDz'
  + '+HTfatWHTfauqh032rVh032rqq4/zOHAZntqcrDpvtVr+zfau1h032qz/ZvtXnyx+u59jRzP3Vqf/9k=',
  'base64',
));

/* Every extracted photograph the cutover recorded is at most 240x240 except
   nine of 744 (backend/scripts/data/ac-*-photo-manifest.json.gz), and the one
   photograph whose transfer size was ever MEASURED is 7,036 bytes — BUG-HISTORY,
   "Photos still rendered err after the bucket-name fix", where the proxy route
   answered `200 image/jpeg 7036 bytes`. That number is the only measured file
   size we have; everything sized from it is arithmetic, and the test says so. */
const MEASURED_PHOTO_BYTES = 7036;

describe('jpegDimensions', () => {
  test('reads the frame header of a real JPEG', () => {
    assert.deepEqual(jpegDimensions(JPEG_24x16), { width: 24, height: 16, marker: 0xc0 });
  });

  test('refuses anything that is not a JPEG rather than inventing a size', () => {
    for (const bad of [new Uint8Array(0), new Uint8Array([0xff]), new Uint8Array([0x89, 0x50, 0x4e, 0x47])]) {
      assert.throws(() => jpegDimensions(bad), /missing the SOI marker/);
    }
    assert.throws(() => jpegDimensions('/9j/'), TypeError);
  });

  test('does not read dimensions out of a Huffman table', () => {
    /* FF C4 sits inside the C0..CF range and is NOT a frame header. A parser
       that treats the whole range as SOF returns the first four bytes of a DHT
       segment as a size, which is plausible-looking garbage. Truncate the
       fixture just before its real SOF so only the DHT remains. */
    const sofAt = indexOfMarker(JPEG_24x16, 0xc0);
    assert.ok(sofAt > 0, 'fixture must contain an SOF0');
    assert.ok(indexOfMarker(JPEG_24x16, 0xc4) > 0, 'fixture must contain a DHT to make this case real');
    assert.throws(() => jpegDimensions(JPEG_24x16.slice(0, sofAt)), /no SOF frame header/);
  });
});

describe('rtfPicture', () => {
  test('declares the JPEG geometry and the twip goal from the given dpi', () => {
    const g = rtfPicture(JPEG_24x16, { blip: 'jpegblip', widthPx: 24, heightPx: 16, dpi: 96, bytesPerLine: 40 });
    assert.ok(g.startsWith('{\\pict\\jpegblip\\picw24\\pich16\\picwgoal360\\pichgoal240'), g.slice(0, 80));
    assert.ok(g.endsWith('}'));
    // 24px at 96dpi is a quarter inch, and a quarter of 1440 twips is 360.
    assert.equal(Math.round((24 * 1440) / 96), 360);
  });

  test('a different dpi is a different printed size, which is why dpi is required', () => {
    const at96 = rtfPicture(JPEG_24x16, { blip: 'jpegblip', widthPx: 24, heightPx: 16, dpi: 96, bytesPerLine: 40 });
    const at72 = rtfPicture(JPEG_24x16, { blip: 'jpegblip', widthPx: 24, heightPx: 16, dpi: 72, bytesPerLine: 40 });
    assert.ok(at96.includes('\\picwgoal360'));
    assert.ok(at72.includes('\\picwgoal480'));
    for (const bad of [{}, { dpi: 0 }, { dpi: -1 }, { dpi: NaN }]) {
      assert.throws(
        () => rtfPicture(JPEG_24x16, { blip: 'jpegblip', widthPx: 24, heightPx: 16, bytesPerLine: 40, ...bad }),
        TypeError,
      );
    }
  });

  test('REFUSES the forms it cannot honestly produce', () => {
    for (const blip of ['pngblip', 'wmetafile', 'dibitmap', 'emfblip']) {
      assert.equal(BLIPS[blip].producible, false);
      assert.throws(
        () => rtfPicture(JPEG_24x16, { blip, widthPx: 24, heightPx: 16, dpi: 96, bytesPerLine: 40 }),
        /cannot be produced here/,
        `${blip} must refuse rather than emit a JPEG under a metafile keyword`,
      );
    }
    assert.throws(() => rtfPicture(JPEG_24x16, { blip: 'tiffblip', widthPx: 24, heightPx: 16, dpi: 96, bytesPerLine: 40 }), /unknown picture form/);
  });

  test('hex is lowercase, wrapped, and exactly two characters per byte', () => {
    const hex = rtfHex(Uint8Array.from([0x00, 0x0f, 0xff, 0xa0]), { bytesPerLine: 2 });
    assert.equal(hex, '000f\nffa0');
    assert.equal(rtfHex(JPEG_24x16, { bytesPerLine: 40 }).replace(/\n/g, '').length, JPEG_24x16.length * 2);
    assert.throws(() => rtfHex(JPEG_24x16, { bytesPerLine: 0 }), TypeError);
  });
});

describe('the round trip', () => {
  test('a JPEG comes back out of the RTF byte for byte', () => {
    const rtf = furtherDescriptionRtf({
      text: '',
      pictures: [rtfPicture(JPEG_24x16, { blip: 'jpegblip', widthPx: 24, heightPx: 16, dpi: 96, bytesPerLine: 40 })],
    });
    const [pic] = parseRtfPictures(rtf);
    assert.equal(pic.blip, 'jpegblip');
    assert.equal(pic.oddHexDigit, false);
    assert.equal(pic.bytes.length, JPEG_24x16.length);
    assert.deepEqual([...pic.bytes], [...JPEG_24x16], 'the picture must survive the encode unchanged');
    // And the bytes that came back are still a JPEG of the same size.
    assert.deepEqual(jpegDimensions(pic.bytes), { width: 24, height: 16, marker: 0xc0 });
  });

  test('several photographs on one line each keep their own identity', () => {
    const other = JPEG_24x16.slice();
    other[other.length - 3] ^= 0x01;    // a different byte string, same length
    const rtf = furtherDescriptionRtf({
      text: 'RDS-5526 SOFA',
      pictures: [JPEG_24x16, other].map((b) => rtfPicture(b, {
        blip: 'jpegblip', widthPx: 24, heightPx: 16, dpi: 96, bytesPerLine: 40,
      })),
    });
    const pics = parseRtfPictures(rtf);
    assert.equal(pics.length, 2);
    assert.deepEqual([...pics[0].bytes], [...JPEG_24x16]);
    assert.deepEqual([...pics[1].bytes], [...other]);
    assert.notDeepEqual([...pics[0].bytes], [...pics[1].bytes]);
    assert.ok(rtf.includes('RDS-5526 SOFA'));
  });

  test('the document is a well-formed RTF group', () => {
    const rtf = furtherDescriptionRtf({
      text: 'x',
      pictures: [rtfPicture(JPEG_24x16, { blip: 'jpegblip', widthPx: 24, heightPx: 16, dpi: 96, bytesPerLine: 40 })],
    });
    assert.ok(rtf.startsWith('{\\rtf1\\ansi'));
    assert.ok(rtf.endsWith('}'));
    let depth = 0;
    let min = 0;
    for (let i = 0; i < rtf.length; i += 1) {
      if (rtf[i] === '\\') { i += 1; continue; }
      if (rtf[i] === '{') depth += 1;
      else if (rtf[i] === '}') { depth -= 1; min = Math.min(min, depth); }
    }
    assert.equal(depth, 0, 'braces must balance');
    assert.equal(min, 0, 'no group may close before it opens');
  });

  test('refuses to build an empty value', () => {
    assert.throws(() => furtherDescriptionRtf({ text: '', pictures: [] }), TypeError);
    assert.throws(() => furtherDescriptionRtf({ text: null, pictures: ['{\\pict}'] }), TypeError);
    assert.throws(() => furtherDescriptionRtf({ text: '', pictures: ['not a picture'] }), TypeError);
  });
});

describe('the reader, which is the half that settles the open question', () => {
  test('names the form AutoCount used, for every form the spec defines', () => {
    /* The point of this case: whatever the live book turns out to hold, the
       reader reports it rather than failing. Each of these is a hand-built
       group in one of the five forms, carrying the bytes DE AD BE EF. */
    const forms = [
      ['{\\pict\\jpegblip\\picw10\\pich10\\picwgoal150\\pichgoal150 deadbeef}', 'jpegblip', null],
      ['{\\pict\\pngblip\\picw10\\pich10 deadbeef}', 'pngblip', null],
      ['{\\pict\\emfblip\\picw10\\pich10 deadbeef}', 'emfblip', null],
      ['{\\pict\\wmetafile8\\picw10\\pich10\\picwgoal150\\pichgoal150 deadbeef}', 'wmetafile', 8],
      ['{\\pict\\dibitmap0\\picw10\\pich10 deadbeef}', 'dibitmap', 0],
    ];
    for (const [group, blip, arg] of forms) {
      const [p] = parseRtfPictures(`{\\rtf1\\ansi ${group}}`);
      assert.equal(p.blip, blip, group);
      assert.equal(p.blipArg, arg, group);
      assert.deepEqual([...p.bytes], [0xde, 0xad, 0xbe, 0xef], group);
    }
  });

  test('finds a picture wrapped in shppict/nonshppict, which is how Word writes one', () => {
    const rtf = '{\\rtf1\\ansi{\\*\\shppict{\\pict\\jpegblip\\picw10\\pich10 aabb}}'
      + '{\\nonshppict{\\pict\\wmetafile8\\picw10\\pich10 ccdd}}}';
    const pics = parseRtfPictures(rtf);
    assert.equal(pics.length, 2);
    assert.deepEqual(pics.map((p) => p.blip), ['jpegblip', 'wmetafile']);
    assert.deepEqual([...pics[0].bytes], [0xaa, 0xbb]);
    assert.deepEqual([...pics[1].bytes], [0xcc, 0xdd]);
  });

  test('a blipuid does not become part of the photograph', () => {
    /* Word and the Win32 RichEdit both emit `{\*\blipuid <32 hex digits>}`
       inside the picture group, right before the data. Those 32 characters are
       a legal hex run: a reader that takes everything after the last control
       word from the RAW text prepends 16 bytes of somebody's identifier to the
       picture and returns a file that is corrupt in a way no length check
       catches. Whatever the live book turns out to hold, this is the shape most
       likely to be in it. */
    const rtf = '{\\rtf1{\\pict\\wmetafile8\\picw10\\pich10'
      + '{\\*\\blipuid 0123456789abcdef0123456789abcdef}\n'
      + 'deadbeef}}';
    const [p] = parseRtfPictures(rtf);
    assert.equal(p.blip, 'wmetafile');
    assert.deepEqual([...p.bytes], [0xde, 0xad, 0xbe, 0xef], 'the uid must not be in the picture');
    assert.equal(p.hexChars, 8);
  });

  test('a picprop group before the data does not shift where the data starts', () => {
    const rtf = '{\\rtf1{\\pict{\\*\\picprop\\shplid1025{\\sp{\\sn fFlipV}{\\sv 0}}}'
      + '\\jpegblip\\picw10\\pich10 aabbcc}}';
    const [p] = parseRtfPictures(rtf);
    assert.equal(p.blip, 'jpegblip');
    assert.deepEqual([...p.bytes], [0xaa, 0xbb, 0xcc]);
  });

  test('stripNestedGroups keeps an unbalanced brace rather than eating the data', () => {
    assert.equal(stripNestedGroups('\\pict{\\*\\x 1}\\jpegblip aabb'), '\\pict\\jpegblip aabb');
    assert.equal(stripNestedGroups('\\pict{ aabb'), '\\pict{ aabb');
    assert.equal(stripNestedGroups('\\pict\\{literal\\} aabb'), '\\pict\\{literal\\} aabb');
  });

  test('an unrecognised group is reported as unrecognised, never as empty', () => {
    const [p] = parseRtfPictures('{\\rtf1{\\pict\\macpict\\picw10\\pich10 aabb}}');
    assert.equal(p.blip, null, 'a form this module does not know must read as null, not as a default');
    assert.deepEqual([...p.bytes], [0xaa, 0xbb], 'the bytes are still recoverable');
  });

  test('an odd hex digit count is surfaced, not silently rounded away', () => {
    const [p] = parseRtfPictures('{\\rtf1{\\pict\\jpegblip\\picw1\\pich1 aab}}');
    assert.equal(p.oddHexDigit, true);
    assert.equal(p.hexChars, 3);
    assert.deepEqual([...p.bytes], [0xaa]);
  });

  test('says so rather than guessing when a group is unterminated or binary', () => {
    assert.throws(() => parseRtfPictures('{\\rtf1{\\pict\\jpegblip\\picw1\\pich1 aabb'), /unterminated/);
    assert.throws(() => parseRtfPictures('{\\rtf1{\\pict\\jpegblip\\bin4 ....}}'), /\\bin/);
  });

  test('an RTF with no picture is an answer, not an error', () => {
    assert.deepEqual(parseRtfPictures('{\\rtf1\\ansi COL: J9883-2-Chic\\par}'), []);
    assert.deepEqual(parseRtfPictures(''), []);
    assert.deepEqual(parseRtfPictures(null), []);
  });
});

describe('what it costs on the wire', () => {
  test('hex doubles the picture, and the ceiling belongs to the document', () => {
    assert.equal(rtfPayloadBytes([MEASURED_PHOTO_BYTES]), MEASURED_PHOTO_BYTES * 2);
    /* The busiest sales order in the cutover manifest carries FIVE photographs
       (SO-012907). At the one size anyone has measured that is well inside
       AcSyncService's body ceiling — which is the useful shape of the answer:
       the limit is not what stops this working. */
    const busiest = rtfPayloadBytes(new Array(5).fill(MEASURED_PHOTO_BYTES));
    assert.equal(busiest, 70360);
    assert.ok(busiest < AC_SYNC_MAX_BODY_BYTES / 10, `${busiest} must be comfortably under ${AC_SYNC_MAX_BODY_BYTES}`);
  });

  test('the ceiling is the one AcSyncService actually enforces', () => {
    // AcSyncService.cs:149 — `const int MaxBody = 2 * 1024 * 1024;`
    assert.equal(AC_SYNC_MAX_BODY_BYTES, 2 * 1024 * 1024);
  });

  test('a photograph big enough to matter is refused by arithmetic before it is sent', () => {
    assert.ok(rtfPayloadBytes([1_100_000]) > AC_SYNC_MAX_BODY_BYTES);
    assert.throws(() => rtfPayloadBytes([1.5]), TypeError);
    assert.throws(() => rtfPayloadBytes('7036'), TypeError);
  });
});

describe('escapeRtfText', () => {
  test('escapes the three characters that would otherwise be structure', () => {
    assert.equal(escapeRtfText('a\\b{c}d'), 'a\\\\b\\{c\\}d');
  });

  test('a newline becomes a paragraph and a non-ASCII character becomes \\uN?', () => {
    assert.equal(escapeRtfText('a\nb'), 'a\\par\nb');
    assert.equal(escapeRtfText('沙'), '\\u27801?');
  });
});

/** Offset of the `FF <marker>` pair, or -1. Test-local: the fixture is known. */
function indexOfMarker(bytes, marker) {
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === marker) return i;
  }
  return -1;
}
