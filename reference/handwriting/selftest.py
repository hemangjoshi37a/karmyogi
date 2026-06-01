#!/usr/bin/env python3.13
# tools/handwriting/selftest.py
#
# End-to-end self-test of the handwriting font pipeline. No printer/camera
# needed: it generates the template + spec, SYNTHESIZES a "filled" raster by
# drawing simple strokes (matching the built-in font shapes) into each cell at
# the correct baseline, then runs vectorize.py and asserts the resulting
# font.json is schema-valid and round-trips through a StrokeFont-style check.
#
# Copyright 2026 hjLabs.in / Hemang Joshi
"""Run the whole pipeline against a synthetic filled template and validate."""

import json
import math
import os
import sys
import tempfile

import numpy as np

import gen_template
import vectorize as vec

try:
    from PIL import Image, ImageDraw
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False


# A tiny stroke alphabet in EM units (baseline 0, +y up, cap 0.7) for the chars
# we synthesize. Just enough variety to prove tracing/junctions/loops work.
EM_STROKES = {
    "A": [[(0.0, 0.0), (0.3, 0.7), (0.6, 0.0)], [(0.13, 0.28), (0.47, 0.28)]],
    "H": [[(0.0, 0.0), (0.0, 0.7)], [(0.5, 0.0), (0.5, 0.7)],
          [(0.0, 0.35), (0.5, 0.35)]],
    "L": [[(0.0, 0.7), (0.0, 0.0), (0.45, 0.0)]],
    "T": [[(0.0, 0.7), (0.5, 0.7)], [(0.25, 0.7), (0.25, 0.0)]],
    "I": [[(0.15, 0.0), (0.15, 0.7)]],
    "Z": [[(0.0, 0.7), (0.5, 0.7), (0.0, 0.0), (0.5, 0.0)]],
    "1": [[(0.1, 0.55), (0.25, 0.7), (0.25, 0.0)]],
    "7": [[(0.0, 0.7), (0.5, 0.7), (0.2, 0.0)]],
    "o": [None],  # circle, generated below
    "/": [[(0.0, 0.0), (0.4, 0.7)]],
    "-": [[(0.05, 0.35), (0.45, 0.35)]],
    "+": [[(0.05, 0.35), (0.45, 0.35)], [(0.25, 0.15), (0.25, 0.55)]],
}


def circle_em(cx=0.25, cy=0.16, r=0.16, n=20):
    return [(cx + r * math.cos(2 * math.pi * i / n),
             cy + r * math.sin(2 * math.pi * i / n)) for i in range(n + 1)]


def synth_filled(spec, path):
    """Render synthetic ink strokes into each cell of page 0 at correct geometry."""
    if not HAVE_PIL:
        raise RuntimeError("PIL required for selftest synthesis")
    dpi = spec["dpi"]
    W, H = spec["page_size_px"]
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)

    # Draw fiducials so the (cv2) deskew path is exercised too.
    for (fx, fy) in spec["fiducials_mm"]:
        s = spec["fiducial_mm"]
        d.rectangle([vec_mm(fx - s / 2, dpi), vec_mm(fy - s / 2, dpi),
                     vec_mm(fx + s / 2, dpi), vec_mm(fy + s / 2, dpi)], fill=0)

    gf = spec["guides_frac_from_bottom"]
    drawn = []
    for cell in spec["cells"]:
        if cell["page"] != 0:
            continue
        ch = cell["char"]
        strokes = None
        if ch == "o":
            strokes = [circle_em()]
        elif ch in EM_STROKES and EM_STROKES[ch][0] is not None:
            strokes = EM_STROKES[ch]
        if strokes is None:
            continue
        drawn.append(ch)

        x, y, w, h = cell["x_mm"], cell["y_mm"], cell["w_mm"], cell["h_mm"]
        base_row_mm = y + (1.0 - gf["baseline"]) * h
        cap_row_mm = y + (1.0 - gf["cap"]) * h
        px_per_em_mm = (base_row_mm - cap_row_mm) / 0.70
        # center the glyph horizontally in the cell
        x_off_mm = x + w * 0.32
        lw = max(2, int(vec_mm(0.45, dpi)))  # ~0.45mm pen
        for st in strokes:
            poly = []
            for (ex, ey) in st:
                mx = x_off_mm + ex * px_per_em_mm
                my = base_row_mm - ey * px_per_em_mm
                poly.append((vec_mm(mx, dpi), vec_mm(my, dpi)))
            d.line(poly, fill=0, width=lw, joint="curve")
    img.save(path, dpi=(dpi, dpi))
    return drawn


