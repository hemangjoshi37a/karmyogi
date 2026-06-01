#!/usr/bin/env python3.13
# tools/handwriting/gen_template.py
#
# Generate a printable calibration template for authoring a custom single-stroke
# HANDWRITING font for the Candle (hjLabs.in fork) pen-plotter "Writing mode".
#
# It produces:
#   - template.pdf   (if reportlab is available)  OR  template.svg + template.png
#   - template_spec.json  (always) describing exact cell geometry + char mapping
#
# The spec lets vectorize.py crop each cell precisely and know which character
# each cell holds. Fiducial squares in the page corners enable a homography in
# vectorize.py so a phone photo can be deskewed.
#
# Copyright 2026 hjLabs.in / Hemang Joshi
"""Generate the handwriting calibration template + geometry spec.

Run:
    python3.13 gen_template.py --out-dir out --name "My Hand"
"""

import argparse
import json
import math
import os
import sys

from charset import CHARSET, char_label

# Optional deps -------------------------------------------------------------
try:
    import reportlab  # noqa: F401
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm as _RL_MM
    from reportlab.pdfgen import canvas as _rl_canvas

    HAVE_REPORTLAB = True
except Exception:
    HAVE_REPORTLAB = False

try:
    from PIL import Image, ImageDraw, ImageFont  # noqa: F401

    HAVE_PIL = True
except Exception:
    HAVE_PIL = False


# ---------------------------------------------------------------------------
# Geometry. All layout maths are done in millimetres on an A4 page; the spec
# also records a pixel grid (at a chosen DPI) so a flatbed scan can be cropped
# without any image registration.
# ---------------------------------------------------------------------------
PAGE_W_MM = 210.0   # A4 portrait
PAGE_H_MM = 297.0
MARGIN_MM = 12.0
FIDUCIAL_MM = 8.0   # side length of the corner alignment squares
GUIDE_GRAY = 0.72   # 0..1 (1=white) for faint guide lines


def build_spec(cols, rows, name, dpi):
    """Compute the cell grid geometry and return the spec dict.

    Cells are arranged row-major in CHARSET order. Each page holds rows*cols
    cells; we paginate over the whole charset. Within a cell, the writing
    guide is: a light bounding box, a baseline, an x-height line and a cap
    line. The character is to be written sitting on the baseline.
    """
    usable_w = PAGE_W_MM - 2 * MARGIN_MM
    usable_h = PAGE_H_MM - 2 * MARGIN_MM

    cell_w = usable_w / cols
    cell_h = usable_h / rows

    # Fractions (of the cell height, measured from the cell BOTTOM) where the
    # writing guides sit. These mirror the EM metrics of StrokeFont:
    #   baseline = 0, x-height = 0.5*cap, cap = 0.7.
    # We reserve vertical padding so descenders/ascenders have room.
    pad_bottom = 0.22   # descender room below baseline
    pad_top = 0.10
    span = 1.0 - pad_bottom - pad_top         # usable EM-ish band
    baseline_frac = pad_bottom                # baseline position from bottom
    cap_frac = baseline_frac + 0.70 * span    # cap line
    xheight_frac = baseline_frac + 0.50 * span  # x-height line

    chars = list(CHARSET)
    per_page = cols * rows
    npages = int(math.ceil(len(chars) / per_page))

    cells = []  # flat list across all pages
    for idx, ch in enumerate(chars):
        page = idx // per_page
        local = idx % per_page
        r = local // cols          # 0 = top row
        c = local % cols
        # mm coordinates, origin at TOP-LEFT of page (image convention).
        x_mm = MARGIN_MM + c * cell_w
        y_mm = MARGIN_MM + r * cell_h
        cells.append({
            "index": idx,
            "char": ch,
            "label": char_label(ch),
            "page": page,
            "row": r,
            "col": c,
            "x_mm": round(x_mm, 4),
            "y_mm": round(y_mm, 4),
            "w_mm": round(cell_w, 4),
            "h_mm": round(cell_h, 4),
        })

    spec = {
        "name": name,
        "page_size_mm": [PAGE_W_MM, PAGE_H_MM],
        "margin_mm": MARGIN_MM,
        "dpi": dpi,
        "page_size_px": [round(PAGE_W_MM / 25.4 * dpi), round(PAGE_H_MM / 25.4 * dpi)],
        "cols": cols,
        "rows": rows,
        "cells_per_page": per_page,
        "num_pages": npages,
        "cell_w_mm": round(cell_w, 4),
        "cell_h_mm": round(cell_h, 4),
        # Guide line fractions, measured from the cell BOTTOM (y up).
        "guides_frac_from_bottom": {
            "baseline": round(baseline_frac, 5),
            "xheight": round(xheight_frac, 5),
            "cap": round(cap_frac, 5),
        },
        "fiducial_mm": FIDUCIAL_MM,
        # Fiducial square centres in mm (top-left origin), per page. Used by
        # vectorize.py to compute a homography from a photo.
        "fiducials_mm": [
            [MARGIN_MM / 2.0, MARGIN_MM / 2.0],                          # TL
            [PAGE_W_MM - MARGIN_MM / 2.0, MARGIN_MM / 2.0],              # TR
            [PAGE_W_MM - MARGIN_MM / 2.0, PAGE_H_MM - MARGIN_MM / 2.0],  # BR
            [MARGIN_MM / 2.0, PAGE_H_MM - MARGIN_MM / 2.0],             # BL
        ],
        "charset": chars,
        "cells": cells,
    }
    return spec


