#!/usr/bin/env python3
"""Regenerate the four PDF Noto Sans SC subsets under frontend/public/fonts.

These .ttf are the faces jsPDF embeds for any document text outside WinAnsi
(see frontend/src/vendor/scm/lib/pdf-common.ts). They are checked-in binaries
with no other build step, so this script IS their provenance. It preserves every
codepoint the current subsets carry and adds Latin Extended-A (U+0100-U+017F) to
both tiers, so romaji long vowels (the "AKEMI KORI" range, HC-PCO-2610-001) and
the like print with their macron instead of refusing or folding to ASCII.

Source font: Noto Sans SC variable font, Version 2.004, from google/fonts:
  https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf
Toolchain: Python 3 + fonttools (`pip install fonttools`; TTF-only, no brotli).

Usage:
  python frontend/scripts/regen-pdf-font-subsets.py path/to/NotoSansSC[wght].ttf

It instances the VF at wght 400/700, subsets each to its tier's set, writes the
four files, and verifies no existing glyph was dropped and every macron is kept.

/fonts/* is served immutable for a year, so each file is named
noto-sans-sc-<tier>-<weight>.<sha256[:8]>.ttf and a changed face gets a new
name (an in-place rewrite never reached browsers that had printed before,
2026-10-20). Repoint TIER_FACES in pdf-common.ts to the names printed below.
"""
import glob
import hashlib
import os
import sys
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib import instancer

LATIN_EXT_A = set(range(0x0100, 0x0180))
MACRONS = {0x0100, 0x0101, 0x0112, 0x0113, 0x012A, 0x012B, 0x014C, 0x014D, 0x016A, 0x016B}
KEEP_TABLES = {'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'OS/2', 'post'}
TIERS = {
    'punct': ['noto-sans-sc-punct-400', 'noto-sans-sc-punct-700'],
    'hanzi': ['noto-sans-sc-hanzi-400', 'noto-sans-sc-hanzi-700'],
}
WEIGHT_OF = {'400': 400, '700': 700}

FONT_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'public', 'fonts'))


def current_file(stem):
    found = glob.glob(os.path.join(FONT_DIR, f'{stem}.*.ttf'))
    if len(found) != 1:
        sys.exit(f'ABORT: expected exactly one {stem}.<sha8>.ttf in {FONT_DIR}, found {len(found)}.')
    return found[0]


def cmap_set(path):
    return set(TTFont(path, lazy=True).getBestCmap().keys())


def subset_options():
    o = subset.Options()
    o.hinting = False          # the originals carry no fpgm/prep/cvt, no glyf instructions
    o.glyph_names = False       # post format 3.0, like the originals
    o.layout_features = []      # drop GSUB/GPOS (the originals have none)
    o.notdef_outline = False
    o.recalc_timestamp = False
    o.ignore_missing_unicodes = True   # Latin Ext-A codepoints absent from the VF are skipped
    o.name_IDs = ['*']
    return o


def main(vf_path):
    vf_cps = cmap_set(vf_path)
    if not MACRONS.issubset(vf_cps):
        sys.exit('ABORT: source font lacks macron letters; aborting rather than shipping a fallback face.')
    latin_present = sorted(c for c in LATIN_EXT_A if c in vf_cps)

    target = {}
    for tier, files in TIERS.items():
        existing = set()
        for stem in files:
            existing |= cmap_set(current_file(stem))
        dropped = sorted(existing - vf_cps)
        if dropped:
            sys.exit(f'ABORT {tier}: source would drop {len(dropped)} existing codepoints.')
        target[tier] = existing | set(latin_present)

    for tier, files in TIERS.items():
        for stem in files:
            w = WEIGHT_OF[stem.rsplit('-', 1)[1]]
            old = current_file(stem)
            before = os.path.getsize(old)
            out = os.path.join(FONT_DIR, f'{stem}.tmp.ttf')
            f = TTFont(vf_path, recalcTimestamp=False)   # else save() stamps head.modified = now
            instancer.instantiateVariableFont(f, {'wght': w}, inplace=True)
            ss = subset.Subsetter(options=subset_options())
            ss.populate(unicodes=sorted(target[tier]))
            ss.subset(f)
            for tag in [t for t in f.keys() if t not in KEEP_TABLES and t != 'GlyphOrder']:
                del f[tag]
            # Pin the save timestamp so the output is byte-stable run to run
            # (otherwise head.modified is "now" and every regen shows a diff).
            f['head'].modified = f['head'].created
            f.save(out)
            got = cmap_set(out)
            if not MACRONS.issubset(got) or (target[tier] - set(latin_present)) - got:
                sys.exit(f'ABORT: {stem} failed verification after subsetting.')
            with open(out, 'rb') as fh:
                fn = f'{stem}.{hashlib.sha256(fh.read()).hexdigest()[:8]}.ttf'
            os.remove(old)
            os.replace(out, os.path.join(FONT_DIR, fn))
            print(f'{fn}: {before} -> {os.path.getsize(os.path.join(FONT_DIR, fn))} bytes, {len(got)} codepoints')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: python frontend/scripts/regen-pdf-font-subsets.py path/to/NotoSansSC[wght].ttf')
    main(sys.argv[1])