def vec_mm(v, dpi):
    return v / 25.4 * dpi


def validate_font(font, expected_chars):
    """Schema check mirroring what StrokeFont::loadJson requires."""
    errs = []
    if not isinstance(font, dict):
        return ["root not an object"]
    if "glyphs" not in font or not isinstance(font["glyphs"], dict):
        errs.append("missing/invalid 'glyphs' object")
    if not isinstance(font.get("name", ""), str):
        errs.append("'name' not a string")
    cap = font.get("capHeight", 0.7)
    if not isinstance(cap, (int, float)) or cap <= 0:
        errs.append("invalid capHeight")
    glyphs = font.get("glyphs", {})
    if not glyphs:
        errs.append("no glyphs")
    for key, g in glyphs.items():
        if len(key) < 1:
            errs.append("empty glyph key")
            continue
        if not isinstance(g, dict):
            errs.append(f"glyph '{key}' not object")
            continue
        if not isinstance(g.get("advance", 0.6), (int, float)):
            errs.append(f"glyph '{key}' advance not number")
        strokes = g.get("strokes", [])
        if not isinstance(strokes, list):
            errs.append(f"glyph '{key}' strokes not list")
            continue
        for si, st in enumerate(strokes):
            if not isinstance(st, list):
                errs.append(f"glyph '{key}' stroke {si} not list")
                continue
            for pt in st:
                if (not isinstance(pt, list) or len(pt) < 2
                        or not all(isinstance(v, (int, float)) for v in pt[:2])):
                    errs.append(f"glyph '{key}' stroke {si} bad point {pt}")
                    break
    # Coverage: at least the non-space chars we drew should be present with
    # >=1 stroke and >=2 points.
    missing = []
    for ch in expected_chars:
        g = glyphs.get(ch)
        if not g or not g.get("strokes") or len(g["strokes"][0]) < 2:
            missing.append(ch)
    return errs, missing


def main():
    print("== handwriting pipeline self-test ==")
    print(f"   cv2={vec.HAVE_CV2}  skimage={vec.HAVE_SKIMAGE}  "
          f"PIL={HAVE_PIL}  reportlab={gen_template.HAVE_REPORTLAB}")
    if not HAVE_PIL:
        print("FAIL: PIL is required for the self-test synthesis "
              "(python3.13 -m pip install --user pillow)")
        return 1

    workdir = tempfile.mkdtemp(prefix="hw_selftest_")
    print(f"   workdir: {workdir}")

    # 1) generate template+spec (force enough cells on page 0)
    rc = gen_template.main(["--out-dir", workdir, "--name", "SelfTest Hand",
                            "--cols", "8", "--rows", "10", "--dpi", "200"])
    if rc != 0:
        print("FAIL: gen_template returned", rc)
        return 1
    spec_path = os.path.join(workdir, "template_spec.json")
    with open(spec_path) as f:
        spec = json.load(f)

    # 2) synthesize a filled scan
    filled = os.path.join(workdir, "filled.png")
    drawn = synth_filled(spec, filled)
    print(f"   synthesized {len(drawn)} filled glyphs: {''.join(drawn)}")

    # 3) vectorize
    out = os.path.join(workdir, "font.json")
    rc = vec.main(["--image", filled, "--spec", spec_path, "--out", out,
                   "--name", "SelfTest Hand", "-v"])
    if rc != 0:
        print("FAIL: vectorize returned", rc)
        return 1

    # 4) load + validate
    with open(out) as f:
        font = json.load(f)
    errs, missing = validate_font(font, [c for c in drawn if c != " "])

    print(f"   font.json: name='{font['name']}' capHeight={font['capHeight']} "
          f"glyphs={len(font['glyphs'])}")
    if errs:
        print("FAIL: schema errors:")
        for e in errs[:20]:
            print("   -", e)
        return 1
    if missing:
        print(f"FAIL: expected glyphs missing/empty: {''.join(missing)}")
        return 1

    # Excerpt for the report.
    sample_key = "A" if "A" in font["glyphs"] else next(iter(font["glyphs"]))
    excerpt = {sample_key: font["glyphs"][sample_key]}
    print("   PASS: schema-valid font.json produced. Excerpt:")
    print(json.dumps({"name": font["name"], "capHeight": font["capHeight"],
                      "glyphs": excerpt}, indent=1))
    print(f"   (kept {out})")
    print("== SELF-TEST PASSED ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
