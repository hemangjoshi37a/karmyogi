#!/usr/bin/env python3.13
# tools/handwriting/vectorize.py
#
# Turn a photo/scan of a FILLED handwriting template into a single-stroke font
# JSON consumed by Candle's (hjLabs.in fork) StrokeFont::loadJson.
#
# Pipeline per template page:
#   load image -> (optional) deskew via fiducial homography -> for each cell:
#     crop -> grayscale -> adaptive threshold -> skeletonize (1px centreline)
#     -> trace skeleton into polylines (split at junctions) -> RDP simplify
#     -> normalize to EM units (baseline y=0, +y up, cap=0.7)
#   collect glyphs -> write font.json
#
# Optional deps: cv2 (best), skimage (skeletonize). Graceful fallbacks:
#   - no cv2  : PIL+numpy load, assume aligned flatbed scan, crop by spec mm/px.
#   - no skimage: built-in Zhang-Suen thinning in numpy.
#
# Copyright 2026 hjLabs.in / Hemang Joshi
"""Vectorize a filled handwriting template into font.json.

Run:
    python3.13 vectorize.py --image filled.png --spec out/template_spec.json \
        --out font.json --name "My Hand"
"""

import argparse
import json
import os
import sys

import numpy as np

# Optional deps -------------------------------------------------------------
try:
    import cv2
    HAVE_CV2 = True
except Exception:
    HAVE_CV2 = False

try:
    from skimage.morphology import skeletonize as _sk_skeletonize
    HAVE_SKIMAGE = True
except Exception:
    HAVE_SKIMAGE = False

try:
    from PIL import Image
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False