def mm_to_px(v_mm, dpi):
    return v_mm / 25.4 * dpi


# ---------------------------------------------------------------------------
# PDF renderer (reportlab). reportlab origin is bottom-left, y up.
# ---------------------------------------------------------------------------
def render_pdf(spec, path):
    c = _rl_canvas.Canvas(path, pagesize=A4)
    g = GUIDE_GRAY
    cells_by_page = {}
    for cell in spec["cells"]:
        cells_by_page.setdefault(cell["page"], []).append(cell)

    gf = spec["guides_frac_from_bottom"]
    for page in range(spec["num_pages"]):
        # Fiducials (solid black squares).
        c.setFillGray(0.0)
        for (fx, fy) in spec["fiducials_mm"]:
            s = spec["fiducial_mm"]
            # convert top-left-origin mm to bottom-left-origin pdf points
            px = fx - s / 2.0
            py = PAGE_H_MM - (fy + s / 2.0)
            c.rect(px * _RL_MM, py * _RL_MM, s * _RL_MM, s * _RL_MM, fill=1, stroke=0)

        # Page header.
        c.setFillGray(0.0)
        c.setFont("Helvetica", 9)
        c.drawString(MARGIN_MM * _RL_MM, (PAGE_H_MM - MARGIN_MM + 2) * _RL_MM,
                     f"Candle handwriting template  '{spec['name']}'  "
                     f"page {page + 1}/{spec['num_pages']}  "
                     f"- write each char on its baseline")

        for cell in cells_by_page.get(page, []):
            x = cell["x_mm"]
            w = cell["w_mm"]
            h = cell["h_mm"]
            # top-left-origin -> bottom-left-origin
            y_bottom = PAGE_H_MM - (cell["y_mm"] + h)

            # light box
            c.setStrokeGray(g)
            c.setLineWidth(0.4)
            c.rect(x * _RL_MM, y_bottom * _RL_MM, w * _RL_MM, h * _RL_MM,
                   fill=0, stroke=1)

            base_y = y_bottom + gf["baseline"] * h
            xh_y = y_bottom + gf["xheight"] * h
            cap_y = y_bottom + gf["cap"] * h

            # baseline (darker), x-height + cap (lighter dashed)
            c.setStrokeGray(g * 0.6)
            c.setLineWidth(0.5)
            c.line(x * _RL_MM, base_y * _RL_MM, (x + w) * _RL_MM, base_y * _RL_MM)
            c.setStrokeGray(g)
            c.setLineWidth(0.3)
            c.setDash(1, 2)
            c.line(x * _RL_MM, xh_y * _RL_MM, (x + w) * _RL_MM, xh_y * _RL_MM)
            c.line(x * _RL_MM, cap_y * _RL_MM, (x + w) * _RL_MM, cap_y * _RL_MM)
            c.setDash()

            # faint target glyph in the cell corner as a guide
            c.setFillGray(g)
            c.setFont("Helvetica", 7)
            c.drawString((x + 1) * _RL_MM, (y_bottom + h - 4) * _RL_MM, cell["label"])
            # big faint guide character centred on baseline
            c.setFillGray(min(0.85, g + 0.1))
            fs = max(8, int((cap_y - base_y) / _RL_MM * _RL_MM))
            c.setFont("Helvetica", (cap_y - base_y))
            if cell["char"] != " ":
                c.drawCentredString((x + w / 2.0) * _RL_MM, base_y * _RL_MM,
                                    cell["char"])

        c.showPage()
    c.save()


