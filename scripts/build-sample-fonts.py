"""Regenerate the sample project's subset web fonts (development helper; not needed to run the app).

Usage: python3 scripts/build-sample-fonts.py <font-source-dir> <output-dir>
Requires fontTools. Produces WOFF files subset to Latin, plus a LICENSE listing each font's
copyright and license fields from the font's own name table (all are SIL Open Font License fonts).
"""
import os, sys
from fontTools import subset
from fontTools.ttLib import TTFont

SOURCES = [
    ("opentype/inter/Inter-Regular.otf", "inter-regular.woff"),
    ("opentype/inter/Inter-SemiBold.otf", "inter-semibold.woff"),
    ("truetype/google-fonts/Poppins-Bold.ttf", "poppins-bold.woff"),
]
# Lora declares a Reserved Font Name, so it is copied unmodified (subsetting would be a modification).
UNMODIFIED = [
    ("truetype/google-fonts/Lora-Variable.ttf", "Lora-Variable.ttf"),
    ("truetype/google-fonts/Lora-Italic-Variable.ttf", "Lora-Italic-Variable.ttf"),
]
UNICODES = "U+0020-007E,U+00A0-00FF,U+2013,U+2014,U+2018,U+2019,U+201C,U+201D,U+2022,U+2026,U+2192,U+00B7,U+2122"

def main(src_root, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    notes = []
    for rel, out_name in SOURCES:
        src = os.path.join(src_root, rel)
        options = subset.Options()
        options.flavor = "woff"
        options.layout_features = ["kern", "liga", "calt", "tnum", "case"]
        options.name_IDs = ["*"]
        options.notdef_outline = True
        font = TTFont(src)
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
        subsetter.subset(font)
        font.flavor = "woff"
        out = os.path.join(out_dir, out_name)
        font.save(out)
        name = font["name"]
        get = lambda i: (name.getDebugName(i) or "").strip()
        notes.append(f"{out_name}\n  Family: {get(1)} {get(2)}\n  {get(0)}\n  License: {get(13) or 'SIL Open Font License 1.1'}\n  License URL: {get(14) or 'https://openfontlicense.org'}\n")
        print(out_name, os.path.getsize(out))
    import shutil
    for rel, out_name in UNMODIFIED:
        src = os.path.join(src_root, rel)
        shutil.copyfile(src, os.path.join(out_dir, out_name))
        font = TTFont(src)
        name = font["name"]
        get = lambda i: (name.getDebugName(i) or "").strip()
        notes.append(f"{out_name} (unmodified)\n  Family: {get(1)} {get(2)}\n  {get(0)}\n  License: {get(13) or 'SIL Open Font License 1.1'}\n  License URL: {get(14) or 'https://openfontlicense.org'}\n")
    with open(os.path.join(out_dir, "LICENSE.txt"), "w") as fh:
        fh.write("Fonts in this folder are subsets of fonts licensed under the SIL Open Font License, Version 1.1.\n")
        fh.write("Full license text: https://openfontlicense.org\n\n")
        fh.write("\n".join(notes))

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
