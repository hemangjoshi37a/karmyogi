# Custom handwriting font pipeline (Candle / hjLabs.in fork — Writing mode)

Turn **your own handwriting** into a single-stroke vector font that the Candle
pen-plotter **Writing mode** can plot. You write each character once on a
printed calibration sheet, photograph or scan it, and this pipeline traces the
centreline of each stroke into a `font.json` that the app loads via
**Writing tab → "Load custom font…"**.

The output JSON matches exactly what the C++ `cadcam::StrokeFont::loadJson`
consumes:

```json
{
  "name": "My Hand",
  "capHeight": 0.7,
  "glyphs": {
    "A": { "advance": 0.65, "strokes": [ [[x0,y0],[x1,y1], ...], ... ] },
    ...
  }
}
```

Coordinates are in **EM units**: baseline `y = 0`, **+y is up**, cap height
`= 0.7`. Each stroke is one *open* polyline (one pen-down move). The app scales
EM units so the cap height maps to the character height you request in mm.

---

## Interpreter

Use **`python3.13`** for everything below (the only hard dependency for the
vectorizer is `numpy`).

## Dependencies (all optional except numpy — there are graceful fallbacks)

```bash
python3.13 -m pip install --user opencv-python numpy scikit-image reportlab pillow
# or, equivalently:
python3.13 -m pip install --user -r requirements.txt
```

| Package        | Used for                                   | If missing, fallback                          |
|----------------|--------------------------------------------|-----------------------------------------------|
| `numpy`        | all array maths (REQUIRED for vectorize)   | —                                             |
| `reportlab`    | multi-page **PDF** template                | emit **SVG + PNG** instead                    |
| `pillow` (PIL) | PNG template, image loading, self-test     | OpenCV used for loading; PNG/self-test skipped|
| `opencv-python`| best loading, adaptive threshold, **deskew** via corner fiducials | PIL+numpy load; assume an **aligned flatbed scan**, crop by spec geometry |
| `scikit-image` | high-quality `skeletonize`                 | built-in **Zhang-Suen** thinning in numpy     |

---

## End-to-end workflow

### 1. Generate the calibration template

```bash
cd tools/handwriting
python3.13 gen_template.py --out-dir out --name "My Hand"
```

Produces in `out/`:

- `template.pdf` (if `reportlab` is present) **or** `template.svg` + `template.png`
- `template_spec.json` — exact cell geometry (mm + px), guide-line positions,
  fiducial locations, and the character→cell mapping. **The vectorizer needs
  this file.**

Each cell shows a faint **box**, a **baseline**, an **x-height** line, a **cap**
line, the character **label** in the corner, and a faint copy of the target
character as a tracing guide. Four solid black **fiducial squares** sit in the
page corners so a phone photo can be deskewed.

Options: `--cols`, `--rows`, `--dpi`, `--format {auto,pdf,svg,png}`,
`--name`. Defaults: 8×10 cells/page, 300 DPI, A4 portrait. The full charset
(A–Z, a–z, 0–9, space, `. , : ; ! ? - _ ( ) / + = ' "`) paginates automatically.

### 2. Print it

Print `template.pdf` (or the SVG/PNG) at **100% / actual size** on A4. Do not
"fit to page" — the spec assumes the printed geometry.

### 3. Handwrite your characters

With a dark pen, write **each character once**, sitting on the **baseline**,
keeping within the box. Single-stroke / simple letterforms trace best (this is
a *single-stroke* plotter font). Lowercase should reach the x-height; capitals
the cap line; descenders (g, j, p, q, y) may dip below the baseline.

### 4. Photograph or scan

- **Flatbed scan** (best): straight, even lighting, 200–300 DPI.
- **Phone photo**: include all four corner fiducials; OpenCV will deskew via a
  homography. Without OpenCV, use a flat scan (the vectorizer then crops by the
  spec geometry assuming the page is aligned).

Save as `filled.png` (or `.jpg`). For multi-page templates, one image per page.

### 5. Vectorize → font.json

```bash
python3.13 vectorize.py --image filled.png --spec out/template_spec.json \
    --out font.json --name "My Hand" -v
```

Multi-page template:

```bash
python3.13 vectorize.py --image page1.png --multi page2.png \
    --spec out/template_spec.json --out font.json --name "My Hand"
```

Options: `--simplify N` (Ramer–Douglas–Peucker tolerance in pixels, default
`1.5`; raise it for smoother/fewer points, lower it for more fidelity),
`-v/--verbose` (per-cell diagnostics).

What it does per cell: crop → grayscale → adaptive threshold (ink mask) →
**skeletonize** to a 1-px centreline → **trace** the skeleton into polylines
(direction-following walk, split at true junctions, merge end-to-end fragments)
→ **RDP** simplify → normalise to EM units (baseline `y=0`, `+y` up, cap `0.7`,
advance = ink width + margin).

### 6. Load it in Candle

In the app's **Writing** tab, click **"Load custom font…"** and pick your
`font.json`. Type text and generate the toolpath as usual.

---

## Self-test (no printer/scanner needed)

`selftest.py` runs the whole pipeline against a **synthetic** filled template
(it renders simple strokes into the cells itself), then validates the resulting
`font.json` against the schema and a coverage check:

```bash
cd tools/handwriting
python3.13 selftest.py
```

It prints which optional libraries were detected vs fell back, the glyph count,
and an excerpt of the generated font, ending in `== SELF-TEST PASSED ==` on
success.

---

## Files

| File                  | Purpose                                                        |
|-----------------------|----------------------------------------------------------------|
| `charset.py`          | ordered character set + cell label/key helpers (shared)        |
| `gen_template.py`     | generate the printable template + `template_spec.json`         |
| `vectorize.py`        | filled image + spec → `font.json`                              |
| `selftest.py`         | end-to-end synthetic round-trip test + schema validation       |
| `requirements.txt`    | optional Python dependencies                                   |

## Tips for good results

- Prefer **simple, single-stroke** letterforms — this is a pen plotter, not a
  brush. Avoid double-tracing the same line.
- A **flatbed scan** beats a phone photo. If using a photo, keep the page flat
  and all four fiducials in frame.
- Installing **scikit-image** noticeably improves skeleton quality (cleaner
  joins, fewer stray fragments) versus the built-in Zhang-Suen fallback.
- Re-run with a larger `--simplify` if a glyph has too many points; smaller if
  curves look faceted.