# ---------------------------------------------------------------------------
# SVG renderer (no deps). SVG origin is top-left, y down -> matches our mm spec.
# Renders ONE page only into the named file when single page; otherwise emits
# <basename>_pN.svg. Returns list of written paths.
# ---------------------------------------------------------------------------
def render_svg(spec, base_path):
    g255 = int(round(GUIDE_GRAY * 255))
    gcol = f"rgb({g255},{g255},{g255})"
    gdark = f"rgb({int(g255*0.6)},{int(g255*0.6)},{int(g255*0.6)})"
    gf = spec["guides_frac_from_bottom"]

    cells_by_page = {}
    for cell in spec["cells"]:
        cells_by_page.setdefault(cell["page"], []).append(cell)

    paths = []
    for page in range(spec["num_pages"]):
        parts = []
        parts.append(
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'width="{PAGE_W_MM}mm" height="{PAGE_H_MM}mm" '
            f'viewBox="0 0 {PAGE_W_MM} {PAGE_H_MM}">')
        parts.append(f'<rect x="0" y="0" width="{PAGE_W_MM}" height="{PAGE_H_MM}" '
                     f'fill="white"/>')
        # fiducials
        for (fx, fy) in spec["fiducials_mm"]:
            s = spec["fiducial_mm"]
            parts.append(f'<rect x="{fx - s/2:.3f}" y="{fy - s/2:.3f}" '
                         f'width="{s}" height="{s}" fill="black"/>')
        parts.append(
            f'<text x="{MARGIN_MM}" y="{MARGIN_MM - 3}" font-size="3" '
            f'fill="black" font-family="sans-serif">Candle handwriting template '
            f"'{spec['name']}' page {page+1}/{spec['num_pages']} "
            f'- write each char on its baseline</text>')

        for cell in cells_by_page.get(page, []):
            x = cell["x_mm"]
            y = cell["y_mm"]
            w = cell["w_mm"]
            h = cell["h_mm"]
            # box
            parts.append(f'<rect x="{x:.3f}" y="{y:.3f}" width="{w:.3f}" '
                         f'height="{h:.3f}" fill="none" stroke="{gcol}" '
                         f'stroke-width="0.15"/>')
            # guide lines (y measured from bottom -> svg y = cell_top + (1-frac)*h)
            base_y = y + (1.0 - gf["baseline"]) * h
            xh_y = y + (1.0 - gf["xheight"]) * h
            cap_y = y + (1.0 - gf["cap"]) * h
            parts.append(f'<line x1="{x:.3f}" y1="{base_y:.3f}" x2="{x+w:.3f}" '
                         f'y2="{base_y:.3f}" stroke="{gdark}" stroke-width="0.2"/>')
            for ly in (xh_y, cap_y):
                parts.append(f'<line x1="{x:.3f}" y1="{ly:.3f}" x2="{x+w:.3f}" '
                             f'y2="{ly:.3f}" stroke="{gcol}" stroke-width="0.12" '
                             f'stroke-dasharray="0.8,0.8"/>')
            # label
            parts.append(f'<text x="{x+1:.3f}" y="{y+3.5:.3f}" font-size="2.4" '
                         f'fill="{gcol}" font-family="sans-serif">{_xml(cell["label"])}'
                         f'</text>')
            if cell["char"] != " ":
                fs = cap_y_dist = (base_y - cap_y)
                parts.append(
                    f'<text x="{x+w/2:.3f}" y="{base_y:.3f}" '
                    f'font-size="{fs:.2f}" fill="{gcol}" text-anchor="middle" '
                    f'font-family="sans-serif">{_xml(cell["char"])}</text>')
        parts.append("</svg>")
        svg = "\n".join(parts)

        if spec["num_pages"] == 1:
            outp = base_path
        else:
            root, ext = os.path.splitext(base_path)
            outp = f"{root}_p{page+1}{ext}"
        with open(outp, "w", encoding="utf-8") as f:
            f.write(svg)
        paths.append(outp)
    return paths