# ---------------------------------------------------------------------------
# Image loading
# ---------------------------------------------------------------------------
def load_gray(path):
    """Load image as float grayscale [0,1] (0=black ink, 1=white paper)."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"image not found: {path}")
    if HAVE_CV2:
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise ValueError(f"could not read image: {path}")
        return img.astype(np.float32) / 255.0
    if HAVE_PIL:
        img = Image.open(path).convert("L")
        return np.asarray(img, dtype=np.float32) / 255.0
    raise RuntimeError("Need cv2 or PIL to load images. "
                       "Install: python3.13 -m pip install --user pillow")


# ---------------------------------------------------------------------------
# Deskew via fiducials (cv2 only). Returns an image registered to the spec's
# px page size, or the original if registration fails / cv2 missing.
# ---------------------------------------------------------------------------
def deskew_to_spec(gray, spec):
    if not HAVE_CV2:
        return gray, False
    W, H = spec["page_size_px"]
    try:
        # Binarize, find 4 large dark square blobs near the corners.
        u8 = (gray * 255).astype(np.uint8)
        _, th = cv2.threshold(u8, 0, 255,
                              cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
        h, w = gray.shape
        cands = []
        for c in cnts:
            area = cv2.contourArea(c)
            if area < (0.0003 * w * h) or area > (0.02 * w * h):
                continue
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.05 * peri, True)
            if len(approx) != 4:
                continue
            x, y, ww, hh = cv2.boundingRect(c)
            ar = ww / float(hh) if hh else 0
            if 0.6 < ar < 1.6:
                cx, cy = x + ww / 2.0, y + hh / 2.0
                cands.append((cx, cy))
        if len(cands) < 4:
            return gray, False
        # Pick the 4 closest to the image corners.
        corners_img = [(0, 0), (w, 0), (w, h), (0, h)]
        picked = []
        used = set()
        for (gx, gy) in corners_img:
            best, bi = None, -1
            for i, (cx, cy) in enumerate(cands):
                if i in used:
                    continue
                dd = (cx - gx) ** 2 + (cy - gy) ** 2
                if best is None or dd < best:
                    best, bi = dd, i
            used.add(bi)
            picked.append(cands[bi])
        src = np.array(picked, dtype=np.float32)
        # spec fiducial centres in px, order TL,TR,BR,BL
        fids = spec["fiducials_mm"]
        dpi = spec["dpi"]
        dst = np.array([[fx / 25.4 * dpi, fy / 25.4 * dpi] for (fx, fy) in fids],
                       dtype=np.float32)
        M = cv2.getPerspectiveTransform(src, dst)
        warped = cv2.warpPerspective((gray * 255).astype(np.uint8), M, (W, H),
                                     borderValue=255)
        return warped.astype(np.float32) / 255.0, True
    except Exception as e:
        print(f"[vec] deskew failed ({e}); using image as-is.", file=sys.stderr)
        return gray, False


# ---------------------------------------------------------------------------
# Cell crop. If the image is registered to spec px size, crop by px geometry;
# otherwise scale the spec px coords by the actual image size ratio.
# ---------------------------------------------------------------------------
def crop_cell(gray, spec, cell):
    h, w = gray.shape
    W, H = spec["page_size_px"]
    sx = w / float(W)
    sy = h / float(H)
    dpi = spec["dpi"]

    def mmx(v):
        return v / 25.4 * dpi * sx

    def mmy(v):
        return v / 25.4 * dpi * sy

    x0 = int(round(mmx(cell["x_mm"])))
    y0 = int(round(mmy(cell["y_mm"])))
    x1 = int(round(mmx(cell["x_mm"] + cell["w_mm"])))
    y1 = int(round(mmy(cell["y_mm"] + cell["h_mm"])))
    x0 = max(0, min(x0, w - 1))
    x1 = max(x0 + 1, min(x1, w))
    y0 = max(0, min(y0, h - 1))
    y1 = max(y0 + 1, min(y1, h))
    return gray[y0:y1, x0:x1]


# ---------------------------------------------------------------------------
# Ink extraction: adaptive threshold -> boolean ink mask. Removes the printed
# guide lines/box by trimming a margin and keeping only the strongest ink.
# ---------------------------------------------------------------------------
def extract_ink(cell_gray):
    h, w = cell_gray.shape
    if h < 6 or w < 6:
        return np.zeros((h, w), dtype=bool)
    # Trim a border to drop the printed cell box / labels.
    mx = max(2, int(w * 0.08))
    my = max(2, int(h * 0.08))
    inner = cell_gray[my:h - my, mx:w - mx]
    if inner.size == 0:
        return np.zeros((h, w), dtype=bool)

    if HAVE_CV2:
        u8 = (inner * 255).astype(np.uint8)
        bs = max(11, (min(inner.shape) // 2) | 1)
        th = cv2.adaptiveThreshold(u8, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY_INV, bs, 10)
        mask_inner = th > 0
    else:
        # global Otsu-ish: threshold below mean - k*std
        mean = float(inner.mean())
        std = float(inner.std()) + 1e-6
        thr = mean - 0.5 * std
        mask_inner = inner < thr

    mask = np.zeros((h, w), dtype=bool)
    mask[my:h - my, mx:w - mx] = mask_inner

    # Keep only the largest connected blob(s) to drop speckle.
    mask = _keep_significant(mask)
    return mask


def _keep_significant(mask, min_frac=0.002):
    if HAVE_CV2:
        u8 = mask.astype(np.uint8)
        n, lbl, stats, _ = cv2.connectedComponentsWithStats(u8, connectivity=8)
        if n <= 1:
            return mask
        total = mask.size
        out = np.zeros_like(mask)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= max(8, total * min_frac):
                out[lbl == i] = True
        return out if out.any() else mask
    # numpy fallback: simple flood-fill labeling
    return _np_keep_significant(mask, min_frac)


def _np_keep_significant(mask, min_frac):
    from collections import deque
    visited = np.zeros_like(mask)
    h, w = mask.shape
    out = np.zeros_like(mask)
    total = mask.size
    comps = []
    for i in range(h):
        for j in range(w):
            if mask[i, j] and not visited[i, j]:
                q = deque([(i, j)])
                visited[i, j] = True
                pix = []
                while q:
                    y, x = q.popleft()
                    pix.append((y, x))
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            ny, nx = y + dy, x + dx
                            if (0 <= ny < h and 0 <= nx < w and mask[ny, nx]
                                    and not visited[ny, nx]):
                                visited[ny, nx] = True
                                q.append((ny, nx))
                comps.append(pix)
    for pix in comps:
        if len(pix) >= max(8, total * min_frac):
            for (y, x) in pix:
                out[y, x] = True
    return out if out.any() else mask


# ---------------------------------------------------------------------------
# Skeletonize
# ---------------------------------------------------------------------------
def skeletonize(mask):
    if not mask.any():
        return mask
    if HAVE_SKIMAGE:
        sk = _sk_skeletonize(mask)
    else:
        sk = zhang_suen(mask)
    return _prune_staircase(sk)


def _prune_staircase(sk):
    """Remove redundant pixels so the skeleton is truly 1px (deg<=2 on lines).

    Thinning can leave 2x2 / staircase doublets where a pixel is locally
    superfluous: if a foreground pixel has a 4-neighbour that, together with a
    shared diagonal, makes it redundant, drop it. This kills the false
    "junctions" that otherwise shatter near-vertical/horizontal strokes.
    """
    img = sk.astype(np.uint8)
    h, w = img.shape
    changed = True
    it = 0
    while changed and it < 20:
        changed = False
        it += 1
        ys, xs = np.where(img == 1)
        for y, x in zip(ys, xs):
            # A pixel is removable if it has >=3 neighbours AND removing it does
            # not increase the number of connected components of its 8-neighbour
            # set (i.e. it is not a real junction/articulation point).
            nb = [(y + dy, x + dx) for dy, dx in NB8
                  if 0 <= y + dy < h and 0 <= x + dx < w and img[y + dy, x + dx]]
            if len(nb) < 3:
                continue
            # count connectivity transitions around the ring (P2..P9,P2)
            ring = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1),
                    (0, -1), (-1, -1)]
            vals = []
            for dy, dx in ring:
                ny, nx = y + dy, x + dx
                vals.append(1 if (0 <= ny < h and 0 <= nx < w and img[ny, nx])
                            else 0)
            seq = vals + [vals[0]]
            trans = sum(1 for k in range(8) if seq[k] == 1 and seq[k + 1] == 0)
            # trans==1 -> not an articulation point -> safe to delete a doublet
            if trans == 1:
                img[y, x] = 0
                changed = True
    return img.astype(bool)


def zhang_suen(mask):
    """Zhang-Suen thinning, vectorized in numpy. True = foreground.

    Standard two-subiteration algorithm. Neighbour indexing follows the
    classic P2..P9 layout (P2 = north, going clockwise).
    """
    img = mask.astype(np.uint8)
    img = np.pad(img, 1, mode="constant")

    def subiter(im, step):
        # P2 N, P3 NE, P4 E, P5 SE, P6 S, P7 SW, P8 W, P9 NW
        P2 = im[:-2, 1:-1]
        P3 = im[:-2, 2:]
        P4 = im[1:-1, 2:]
        P5 = im[2:, 2:]
        P6 = im[2:, 1:-1]
        P7 = im[2:, :-2]
        P8 = im[1:-1, :-2]
        P9 = im[:-2, :-2]
        center = im[1:-1, 1:-1] == 1

        B = P2 + P3 + P4 + P5 + P6 + P7 + P8 + P9
        seq = [P2, P3, P4, P5, P6, P7, P8, P9, P2]
        A = np.zeros_like(B)
        for k in range(8):
            A += ((seq[k] == 0) & (seq[k + 1] == 1)).astype(np.uint8)

        cond = center & (B >= 2) & (B <= 6) & (A == 1)
        if step == 0:
            cond &= (P2 * P4 * P6 == 0) & (P4 * P6 * P8 == 0)
        else:
            cond &= (P2 * P4 * P8 == 0) & (P2 * P6 * P8 == 0)
        return cond

    changed = True
    it = 0
    while changed and it < 500:
        changed = False
        it += 1
        for step in (0, 1):
            cond = subiter(img, step)
            if cond.any():
                changed = True
                inner = img[1:-1, 1:-1]
                inner[cond] = 0
    return img[1:-1, 1:-1].astype(bool)


# ---------------------------------------------------------------------------
# Trace skeleton -> polylines (pixel coords). Walk chains, split at junctions.
# ---------------------------------------------------------------------------
NB8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def trace_skeleton(skel):
    """Trace a 1px skeleton into open polylines.

    Direction-following walk: start at an endpoint (or any unvisited pixel for
    pure loops) and at each step pick the unvisited neighbour that best
    continues the current heading. Splits happen only at genuine junctions
    where no good continuation exists. This tolerates the staircase "doublet"
    artefacts a thinning pass leaves on near-vertical/horizontal strokes
    (which naive edge-walking shatters into 2-pixel fragments).
    """
    pts = set(zip(*np.where(skel)))
    if not pts:
        return []

    def deg(p):
        y, x = p
        return sum(1 for dy, dx in NB8 if (y + dy, x + dx) in pts)

    def nbrs(p):
        y, x = p
        return [(y + dy, x + dx) for dy, dx in NB8 if (y + dy, x + dx) in pts]

    visited = set()

    def best_next(cur, heading, candidates):
        """Pick neighbour whose step direction is closest to `heading`."""
        if not candidates:
            return None
        if heading is None:
            return candidates[0]
        hy, hx = heading
        hn = (hy * hy + hx * hx) ** 0.5 or 1.0
        best, bscore = None, -2.0
        for c in candidates:
            dy, dx = c[0] - cur[0], c[1] - cur[1]
            dn = (dy * dy + dx * dx) ** 0.5 or 1.0
            dot = (dy * hy + dx * hx) / (dn * hn)
            if dot > bscore:
                bscore, best = dot, c
        return best

    def walk(start, first):
        path = [start, first]
        visited.add(start)
        visited.add(first)
        prev, cur = start, first
        while True:
            heading = (cur[0] - prev[0], cur[1] - prev[1])
            cand = [n for n in nbrs(cur) if n not in visited]
            nxt = best_next(cur, heading, cand)
            if nxt is None:
                break
            # stop extending through a true hub (>=3 unvisited continuations):
            # let the remaining branches be traced as separate strokes.
            path.append(nxt)
            visited.add(nxt)
            prev, cur = cur, nxt
        return path

    polylines = []
    endpoints = [p for p in pts if deg(p) == 1]
    # Start from endpoints and junctions so strokes are traced full-length.
    seeds = endpoints + [p for p in pts if deg(p) >= 3]
    for s in seeds:
        cand = [n for n in nbrs(s) if n not in visited]
        while cand:
            nxt = best_next(s, None, cand)
            visited.add(s)
            polylines.append(walk(s, nxt))
            cand = [n for n in nbrs(s) if n not in visited]

    # leftover loops with no endpoint/junction
    leftover = pts - visited
    while leftover:
        s = next(iter(leftover))
        cand = [n for n in nbrs(s) if n not in visited]
        if not cand:
            visited.add(s)
            leftover = pts - visited
            continue
        polylines.append(walk(s, cand[0]))
        leftover = pts - visited

    return [pl for pl in polylines if len(pl) >= 2]


# ---------------------------------------------------------------------------
# Ramer-Douglas-Peucker simplification (pixel space).
# ---------------------------------------------------------------------------
def rdp(points, eps):
    if len(points) < 3:
        return points
    pts = np.asarray(points, dtype=np.float64)
    start, end = pts[0], pts[-1]
    line = end - start
    ln = np.hypot(*line)
    if ln == 0:
        d = np.hypot(*(pts - start).T)
    else:
        # perpendicular distance
        d = np.abs(line[0] * (start[1] - pts[:, 1]) -
                   line[1] * (start[0] - pts[:, 0])) / ln
    idx = int(np.argmax(d))
    if d[idx] > eps:
        left = rdp(points[:idx + 1], eps)
        right = rdp(points[idx:], eps)
        return left[:-1] + right
    return [points[0], points[-1]]


# ---------------------------------------------------------------------------
# Glyph extraction for one cell -> (advance, strokes in EM units) or None.
# ---------------------------------------------------------------------------
def _chain_len(chain):
    d = 0.0
    for a, b in zip(chain, chain[1:]):
        d += ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
    return d


def _merge_chains(chains, gap=2.9):
    """Greedily join chains whose endpoints are within `gap` pixels and whose
    headings are roughly continuous, reducing junction-induced fragments into
    longer, more faithful strokes."""
    chains = [list(c) for c in chains if len(c) >= 2]
    g2 = gap * gap

    def dist2(a, b):
        return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

    merged = True
    while merged:
        merged = False
        n = len(chains)
        for i in range(n):
            if chains[i] is None:
                continue
            for j in range(i + 1, n):
                if chains[j] is None:
                    continue
                a, b = chains[i], chains[j]
                # try all four endpoint pairings; join closest under gap.
                pairs = [
                    (a[-1], b[0], lambda a, b: a + b),
                    (a[-1], b[-1], lambda a, b: a + b[::-1]),
                    (a[0], b[0], lambda a, b: a[::-1] + b),
                    (a[0], b[-1], lambda a, b: b + a),
                ]
                best = None
                for pa, pb, comb in pairs:
                    d = dist2(pa, pb)
                    if d <= g2 and (best is None or d < best[0]):
                        best = (d, comb)
                if best is not None:
                    chains[i] = best[1](a, b)
                    chains[j] = None
                    merged = True
        chains = [c for c in chains if c is not None]
    return chains


def vectorize_cell(cell_gray, spec, simplify_px=1.5):
    mask = extract_ink(cell_gray)
    if not mask.any():
        return None
    skel = skeletonize(mask)
    if not skel.any():
        return None
    chains = trace_skeleton(skel)
    if not chains:
        return None

    h, w = skel.shape
    gf = spec["guides_frac_from_bottom"]
    # Guide line pixel rows within the (untrimmed) cell, measured from bottom.
    # extract_ink trimmed a border but coords here are full-cell pixels.
    base_row = h * (1.0 - gf["baseline"])
    cap_row = h * (1.0 - gf["cap"])
    px_per_em = (base_row - cap_row) / 0.70  # pixels per 1.0 EM
    if px_per_em <= 1e-6:
        px_per_em = h * 0.7

    # Merge fragments that meet end-to-end and drop tiny spurs, then simplify.
    chains = _merge_chains(chains, gap=2.9)
    # Drop spurs shorter than a few pixels unless they're the only thing.
    if len(chains) > 1:
        chains = [c for c in chains if _chain_len(c) >= 3.0] or chains

    eps = max(0.5, simplify_px)
    strokes = []
    xs_all = []
    for chain in chains:
        # chain is list of (row=y, col=x). simplify on (x,y).
        pts_xy = [(p[1], p[0]) for p in chain]
        simp = rdp(pts_xy, eps)
        if len(simp) < 2:
            continue
        em_stroke = []
        for (px, py) in simp:
            ex = px / px_per_em
            ey = (base_row - py) / px_per_em   # +y up, baseline=0
            em_stroke.append([round(ex, 4), round(ey, 4)])
            xs_all.append(ex)
        strokes.append(em_stroke)

    if not strokes or not xs_all:
        return None

    # Normalize X so ink starts near 0; advance = ink width + margin.
    min_x = min(xs_all)
    max_x = max(xs_all)
    margin = 0.12
    for st in strokes:
        for p in st:
            p[0] = round(p[0] - min_x + margin, 4)
    advance = round((max_x - min_x) + 2 * margin, 4)
    if advance < 0.15:
        advance = 0.15
    return advance, strokes


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def vectorize(image_path, spec, name, simplify_px=1.5, verbose=False):
    gray = load_gray(image_path)
    gray, registered = deskew_to_spec(gray, spec)
    if verbose:
        print(f"[vec] image {gray.shape[1]}x{gray.shape[0]} "
              f"registered={registered} cv2={HAVE_CV2} "
              f"skimage={HAVE_SKIMAGE}", file=sys.stderr)

    glyphs = {}
    for cell in spec["cells"]:
        ch = cell["char"]
        if ch == " ":
            glyphs[ch] = {"advance": 0.4, "strokes": []}
            continue
        sub = crop_cell(gray, spec, cell)
        res = vectorize_cell(sub, spec, simplify_px=simplify_px)
        if res is None:
            if verbose:
                print(f"[vec] no ink for '{ch}' (cell {cell['index']})",
                      file=sys.stderr)
            continue
        advance, strokes = res
        glyphs[ch] = {"advance": advance, "strokes": strokes}

    font = {
        "name": name,
        "capHeight": 0.7,
        "glyphs": glyphs,
    }
    return font


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Vectorize a filled handwriting template into font.json "
                    "for Candle's Writing mode (StrokeFont::loadJson).")
    ap.add_argument("--image", required=True,
                    help="photo/scan of the filled template (PNG/JPG)")
    ap.add_argument("--spec", required=True,
                    help="template_spec.json produced by gen_template.py")
    ap.add_argument("--out", default="font.json", help="output font JSON path")
    ap.add_argument("--name", default=None,
                    help="font name (default: spec name)")
    ap.add_argument("--simplify", type=float, default=1.5,
                    help="RDP tolerance in pixels (default 1.5)")
    ap.add_argument("--multi", nargs="*", default=None,
                    help="additional page images (for multi-page templates), in "
                         "page order after --image")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    if not os.path.exists(args.spec):
        ap.error(f"spec not found: {args.spec}")
    with open(args.spec, encoding="utf-8") as f:
        spec = json.load(f)

    name = args.name or spec.get("name", "Custom")

    # For multi-page: vectorize each page against the cells belonging to it.
    images = [args.image] + (args.multi or [])
    if len(images) > 1 or spec["num_pages"] > 1:
        # Build per-page sub-specs.
        merged = {"name": name, "capHeight": 0.7, "glyphs": {}}
        for page in range(spec["num_pages"]):
            if page >= len(images):
                print(f"[vec] WARNING: no image for page {page+1}; skipping.",
                      file=sys.stderr)
                continue
            page_cells = [c for c in spec["cells"] if c["page"] == page]
            page_spec = dict(spec)
            page_spec["cells"] = page_cells
            f = vectorize(images[page], page_spec, name,
                          simplify_px=args.simplify, verbose=args.verbose)
            merged["glyphs"].update(f["glyphs"])
        font = merged
    else:
        font = vectorize(args.image, spec, name,
                         simplify_px=args.simplify, verbose=args.verbose)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(font, f, indent=1)

    n = len(font["glyphs"])
    print(f"[vec] wrote {args.out}: {n} glyphs (name='{font['name']}', "
          f"capHeight={font['capHeight']})")
    if n == 0:
        print("[vec] ERROR: no glyphs extracted - check image alignment / spec.",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