def _xml(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


# ---------------------------------------------------------------------------
# PNG renderer (PIL). Useful as a quick on-screen preview / fallback raster.
# Renders page 0 only by default (preview). For multipage emits _pN.png.
# ---------------------------------------------------------------------------
def render_png(spec, base_path):
    if not HAVE_PIL:
        return []
    dpi = spec["dpi"]
    W = spec["page_size_px"][0]
    H = spec["page_size_px"][1]
    gv = int(round(GUIDE_GRAY * 255))
    gcol = (gv, gv, gv)
    gdark = (int(gv * 0.6),) * 3
    gf = spec["guides_frac_from_bottom"]

    cells_by_page = {}
    for cell in spec["cells"]:
        cells_by_page.setdefault(cell["page"], []).append(cell)

    try:
        font = ImageFont.truetype("DejaVuSans.ttf", max(8, int(mm_to_px(3, dpi))))
        small = ImageFont.truetype("DejaVuSans.ttf", max(7, int(mm_to_px(2.4, dpi))))
    except Exception:
        font = ImageFont.load_default()
        small = font

    paths = []
    for page in range(spec["num_pages"]):
        img = Image.new("RGB", (W, H), "white")
        d = ImageDraw.Draw(img)
        for (fx, fy) in spec["fiducials_mm"]:
            s = spec["fiducial_mm"]
            d.rectangle([mm_to_px(fx - s / 2, dpi), mm_to_px(fy - s / 2, dpi),
                         mm_to_px(fx + s / 2, dpi), mm_to_px(fy + s / 2, dpi)],
                        fill="black")
        for cell in cells_by_page.get(page, []):
            x, y, w, h = cell["x_mm"], cell["y_mm"], cell["w_mm"], cell["h_mm"]
            d.rectangle([mm_to_px(x, dpi), mm_to_px(y, dpi),
                         mm_to_px(x + w, dpi), mm_to_px(y + h, dpi)],
                        outline=gcol, width=1)
            base_y = y + (1.0 - gf["baseline"]) * h
            xh_y = y + (1.0 - gf["xheight"]) * h
            cap_y = y + (1.0 - gf["cap"]) * h
            d.line([mm_to_px(x, dpi), mm_to_px(base_y, dpi),
                    mm_to_px(x + w, dpi), mm_to_px(base_y, dpi)], fill=gdark, width=1)
            for ly in (xh_y, cap_y):
                d.line([mm_to_px(x, dpi), mm_to_px(ly, dpi),
                        mm_to_px(x + w, dpi), mm_to_px(ly, dpi)], fill=gcol, width=1)
            d.text((mm_to_px(x + 1, dpi), mm_to_px(y + 0.5, dpi)),
                   cell["label"], fill=gcol, font=small)
        if spec["num_pages"] == 1:
            outp = base_path
        else:
            root, ext = os.path.splitext(base_path)
            outp = f"{root}_p{page+1}{ext}"
        img.save(outp, dpi=(dpi, dpi))
        paths.append(outp)
    return paths


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Generate a handwriting calibration template + spec for "
                    "the Candle pen-plotter Writing mode.")
    ap.add_argument("--out-dir", default="out",
                    help="output directory (default: out)")
    ap.add_argument("--name", default="My Handwriting",
                    help="font name recorded in the spec / final font.json")
    ap.add_argument("--cols", type=int, default=8, help="cells per row")
    ap.add_argument("--rows", type=int, default=10, help="rows per page")
    ap.add_argument("--dpi", type=int, default=300,
                    help="DPI used for the pixel grid in the spec / PNG")
    ap.add_argument("--format", choices=["auto", "pdf", "svg", "png"],
                    default="auto",
                    help="force an output format (default auto: pdf if reportlab "
                         "else svg+png)")
    args = ap.parse_args(argv)

    if args.cols < 1 or args.rows < 1:
        ap.error("--cols and --rows must be >= 1")

    os.makedirs(args.out_dir, exist_ok=True)
    spec = build_spec(args.cols, args.rows, args.name, args.dpi)

    spec_path = os.path.join(args.out_dir, "template_spec.json")
    with open(spec_path, "w", encoding="utf-8") as f:
        json.dump(spec, f, indent=2)
    print(f"[gen] wrote spec: {spec_path}  "
          f"({len(spec['cells'])} cells, {spec['num_pages']} page(s))")

    written = []
    fmt = args.format
    if fmt == "auto":
        fmt = "pdf" if HAVE_REPORTLAB else "svg"

    if fmt == "pdf":
        if not HAVE_REPORTLAB:
            print("[gen] reportlab not available; falling back to SVG+PNG. "
                  "Install with: python3.13 -m pip install --user reportlab",
                  file=sys.stderr)
            fmt = "svg"
        else:
            pdf_path = os.path.join(args.out_dir, "template.pdf")
            render_pdf(spec, pdf_path)
            written.append(pdf_path)

    if fmt in ("svg", "png"):
        svg_paths = render_svg(spec, os.path.join(args.out_dir, "template.svg"))
        written.extend(svg_paths)
        png_paths = render_png(spec, os.path.join(args.out_dir, "template.png"))
        written.extend(png_paths)
        if not png_paths and not HAVE_PIL:
            print("[gen] PIL not available; skipped PNG (SVG written). "
                  "Install with: python3.13 -m pip install --user pillow",
                  file=sys.stderr)

    for p in written:
        print(f"[gen] wrote template: {p}")
    print(f"[gen] DONE. Print the template, write your characters on the "
          f"baselines, then scan/photograph and run vectorize.py.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
