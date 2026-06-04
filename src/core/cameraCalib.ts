/**
 * Pure-math core for the two-camera, markerless "see if the design fits the
 * job" 3D feature.
 *
 * NO React / DOM / three.js / browser-type imports — this is a portable,
 * testable core module (mirrors the Qt `cadcam` lib separation and the rest of
 * `src/core/`). Everything in / out is plain numbers, typed arrays, or plain
 * objects.
 *
 * What it provides:
 *   - Plane homography (bed plane Z=0 ⇄ image) via the NORMALIZED DLT, solved
 *     with a self-contained symmetric Jacobi eigen-decomposition.
 *   - 3×3 helpers (apply / invert / reprojection RMS).
 *   - An assumed pinhole camera model + planar pose decomposition, used to
 *     project 3D bed points (X,Y,Z) into each camera so a visual-hull height
 *     field can be carved.
 *   - Markerless silhouette extraction (reference vs. current frame diff,
 *     largest connected blob, mapped to bed-mm).
 *   - A two-view space-carving visual hull yielding a per-cell job height field.
 *   - A simple design-vs-job axis-aligned fit check.
 *   - An optional QR/marker payload parser (markerless is the primary path).
 *
 * Conventions:
 *   - Matrices ({@link Mat3}) are length-9, ROW-major:
 *       [ m0 m1 m2 ]
 *       [ m3 m4 m5 ]
 *       [ m6 m7 m8 ]
 *   - Image coordinates are pixels (x right, y down) unless stated otherwise.
 *   - World/bed coordinates are millimetres in the GRBL work plane (Z up, Z=0
 *     is the bed surface).
 *
 * Numerical caveats for the integrator (see also the per-function JSDoc):
 *   - {@link assumedIntrinsics} GUESSES the camera matrix from an assumed
 *     horizontal FOV. Lens distortion is IGNORED entirely (pinhole model). For
 *     accurate metrology, calibrate the cameras and supply a real K.
 *   - The homography/pose math is undistorted-pinhole; results degrade with
 *     wide-angle lenses or strong barrel distortion.
 *   - {@link visualHull} is a conservative space-carving estimate from
 *     silhouettes only (no photo-consistency); concavities not visible to any
 *     camera are filled in. Two views give a coarse hull — more views tighten
 *     it.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A 2D point / vector: `[x, y]`. Immutable. */
export type Vec2 = readonly [number, number];

/** A 3D point / vector: `[x, y, z]`. Immutable. */
export type Vec3 = readonly [number, number, number];

/**
 * A 3×3 matrix stored ROW-major as a length-9 array:
 * `[ m0 m1 m2 | m3 m4 m5 | m6 m7 m8 ]`.
 */
export type Mat3 = readonly number[];

/** A single-channel (grayscale) image; `data.length` must equal `width*height`. */
export interface GrayImage {
  /** Row-major intensity samples, one byte per pixel (0..255). */
  data: Uint8Array | Uint8ClampedArray;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
}

/** An axis-aligned rectangle (units depend on context: pixels or bed-mm). */
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * A pinhole camera pose: intrinsics `K`, rotation `R` (world→camera, a 3×3
 * row-major rotation), and translation `t` (world→camera). A world point `P`
 * projects via `x ~ K · (R · P + t)`.
 */
export interface CameraPose {
  /** Intrinsic matrix (row-major 3×3). */
  K: Mat3;
  /** World→camera rotation (row-major 3×3, det ≈ +1). */
  R: Mat3;
  /** World→camera translation, mm. */
  t: Vec3;
}

/** Generic numerical epsilon for degeneracy / divide-by-zero guards. */
const kEps = 1e-12;

// ---------------------------------------------------------------------------
// Small dense linear-algebra helpers (private)
// ---------------------------------------------------------------------------

/** Row-major 3×3 multiply: returns `a · b`. */
function mat3Mul(a: Mat3, b: Mat3): number[] {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3 + 0] * b[0 * 3 + c] +
        a[r * 3 + 1] * b[1 * 3 + c] +
        a[r * 3 + 2] * b[2 * 3 + c];
    }
  }
  return out;
}

/** Row-major 3×3 times a column 3-vector: returns `m · v`. */
function mat3MulVec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** 3-vector cross product `a × b`. */
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Euclidean norm of a 3-vector. */
function norm3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/**
 * Symmetric-eigenvalue decomposition of an `n×n` symmetric matrix `A` (stored
 * row-major) via the classic cyclic **Jacobi rotation** method.
 *
 * Repeatedly applies Givens rotations that zero the largest-magnitude
 * off-diagonal entry of each (p,q) pair, accumulating the rotations into the
 * eigenvector matrix `V`. Iterates in sweeps until the off-diagonal Frobenius
 * norm falls below `tol` or `maxSweeps` is reached. Eigenvalues land on the
 * diagonal of the transformed matrix.
 *
 * @param Ain  Symmetric `n×n` matrix, row-major, length `n*n`. Not mutated.
 * @param n    Dimension.
 * @param tol  Off-diagonal Frobenius-norm convergence threshold (default 1e-12).
 * @param maxSweeps Hard sweep cap to guarantee termination (default 100).
 * @returns `{ values, vectors }` where `values[i]` is the i-th eigenvalue and
 *   `vectors` is row-major `n×n` whose COLUMN `i` is the corresponding unit
 *   eigenvector. (Eigenpairs are not sorted.)
 */
function jacobiEigenSymmetric(
  Ain: readonly number[],
  n: number,
  tol = 1e-12,
  maxSweeps = 100,
): { values: number[]; vectors: number[] } {
  // Working copy of A (will be diagonalized in place).
  const a = Ain.slice();
  // Eigenvector accumulator, initialised to identity.
  const v = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;

  const offDiagNorm = (): number => {
    let s = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const x = a[p * n + q];
        s += 2 * x * x; // symmetric: count (p,q) and (q,p)
      }
    }
    return Math.sqrt(s);
  };

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    if (offDiagNorm() < tol) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < kEps) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        // Rotation angle that zeros a[p][q]: cot(2θ) = (aqq-app)/(2*apq).
        const phi = (aqq - app) / (2 * apq);
        // t = sign(phi)/(|phi|+sqrt(phi^2+1)) is the smaller root tan(θ).
        const t =
          (phi >= 0 ? 1 : -1) / (Math.abs(phi) + Math.sqrt(phi * phi + 1));
        const c = 1 / Math.sqrt(t * t + 1); // cos θ
        const s = t * c; // sin θ

        // Apply the Givens rotation J^T A J for rows/cols p,q.
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        // Accumulate the rotation into V (columns p,q).
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const values = new Array<number>(n);
  for (let i = 0; i < n; i++) values[i] = a[i * n + i];
  return { values, vectors: v };
}

// ---------------------------------------------------------------------------
// Homography (bed plane Z=0 ⇄ image)
// ---------------------------------------------------------------------------

/**
 * Isotropically normalize a set of 2D points: translate so the centroid is at
 * the origin and scale so the mean distance to the origin is √2. Returns the
 * normalized points plus the row-major 3×3 similarity transform `T` such that
 * `[x_n, y_n, 1]ᵀ = T · [x, y, 1]ᵀ`.
 */
function normalizePoints(pts: readonly Vec2[]): { norm: Vec2[]; T: Mat3 } {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;

  let meanDist = 0;
  for (const p of pts) meanDist += Math.hypot(p[0] - cx, p[1] - cy);
  meanDist /= n;

  // Scale so mean distance becomes √2. Guard the degenerate (all-coincident) case.
  const scale = meanDist > kEps ? Math.SQRT2 / meanDist : 1;

  const T: Mat3 = [scale, 0, -scale * cx, 0, scale, -scale * cy, 0, 0, 1];
  const norm: Vec2[] = pts.map((p) => [
    scale * (p[0] - cx),
    scale * (p[1] - cy),
  ]);
  return { norm, T };
}

/**
 * Solve the planar homography mapping `src → dst` (so `dst ≈ H · src` in
 * homogeneous coordinates), e.g. bed-plane world points → image pixels or vice
 * versa.
 *
 * Uses the NORMALIZED Direct Linear Transform:
 *   1. Isotropically normalize `src` and `dst` (centroid to origin, mean radius
 *      √2) → transforms `Tsrc`, `Tdst`.
 *   2. Build the 2N×9 DLT constraint matrix `A`.
 *   3. Form the 9×9 symmetric normal matrix `M = AᵀA`.
 *   4. Take the eigenvector of `M`'s SMALLEST eigenvalue (via
 *      {@link jacobiEigenSymmetric}) — the homogeneous least-squares null vector.
 *   5. Reshape to 3×3 (`Hn`) and denormalize: `H = Tdst⁻¹ · Hn · Tsrc`.
 *   6. Normalize so `H[8] === 1` when `H[8]` is non-zero.
 *
 * @param src Source points; length must equal `dst.length` and be ≥ 4.
 * @param dst Destination points.
 * @returns The row-major 3×3 homography, or `null` if there are fewer than 4
 *   correspondences or the system is degenerate (e.g. collinear points).
 */
export function solveHomography(src: Vec2[], dst: Vec2[]): Mat3 | null {
  const n = src.length;
  if (n < 4 || dst.length !== n) return null;

  const { norm: s, T: Tsrc } = normalizePoints(src);
  const { norm: d, T: Tdst } = normalizePoints(dst);

  // Build A (2N×9). Each correspondence contributes two rows.
  const A: number[] = []; // flat row-major, length 2N*9
  for (let i = 0; i < n; i++) {
    const x = s[i][0];
    const y = s[i][1];
    const u = d[i][0];
    const vv = d[i][1];
    // Row 1: [ -x, -y, -1, 0, 0, 0, u*x, u*y, u ]
    A.push(-x, -y, -1, 0, 0, 0, u * x, u * y, u);
    // Row 2: [ 0, 0, 0, -x, -y, -1, v*x, v*y, v ]
    A.push(0, 0, 0, -x, -y, -1, vv * x, vv * y, vv);
  }

  // M = AᵀA  (9×9 symmetric).
  const rows = 2 * n;
  const M = new Array<number>(81).fill(0);
  for (let p = 0; p < 9; p++) {
    for (let q = p; q < 9; q++) {
      let sum = 0;
      for (let r = 0; r < rows; r++) {
        sum += A[r * 9 + p] * A[r * 9 + q];
      }
      M[p * 9 + q] = sum;
      M[q * 9 + p] = sum;
    }
  }

  const { values, vectors } = jacobiEigenSymmetric(M, 9);

  // Eigenvector of the smallest eigenvalue.
  let minIdx = 0;
  for (let i = 1; i < 9; i++) if (values[i] < values[minIdx]) minIdx = i;

  // Extract column `minIdx` from `vectors` (row-major 9×9).
  const h = new Array<number>(9);
  let hNorm = 0;
  for (let i = 0; i < 9; i++) {
    h[i] = vectors[i * 9 + minIdx];
    hNorm += h[i] * h[i];
  }
  if (hNorm < kEps) return null; // degenerate / no solution

  const Hn: Mat3 = h;

  // Denormalize: H = Tdst⁻¹ · Hn · Tsrc.
  const TdstInv = invertMat3(Tdst);
  if (TdstInv === null) return null;
  let H = mat3Mul(mat3Mul(TdstInv, Hn), Tsrc);

  // Normalize so H[8] === 1 when possible.
  if (Math.abs(H[8]) > kEps) {
    const inv = 1 / H[8];
    H = H.map((v) => v * inv);
  }
  return H;
}

/**
 * Apply a homography to a point: compute `[x', y', w'] = H · [x, y, 1]ᵀ` and
 * return the dehomogenized `[x'/w', y'/w']`.
 *
 * @param H Row-major 3×3 homography.
 * @param p Input point.
 * @returns The mapped point. If `w'` is ~0 (point at infinity) the raw
 *   `[x', y']` is returned to avoid `NaN`/`Infinity`.
 */
export function applyHomography(H: Mat3, p: Vec2): Vec2 {
  const x = H[0] * p[0] + H[1] * p[1] + H[2];
  const y = H[3] * p[0] + H[4] * p[1] + H[5];
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  if (Math.abs(w) < kEps) return [x, y];
  return [x / w, y / w];
}

/**
 * Invert a row-major 3×3 matrix.
 *
 * @param m Row-major 3×3 matrix.
 * @returns The inverse (row-major), or `null` if `|det| < 1e-12` (singular).
 */
export function invertMat3(m: Mat3): Mat3 | null {
  const a = m[0];
  const b = m[1];
  const c = m[2];
  const d = m[3];
  const e = m[4];
  const f = m[5];
  const g = m[6];
  const h = m[7];
  const i = m[8];

  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < kEps) return null;
  const inv = 1 / det;

  // Adjugate (cofactor transpose) times 1/det.
  return [
    A * inv,
    (c * h - b * i) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    (c * d - a * f) * inv,
    C * inv,
    (b * g - a * h) * inv,
    (a * e - b * d) * inv,
  ];
}

/**
 * Root-mean-square reprojection error of a homography over a correspondence
 * set: `sqrt( mean_i | applyHomography(H, src_i) − dst_i |² )`.
 *
 * @param H Row-major 3×3 homography mapping `src → dst`.
 * @param src Source points.
 * @param dst Destination points (same length as `src`).
 * @returns The RMS pixel/mm error. Returns 0 for an empty / mismatched set.
 */
export function reprojectionRMS(H: Mat3, src: Vec2[], dst: Vec2[]): number {
  const n = src.length;
  if (n === 0 || dst.length !== n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const m = applyHomography(H, src[i]);
    const dx = m[0] - dst[i][0];
    const dy = m[1] - dst[i][1];
    sum += dx * dx + dy * dy;
  }
  return Math.sqrt(sum / n);
}

// ---------------------------------------------------------------------------
// Camera intrinsics & planar pose
// ---------------------------------------------------------------------------

/**
 * Build an ASSUMED pinhole intrinsic matrix from the image size and a guessed
 * horizontal field of view.
 *
 * `K = [[f, 0, cx], [0, f, cy], [0, 0, 1]]` (row-major), with
 * `f = (width/2) / tan(hfovDeg/2)`, `cx = width/2`, `cy = height/2`. Square
 * pixels and zero skew are assumed, and lens distortion is ignored. This is a
 * convenience guess for when no real calibration is available — replace with a
 * calibrated K for accurate metrology.
 *
 * @param width Image width in pixels.
 * @param height Image height in pixels.
 * @param hfovDeg Assumed horizontal FOV in degrees (default 60).
 * @returns The row-major 3×3 intrinsic matrix.
 */
export function assumedIntrinsics(
  width: number,
  height: number,
  hfovDeg = 60,
): Mat3 {
  const f = width / 2 / Math.tan((hfovDeg * Math.PI) / 180 / 2);
  const cx = width / 2;
  const cy = height / 2;
  return [f, 0, cx, 0, f, cy, 0, 0, 1];
}

/**
 * Decompose a bed-plane→image homography into a camera pose.
 *
 * `Hworld2img` maps world points on the bed plane `(X, Y, Z=0)` to image
 * pixels. Standard planar decomposition:
 *   - `B = K⁻¹ · H`; the columns are `b1, b2, b3`.
 *   - Scale `λ = 1 / ‖b1‖` (using `b1` so the rotation columns become unit
 *     length); `r1 = λ·b1`, `r2 = λ·b2`, `t = λ·b3`.
 *   - `r3 = r1 × r2`; assemble `R = [r1 r2 r3]` (as COLUMNS).
 *   - Re-orthonormalize `R` (Gram-Schmidt / cross-product cleanup) so
 *     `det(R) ≈ +1`.
 *   - Ensure the camera sees the bed in front of it: if `t_z < 0`, negate `λ`
 *     (flips the sign of `r1, r2, t`) and rebuild `r3`.
 *
 * @param Hworld2img Row-major 3×3 homography (world bed plane → image pixels).
 *   The caller typically computes this as `invertMat3(imgToWorldH)`.
 * @param K Row-major 3×3 intrinsics.
 * @returns The {@link CameraPose}, or `null` if `K` is singular or the
 *   homography is degenerate.
 */
export function poseFromPlaneHomography(
  Hworld2img: Mat3,
  K: Mat3,
): CameraPose | null {
  const Kinv = invertMat3(K);
  if (Kinv === null) return null;

  const B = mat3Mul(Kinv, Hworld2img); // row-major 3×3

  // Columns of B.
  let b1: Vec3 = [B[0], B[3], B[6]];
  let b2: Vec3 = [B[1], B[4], B[7]];
  let b3: Vec3 = [B[2], B[5], B[8]];

  const n1 = norm3(b1);
  if (n1 < kEps) return null;
  let lambda = 1 / n1;

  // Tentative translation to decide the front-of-camera sign.
  let tz = lambda * b3[2];
  if (tz < 0) lambda = -lambda;

  let r1: Vec3 = [lambda * b1[0], lambda * b1[1], lambda * b1[2]];
  let r2: Vec3 = [lambda * b2[0], lambda * b2[1], lambda * b2[2]];
  const t: Vec3 = [lambda * b3[0], lambda * b3[1], lambda * b3[2]];

  // --- Re-orthonormalize R so it is a proper rotation (det ≈ +1) ---
  // Gram-Schmidt: keep r1 direction, make r2 orthogonal to it, r3 = r1 × r2.
  const r1n = norm3(r1);
  if (r1n < kEps) return null;
  r1 = [r1[0] / r1n, r1[1] / r1n, r1[2] / r1n];

  const dot12 = r2[0] * r1[0] + r2[1] * r1[1] + r2[2] * r1[2];
  let r2o: Vec3 = [
    r2[0] - dot12 * r1[0],
    r2[1] - dot12 * r1[1],
    r2[2] - dot12 * r1[2],
  ];
  const r2n = norm3(r2o);
  if (r2n < kEps) return null;
  r2o = [r2o[0] / r2n, r2o[1] / r2n, r2o[2] / r2n];

  const r3 = cross3(r1, r2o); // already unit length since r1 ⟂ r2o, both unit

  // Assemble R with r1,r2,r3 as COLUMNS (row-major storage).
  const R: Mat3 = [
    r1[0],
    r2o[0],
    r3[0],
    r1[1],
    r2o[1],
    r3[1],
    r1[2],
    r2o[2],
    r3[2],
  ];

  // (Suppress unused-binding lint for the pre-orthonormal vectors.)
  void b1;
  void b2;
  void b3;
  void tz;

  return { K, R, t };
}

/**
 * Project a 3D world point into image pixels through a camera pose:
 * `x = K · (R · P + t)`, then divide by the homogeneous `z`.
 *
 * @param pose Camera pose (intrinsics + world→camera extrinsics).
 * @param P World point `[X, Y, Z]` in mm.
 * @returns The image pixel `[u, v]`. If the camera-space depth is ~0 the raw
 *   `[u, v]` is returned to avoid division blow-up (caller should bounds-check).
 */
export function projectPoint(pose: CameraPose, P: Vec3): Vec2 {
  const rp = mat3MulVec3(pose.R, P);
  const cam: Vec3 = [rp[0] + pose.t[0], rp[1] + pose.t[1], rp[2] + pose.t[2]];
  const img = mat3MulVec3(pose.K, cam);
  const w = img[2];
  if (Math.abs(w) < kEps) return [img[0], img[1]];
  return [img[0] / w, img[1] / w];
}

// ---------------------------------------------------------------------------
// Markerless silhouette extraction
// ---------------------------------------------------------------------------

/**
 * Convert a packed RGBA byte buffer to a single-channel grayscale image using
 * the Rec.601 luma weights `0.299·R + 0.587·G + 0.114·B`.
 *
 * @param rgba Packed RGBA pixels, length `width*height*4`.
 * @param width Image width.
 * @param height Image height.
 * @returns A new {@link GrayImage} (rounded, clamped to 0..255).
 */
export function toGray(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): GrayImage {
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const g = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    out[i] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
  }
  return { data: out, width, height };
}

/**
 * Compute a binary silhouette mask by absolute-difference thresholding a
 * current frame against a reference (empty-bed) frame.
 *
 * @param ref Reference grayscale image (e.g. the empty bed).
 * @param cur Current grayscale image (same dimensions).
 * @param threshold Per-pixel absolute-difference threshold; `1` where
 *   `|cur − ref| > threshold`, else `0`.
 * @returns A `width*height` {@link Uint8Array} of 0/1 values.
 * @throws If `ref` and `cur` dimensions differ.
 */
export function silhouetteMask(
  ref: GrayImage,
  cur: GrayImage,
  threshold: number,
): Uint8Array {
  if (ref.width !== cur.width || ref.height !== cur.height) {
    throw new Error(
      `silhouetteMask: dimension mismatch (${ref.width}x${ref.height} vs ${cur.width}x${cur.height})`,
    );
  }
  const n = ref.width * ref.height;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    mask[i] = Math.abs(cur.data[i] - ref.data[i]) > threshold ? 1 : 0;
  }
  return mask;
}

/**
 * Find the largest connected component (4-connectivity flood fill) of a binary
 * mask, take its tight pixel-space bounding box, map that box's four corners
 * through `imgToWorldH` into bed-mm, and return the mm-space axis-aligned
 * bounding {@link Rect}.
 *
 * Mapping all four corners (rather than just min/max) and then taking the
 * extents is correct because the homography is a perspective map — a pixel
 * AABB does not stay axis-aligned in world space.
 *
 * @param mask Binary mask (0/1), length `width*height`, row-major.
 * @param width Mask width.
 * @param height Mask height.
 * @param imgToWorldH Row-major 3×3 homography mapping image pixels → bed-mm.
 * @returns The mm-space bounding rect of the largest blob, or `null` if the
 *   mask is entirely empty.
 */
export function largestBlobBBoxMm(
  mask: Uint8Array,
  width: number,
  height: number,
  imgToWorldH: Mat3,
): Rect | null {
  const n = width * height;
  const visited = new Uint8Array(n);
  // Iterative flood-fill stack of pixel indices (avoids recursion blowups).
  const stack = new Int32Array(n);

  let bestSize = 0;
  let bMinX = 0;
  let bMinY = 0;
  let bMaxX = 0;
  let bMaxY = 0;

  for (let start = 0; start < n; start++) {
    if (mask[start] !== 1 || visited[start] === 1) continue;

    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;

    let size = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    while (sp > 0) {
      const idx = stack[--sp];
      const px = idx % width;
      const py = (idx - px) / width;
      size++;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;

      // 4-connected neighbours.
      if (px > 0) {
        const nIdx = idx - 1;
        if (mask[nIdx] === 1 && visited[nIdx] === 0) {
          visited[nIdx] = 1;
          stack[sp++] = nIdx;
        }
      }
      if (px + 1 < width) {
        const nIdx = idx + 1;
        if (mask[nIdx] === 1 && visited[nIdx] === 0) {
          visited[nIdx] = 1;
          stack[sp++] = nIdx;
        }
      }
      if (py > 0) {
        const nIdx = idx - width;
        if (mask[nIdx] === 1 && visited[nIdx] === 0) {
          visited[nIdx] = 1;
          stack[sp++] = nIdx;
        }
      }
      if (py + 1 < height) {
        const nIdx = idx + width;
        if (mask[nIdx] === 1 && visited[nIdx] === 0) {
          visited[nIdx] = 1;
          stack[sp++] = nIdx;
        }
      }
    }

    if (size > bestSize) {
      bestSize = size;
      bMinX = minX;
      bMinY = minY;
      bMaxX = maxX;
      bMaxY = maxY;
    }
  }

  if (bestSize === 0) return null;

  // Map the 4 pixel corners to bed-mm and take extents. Use maxX+1 / maxY+1 so
  // the box spans the full extent of the rightmost/bottommost pixels.
  const corners: Vec2[] = [
    [bMinX, bMinY],
    [bMaxX + 1, bMinY],
    [bMaxX + 1, bMaxY + 1],
    [bMinX, bMaxY + 1],
  ];
  let wMinX = Infinity;
  let wMinY = Infinity;
  let wMaxX = -Infinity;
  let wMaxY = -Infinity;
  for (const c of corners) {
    const w = applyHomography(imgToWorldH, c);
    if (w[0] < wMinX) wMinX = w[0];
    if (w[1] < wMinY) wMinY = w[1];
    if (w[0] > wMaxX) wMaxX = w[0];
    if (w[1] > wMaxY) wMaxY = w[1];
  }
  return { minX: wMinX, minY: wMinY, maxX: wMaxX, maxY: wMaxY };
}

/**
 * Per-pixel MEDIAN of several equally-sized grayscale frames → a background
 * estimate. Used by automatic calibration: snap a frame of the bed at each of
 * N tool positions; the tool sits at a DIFFERENT pixel in every frame, so the
 * per-pixel median across them removes it and leaves the static bed/background.
 * Each frame minus this background then isolates the tool (see
 * {@link largestBlobCentroidPx}).
 *
 * @param frames ≥1 frames, all the same width×height.
 * @returns A new {@link GrayImage} of the per-pixel medians.
 * @throws If `frames` is empty or any frame's dimensions differ.
 */
export function medianGray(frames: GrayImage[]): GrayImage {
  if (frames.length === 0) throw new Error('medianGray: no frames');
  const { width, height } = frames[0];
  for (const f of frames) {
    if (f.width !== width || f.height !== height)
      throw new Error('medianGray: frame dimensions differ');
  }
  const n = width * height;
  const k = frames.length;
  const out = new Uint8Array(n);
  const col = new Array<number>(k);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) col[j] = frames[j].data[i];
    col.sort((a, b) => a - b);
    const mid = k >> 1;
    out[i] = k % 2 ? col[mid] : Math.round((col[mid - 1] + col[mid]) / 2);
  }
  return { data: out, width, height };
}

/**
 * Find the largest connected component (4-connectivity flood fill) of a binary
 * mask and return its CENTROID in pixel coordinates (the mean of its pixel
 * positions). Used by automatic calibration to locate the tool blob's centre in
 * each frame (after background subtraction) for pairing with the known machine
 * position. Returns `null` if the mask is empty.
 *
 * @param mask Binary mask (0/1), length `width*height`, row-major.
 * @param width Mask width.
 * @param height Mask height.
 * @param minArea Reject the result if the largest blob is smaller than this many
 *   pixels (default 0 = no minimum). Guards against tiny lighting/shadow specks
 *   producing a garbage centroid.
 * @returns The largest blob's pixel centroid `[x, y]`, or `null` if the mask is
 *   empty or the largest blob is below `minArea`.
 */
export function largestBlobCentroidPx(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea = 0,
): Vec2 | null {
  const n = width * height;
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);

  let bestSize = 0;
  let bestCx = 0;
  let bestCy = 0;

  for (let start = 0; start < n; start++) {
    if (mask[start] !== 1 || visited[start] === 1) continue;

    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;

    let size = 0;
    let sumX = 0;
    let sumY = 0;

    while (sp > 0) {
      const idx = stack[--sp];
      const px = idx % width;
      const py = (idx - px) / width;
      size++;
      sumX += px;
      sumY += py;

      if (px > 0) {
        const nIdx = idx - 1;
        if (mask[nIdx] === 1 && visited[nIdx] === 0) { visited[nIdx] = 1; stack[sp++] = nIdx; }
      }
      if (px + 1 < width) {
        const nIdx = idx + 1;
        if (mask[nIdx] === 1 && visited[nIdx] === 0) { visited[nIdx] = 1; stack[sp++] = nIdx; }
      }
      if (py > 0) {
        const nIdx = idx - width;
        if (mask[nIdx] === 1 && visited[nIdx] === 0) { visited[nIdx] = 1; stack[sp++] = nIdx; }
      }
      if (py + 1 < height) {
        const nIdx = idx + width;
        if (mask[nIdx] === 1 && visited[nIdx] === 0) { visited[nIdx] = 1; stack[sp++] = nIdx; }
      }
    }

    if (size > bestSize) {
      bestSize = size;
      bestCx = sumX / size;
      bestCy = sumY / size;
    }
  }

  if (bestSize === 0 || bestSize < minArea) return null;
  return [bestCx, bestCy];
}

// ---------------------------------------------------------------------------
// Global pixel shift + per-axis kinematics classification
// ---------------------------------------------------------------------------
//
// WHY this exists (kinematics-awareness):
//   On a machine where one axis moves the HEAD and another moves the BED under a
//   FIXED/overhead camera, jogging the two axes produces TWO different kinds of
//   image change:
//     • HEAD axis  → a small LOCALIZED blob (the tool) translates; the bed/
//                    background stays put. Detected by background-diff +
//                    largest-blob-centroid delta (the existing tool-tracking).
//     • BED axis   → the WHOLE image translates coherently (every bed pixel
//                    shifts by the same vector); the tool stays roughly put.
//                    Detected by a GLOBAL image-translation estimate.
//   The legacy auto-cal only tracked the tool blob, so a bed-moving axis showed
//   ~no blob motion → the solve was degenerate in that axis. The functions below
//   measure the RIGHT pixel displacement for either kinematic, so a single
//   pixel-per-mm vector can be recovered per machine axis regardless of whether
//   it drives the head or the bed.

/**
 * Result of {@link estimateGlobalShift}: the best whole-image translation
 * `(dx, dy)` in pixels mapping `prev`→`cur` (i.e. a feature at `p` in `prev`
 * appears near `p + (dx, dy)` in `cur`), plus a `score` in `[0, 1]` measuring
 * how coherently the image actually moved by that amount (match confidence).
 */
export interface GlobalShift {
  /** Best horizontal shift, pixels (prev→cur). */
  dx: number;
  /** Best vertical shift, pixels (prev→cur). */
  dy: number;
  /**
   * Coherence/confidence in `[0, 1]`. Roughly: how much better the best shift's
   * normalized correlation is than a no-information baseline. ~0 ⇒ no coherent
   * global motion (noise / a tiny local change); → 1 ⇒ a clean rigid shift of
   * the whole frame. See {@link classifyAxisMotion} for the threshold used.
   */
  score: number;
}

/**
 * Box-downsample a {@link GrayImage} by an integer factor (averaging each
 * `factor×factor` block). Used to make the brute-force shift search cheap: a
 * coarse pass on the downsampled image, then a fine pass at full resolution
 * around the coarse winner. Returns the image unchanged for `factor <= 1`.
 */
function downsampleGray(img: GrayImage, factor: number): GrayImage {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return img;
  const ow = Math.max(1, Math.floor(img.width / f));
  const oh = Math.max(1, Math.floor(img.height / f));
  const out = new Uint8Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const sy0 = oy * f;
    for (let ox = 0; ox < ow; ox++) {
      const sx0 = ox * f;
      let sum = 0;
      let cnt = 0;
      for (let dy = 0; dy < f; dy++) {
        const sy = sy0 + dy;
        if (sy >= img.height) break;
        const row = sy * img.width;
        for (let dx = 0; dx < f; dx++) {
          const sx = sx0 + dx;
          if (sx >= img.width) break;
          sum += img.data[row + sx];
          cnt++;
        }
      }
      out[oy * ow + ox] = cnt > 0 ? Math.round(sum / cnt) : 0;
    }
  }
  return { data: out, width: ow, height: oh };
}

/**
 * Normalized cross-correlation of `cur` shifted by `(sx, sy)` against `prev`
 * over their overlapping region (zero-mean, unit-variance per the overlap). The
 * score is in `[-1, 1]`; `coverage` is the fraction of `prev` that overlapped.
 * A shift with too little overlap (coverage below `minCoverage`) returns a NCC
 * of `-Infinity` so the search never prefers a degenerate sliver overlap.
 */
function nccAtShift(
  prev: GrayImage,
  cur: GrayImage,
  sx: number,
  sy: number,
  minCoverage: number,
): { ncc: number; coverage: number } {
  const w = prev.width;
  const h = prev.height;
  // Overlap of prev[x,y] with cur[x+sx, y+sy].
  const x0 = Math.max(0, -sx);
  const x1 = Math.min(w, w - sx);
  const y0 = Math.max(0, -sy);
  const y1 = Math.min(h, h - sy);
  const ow = x1 - x0;
  const oh = y1 - y0;
  const total = w * h;
  if (ow <= 0 || oh <= 0) return { ncc: -Infinity, coverage: 0 };
  const n = ow * oh;
  const coverage = n / total;
  if (coverage < minCoverage) return { ncc: -Infinity, coverage };

  let sa = 0;
  let sb = 0;
  for (let y = y0; y < y1; y++) {
    const pr = y * w;
    const cr = (y + sy) * cur.width;
    for (let x = x0; x < x1; x++) {
      sa += prev.data[pr + x];
      sb += cur.data[cr + (x + sx)];
    }
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da2 = 0;
  let db2 = 0;
  for (let y = y0; y < y1; y++) {
    const pr = y * w;
    const cr = (y + sy) * cur.width;
    for (let x = x0; x < x1; x++) {
      const a = prev.data[pr + x] - ma;
      const b = cur.data[cr + (x + sx)] - mb;
      num += a * b;
      da2 += a * a;
      db2 += b * b;
    }
  }
  const denom = Math.sqrt(da2 * db2);
  if (denom < kEps) return { ncc: 0, coverage };
  return { ncc: num / denom, coverage };
}

/**
 * Estimate the best whole-image translation between two same-size grayscale
 * frames by a coarse-to-fine normalized-cross-correlation (NCC) search.
 *
 * Strategy:
 *   1. COARSE: downsample both frames by a factor chosen so `maxShiftPx` maps to
 *      a small integer search radius, then brute-force every integer shift in
 *      `±ceil(maxShiftPx/factor)` and keep the highest-NCC one (scaled back up).
 *   2. FINE: brute-force every integer shift in a small ±factor window around the
 *      coarse winner at FULL resolution.
 * The reported `score` blends the winning NCC with how decisively it beat the
 * zero-shift / runner-up baseline, clamped to `[0, 1]`.
 *
 * @param prev Previous frame.
 * @param cur  Current frame (same dimensions as `prev`).
 * @param maxShiftPx Maximum |shift| to search, pixels (both axes). Clamped to the
 *   frame size.
 * @returns `{ dx, dy, score }`. On dimension mismatch or an empty frame returns
 *   `{ dx: 0, dy: 0, score: 0 }`.
 */
export function estimateGlobalShift(
  prev: GrayImage,
  cur: GrayImage,
  maxShiftPx: number,
): GlobalShift {
  if (
    prev.width !== cur.width ||
    prev.height !== cur.height ||
    prev.width <= 0 ||
    prev.height <= 0
  ) {
    return { dx: 0, dy: 0, score: 0 };
  }
  const maxShift = Math.max(
    1,
    Math.min(Math.floor(maxShiftPx), prev.width - 1, prev.height - 1),
  );
  // Require enough overlap that the match is meaningful even at the max shift.
  const minCoverage = 0.4;

  // --- coarse pass on a downsampled image ---
  // Pick a factor so the coarse search radius stays small (≤ ~12 steps).
  const factor = Math.max(1, Math.round(maxShift / 12));
  const dp = downsampleGray(prev, factor);
  const dc = downsampleGray(cur, factor);
  const coarseR = Math.max(1, Math.ceil(maxShift / factor));

  let bestC = { ncc: -Infinity, sx: 0, sy: 0 };
  let secondBestNcc = -Infinity;
  for (let sy = -coarseR; sy <= coarseR; sy++) {
    for (let sx = -coarseR; sx <= coarseR; sx++) {
      const { ncc } = nccAtShift(dp, dc, sx, sy, minCoverage);
      if (ncc > bestC.ncc) {
        secondBestNcc = bestC.ncc;
        bestC = { ncc, sx, sy };
      } else if (ncc > secondBestNcc) {
        secondBestNcc = ncc;
      }
    }
  }

  // --- fine pass at full resolution around the coarse winner ---
  const cx = bestC.sx * factor;
  const cy = bestC.sy * factor;
  const fineR = factor; // refine within one coarse cell
  let bestF = { ncc: -Infinity, sx: cx, sy: cy };
  for (let sy = cy - fineR; sy <= cy + fineR; sy++) {
    if (sy < -maxShift || sy > maxShift) continue;
    for (let sx = cx - fineR; sx <= cx + fineR; sx++) {
      if (sx < -maxShift || sx > maxShift) continue;
      const { ncc } = nccAtShift(prev, cur, sx, sy, minCoverage);
      if (ncc > bestF.ncc) bestF = { ncc, sx, sy };
    }
  }

  // Confidence: a clean rigid shift of a textured frame has a peak NCC very near
  // 1, so the PEAK is the primary coherence signal (how well the whole frame
  // actually matched at the best shift). On a smooth/low-texture bed neighbouring
  // shifts also correlate highly, so a large best-vs-runner-up MARGIN is a bonus
  // (sharp, unambiguous peak) — not a requirement. We therefore weight the peak
  // heavily and add only a small margin bonus. (secondBestNcc can be -Infinity if
  // only one shift had enough coverage — treat that as a decisive, sharp peak.)
  const peak = Math.max(0, Math.min(1, bestF.ncc)); // [0,1]
  const margin = Number.isFinite(secondBestNcc)
    ? Math.max(0, Math.min(1, bestC.ncc - secondBestNcc))
    : 1;
  const score = Math.max(0, Math.min(1, peak * (0.85 + 0.15 * margin)));

  return { dx: bestF.sx, dy: bestF.sy, score };
}

/**
 * Per-axis motion classification: decide whether a probe jog moved the HEAD (a
 * small localized blob translated) or the BED (the whole frame translated), and
 * report the pixel displacement appropriate to whichever it was.
 *
 * Algorithm:
 *   1. Estimate the GLOBAL pixel shift `(gdx, gdy)` and its coherence `gscore`
 *      via {@link estimateGlobalShift} (search radius {@link maxShiftPx}).
 *   2. Estimate LOCALIZED motion: build a frame-diff mask
 *      (`silhouetteMask(prev, cur, diffThreshold)`), take its largest blob; if a
 *      blob exists in BOTH frames (diff'd the other way too) take the centroid
 *      delta. Here we approximate the blob delta from the single forward diff by
 *      locating the largest *changed* region in each frame separately.
 *   3. Classify:
 *      - If `gscore ≥ GLOBAL_COHERENCE_MIN` and the global shift magnitude is
 *        non-trivial (≥ `MIN_MOTION_PX`) ⇒ **'bed'**, `px = (gdx, gdy)`.
 *      - Else if a localized blob moved by ≥ `MIN_MOTION_PX` and that blob is
 *        SMALL relative to the frame (area fraction ≤ `LOCAL_AREA_FRAC_MAX`) ⇒
 *        **'head'**, `px =` the blob-centroid delta.
 *      - Else ⇒ **'none'** (negligible / ambiguous motion).
 *
 * THRESHOLDS (documented; these are starting points and MAY NEED REAL-FRAME
 * TUNING — lighting, texture, and lens distortion all affect them):
 *   - `GLOBAL_COHERENCE_MIN = 0.55` — minimum {@link estimateGlobalShift} score
 *     to believe the WHOLE frame moved coherently. A textured bed under even
 *     light easily exceeds this; a blank/over-exposed bed may not (then a bed
 *     axis can fall through to 'none' — increase contrast or lower this).
 *   - `MIN_MOTION_PX = 1.5` — below this, motion is treated as noise.
 *   - `LOCAL_AREA_FRAC_MAX = 0.25` — the moving region must cover ≤25% of the
 *     frame to count as a localized (head/tool) move; a larger changed area is a
 *     global (bed) move in disguise.
 *   - `diffThreshold` (caller-supplied, default 28) — per-pixel abs-diff for the
 *     localized mask; same knob as the existing tool detector.
 *
 * @param prev Frame BEFORE the probe jog.
 * @param cur  Frame AFTER the probe jog (same dimensions).
 * @param opts Optional `maxShiftPx` (default = 40% of the smaller dimension) and
 *   `diffThreshold` (default 28).
 * @returns `{ kind, px, confidence }` where `px` is the pixel displacement for
 *   the detected kinematic (zero vector for 'none') and `confidence ∈ [0,1]`.
 */
export function classifyAxisMotion(
  prev: GrayImage,
  cur: GrayImage,
  opts?: { maxShiftPx?: number; diffThreshold?: number },
): { kind: 'head' | 'bed' | 'none'; px: [number, number]; confidence: number } {
  if (
    prev.width !== cur.width ||
    prev.height !== cur.height ||
    prev.width <= 0 ||
    prev.height <= 0
  ) {
    return { kind: 'none', px: [0, 0], confidence: 0 };
  }

  const GLOBAL_COHERENCE_MIN = 0.55;
  const MIN_MOTION_PX = 1.5;
  const LOCAL_AREA_FRAC_MAX = 0.25;

  const w = prev.width;
  const h = prev.height;
  const maxShiftPx =
    opts?.maxShiftPx != null
      ? opts.maxShiftPx
      : Math.max(4, Math.round(Math.min(w, h) * 0.4));
  const diffThreshold = opts?.diffThreshold != null ? opts.diffThreshold : 28;

  // (1) Global shift.
  const g = estimateGlobalShift(prev, cur, maxShiftPx);
  const gMag = Math.hypot(g.dx, g.dy);

  // (2) Localized blob delta. The tool sits at a DIFFERENT pixel in prev vs cur,
  // so the abs-diff mask lights up TWO blobs (the tool's old + new positions).
  // We locate the largest changed region in each direction: the centroid of the
  // pixels that became "tool-colored" in `cur` (cur vs prev) and in `prev`
  // (prev vs cur are the same mask, so we split by which frame is brighter at
  // each masked pixel — old position belongs to prev, new to cur).
  const diff = silhouetteMask(prev, cur, diffThreshold);
  // Partition the changed pixels: a pixel where cur is brighter-or-different and
  // closer to the moving object lands in one of two sub-masks. Without colour we
  // approximate by "which frame has the locally-extreme value"; in practice the
  // tool is a consistent intensity, so we use the simpler robust split: the
  // largest blob of the FULL diff is the union of old+new tool footprints. We
  // instead compare per-frame backgrounds: mask pixels where prev deviates from
  // cur's local mean → prev footprint; vice-versa → cur footprint.
  const prevMask = new Uint8Array(w * h);
  const curMask = new Uint8Array(w * h);
  // Global means as a cheap "background" proxy for the bright/dark decision.
  let sp = 0;
  let sc = 0;
  for (let i = 0; i < diff.length; i++) {
    sp += prev.data[i];
    sc += cur.data[i];
  }
  const mp = sp / diff.length;
  const mc = sc / diff.length;
  for (let i = 0; i < diff.length; i++) {
    if (diff[i] !== 1) continue;
    // The tool footprint is wherever a frame deviates most from its own mean.
    const dpv = Math.abs(prev.data[i] - mp);
    const dcv = Math.abs(cur.data[i] - mc);
    if (dpv >= dcv) prevMask[i] = 1;
    else curMask[i] = 1;
  }
  const cPrev = largestBlobCentroidPx(prevMask, w, h);
  const cCur = largestBlobCentroidPx(curMask, w, h);

  let blobDelta: [number, number] | null = null;
  let blobAreaFrac = 1;
  if (cPrev && cCur) {
    blobDelta = [cCur[0] - cPrev[0], cCur[1] - cPrev[1]];
    // Area of the larger footprint as a fraction of the frame.
    let area = 0;
    for (let i = 0; i < diff.length; i++) area += diff[i];
    blobAreaFrac = area / (w * h);
  }
  const blobMag = blobDelta ? Math.hypot(blobDelta[0], blobDelta[1]) : 0;

  // (3) Classify. Prefer 'bed' when the global shift is both coherent and real;
  // the bed move tends to ALSO trip the diff mask everywhere, so checking the
  // global coherence first avoids mislabelling a bed move as a (huge) blob.
  if (g.score >= GLOBAL_COHERENCE_MIN && gMag >= MIN_MOTION_PX) {
    return { kind: 'bed', px: [g.dx, g.dy], confidence: g.score };
  }
  if (
    blobDelta &&
    blobMag >= MIN_MOTION_PX &&
    blobAreaFrac <= LOCAL_AREA_FRAC_MAX
  ) {
    // Confidence scales with how localized + decisive the blob move was.
    const conf = Math.max(
      0,
      Math.min(1, 1 - blobAreaFrac / LOCAL_AREA_FRAC_MAX),
    );
    return { kind: 'head', px: blobDelta, confidence: Math.max(0.4, conf) };
  }
  return { kind: 'none', px: [0, 0], confidence: 0 };
}

// ---------------------------------------------------------------------------
// Visual hull (two-camera markerless job height)
// ---------------------------------------------------------------------------

/**
 * A regular grid of job heights over the bed. `z[iy*nx + ix]` is the carved
 * height (mm, ≥ 0) at the cell whose centre is `(x0 + ix*cell, y0 + iy*cell)`.
 */
export interface HeightField {
  /** Grid columns (X). */
  nx: number;
  /** Grid rows (Y). */
  ny: number;
  /** Cell spacing in mm (both axes). */
  cell: number;
  /** World X of the first cell centre, mm. */
  x0: number;
  /** World Y of the first cell centre, mm. */
  y0: number;
  /** Heights, row-major `nx*ny`, mm. */
  z: Float32Array;
  /** Maximum height across the field, mm. */
  maxZ: number;
}

/**
 * Carve a job-height field over the bed by silhouette space-carving from two or
 * more camera views.
 *
 * For every grid cell centre `(x, y)` over `bed` (spacing `cell`), scan `z`
 * from `maxHeight` down to `0` in steps of `zStep`. The cell's height is the
 * HIGHEST `z` whose 3D point `(x, y, z)` projects, in EVERY view, to an
 * in-bounds pixel whose silhouette mask value is `1`. If no such `z` exists the
 * height is `0`.
 *
 * This is a conservative outer hull from silhouettes alone: a point survives
 * only if all cameras agree it is occupied, so the result over-estimates
 * concavities that no camera can see into. More views tighten the hull.
 *
 * @param args.bed Bed extents in mm (the region to carve).
 * @param args.cell Grid spacing in mm.
 * @param args.maxHeight Highest Z to test, mm (scan starts here).
 * @param args.zStep Z scan step, mm.
 * @param args.views One {@link CameraPose} + silhouette mask per camera.
 * @returns The carved {@link HeightField}. Empty (zero-size) grids yield a
 *   field with `maxZ === 0`.
 */
export function visualHull(args: {
  bed: Rect;
  cell: number;
  maxHeight: number;
  zStep: number;
  views: {
    mask: Uint8Array;
    width: number;
    height: number;
    pose: CameraPose;
  }[];
}): HeightField {
  const { bed, cell, maxHeight, zStep, views } = args;

  const spanX = bed.maxX - bed.minX;
  const spanY = bed.maxY - bed.minY;
  const nx = cell > 0 ? Math.max(0, Math.floor(spanX / cell) + 1) : 0;
  const ny = cell > 0 ? Math.max(0, Math.floor(spanY / cell) + 1) : 0;
  const x0 = bed.minX;
  const y0 = bed.minY;
  const z = new Float32Array(nx * ny);

  const step = zStep > 0 ? zStep : Math.max(maxHeight, kEps);
  let maxZ = 0;

  for (let iy = 0; iy < ny; iy++) {
    const wy = y0 + iy * cell;
    for (let ix = 0; ix < nx; ix++) {
      const wx = x0 + ix * cell;

      // Scan from the top down; first occupied z wins (highest surviving point).
      let cellZ = 0;
      for (let zz = maxHeight; zz >= 0; zz -= step) {
        const P: Vec3 = [wx, wy, zz];
        let occupiedInAll = views.length > 0;
        for (const v of views) {
          const px = projectPoint(v.pose, P);
          const ux = Math.floor(px[0]);
          const uy = Math.floor(px[1]);
          if (ux < 0 || uy < 0 || ux >= v.width || uy >= v.height) {
            occupiedInAll = false;
            break;
          }
          if (v.mask[uy * v.width + ux] !== 1) {
            occupiedInAll = false;
            break;
          }
        }
        if (occupiedInAll) {
          cellZ = zz < 0 ? 0 : zz;
          break;
        }
      }

      z[iy * nx + ix] = cellZ;
      if (cellZ > maxZ) maxZ = cellZ;
    }
  }

  return { nx, ny, cell, x0, y0, z, maxZ };
}

// ---------------------------------------------------------------------------
// Fit check
// ---------------------------------------------------------------------------

/**
 * The result of comparing a design footprint against the detected job
 * footprint. `overhang` is per-side mm by which the design extends BEYOND the
 * job (0 when the design is inside on that side). `fits` is true iff no side
 * overhangs.
 */
export interface FitResult {
  /** True iff the design fits entirely within the job on all four sides. */
  fits: boolean;
  /** Per-side overhang in mm (≥ 0); 0 means the design is inside on that side. */
  overhang: { left: number; right: number; top: number; bottom: number };
}

/**
 * Check whether a design's axis-aligned footprint fits within the job's
 * detected footprint (both in bed-mm).
 *
 * Per-side overhang is how far the design protrudes past the job:
 *   - left   = `jobRect.minX − designBBox.minX`   (design extends left of job)
 *   - right  = `designBBox.maxX − jobRect.maxX`   (design extends right of job)
 *   - bottom = `jobRect.minY − designBBox.minY`
 *   - top    = `designBBox.maxY − jobRect.maxY`
 * Each is clamped to ≥ 0. `fits` is true iff all raw overhangs are ≤ 0.
 *
 * @param designBBox The design's bounding rect, mm.
 * @param jobRect The detected job's bounding rect, mm.
 * @returns A {@link FitResult}.
 */
export function fitCheck(designBBox: Rect, jobRect: Rect): FitResult {
  const left = jobRect.minX - designBBox.minX;
  const right = designBBox.maxX - jobRect.maxX;
  const bottom = jobRect.minY - designBBox.minY;
  const top = designBBox.maxY - jobRect.maxY;
  const fits = left <= 0 && right <= 0 && bottom <= 0 && top <= 0;
  return {
    fits,
    overhang: {
      left: Math.max(0, left),
      right: Math.max(0, right),
      top: Math.max(0, top),
      bottom: Math.max(0, bottom),
    },
  };
}

// ---------------------------------------------------------------------------
// Optional marker payload (QR convenience; markerless is primary)
// ---------------------------------------------------------------------------

/**
 * Parse the shipped marker payload format:
 *   `KMYG1|<KIND>|<token>|...|KEY=VALUE|...`
 *
 * The first field is the magic `KMYG1`; the second is the kind. Remaining
 * `|`-separated tokens are either `KEY=VALUE` pairs (stored in `fields`) or bare
 * positional tokens. Bare tokens that look like a corner label (`TL`/`TR`/`BL`/
 * `BR`, case-insensitive) are collected under `fields.pos` (comma-joined,
 * upper-cased); any other bare token is stored as `fields[<token>] = ''`.
 *
 * @param raw The raw payload string (e.g. decoded from a QR code).
 * @returns `{ kind, fields }`, or `null` if the payload does not start with
 *   `KMYG1|`.
 */
export function parseMarkerPayload(
  raw: string,
): { kind: string; fields: Record<string, string> } | null {
  if (typeof raw !== 'string' || !raw.startsWith('KMYG1|')) return null;

  const parts = raw.split('|');
  // parts[0] === 'KMYG1'; parts[1] === kind (may be '' if malformed).
  const kind = parts.length > 1 ? parts[1] : '';
  const fields: Record<string, string> = {};
  const positions: string[] = [];

  for (let i = 2; i < parts.length; i++) {
    const token = parts[i];
    if (token === '') continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (key !== '') fields[key] = value;
    } else {
      const upper = token.toUpperCase();
      if (upper === 'TL' || upper === 'TR' || upper === 'BL' || upper === 'BR') {
        positions.push(upper);
      } else {
        fields[token] = '';
      }
    }
  }

  if (positions.length > 0) fields.pos = positions.join(',');
  return { kind, fields };
}

/*
 * SELF-CHECK (reasoning, not executed)
 * ====================================
 * Goal: prove that solveHomography + applyHomography round-trip on a known map.
 *
 * Choose a deliberately simple homography: an affine scale-by-2 plus a
 * translate-by-(10, 20), i.e. the world point is  W = 2*I + (10, 20) for image
 * point I. As a 3×3 row-major matrix this is
 *
 *     Htrue = [ 2  0  10
 *               0  2  20
 *               0  0   1 ]
 *
 * and applyHomography(Htrue, [x, y]) = [2x + 10, 2y + 20] (w' = 1 always).
 *
 * Pick 4 NON-collinear image (src) points and map them through Htrue to get the
 * world (dst) points:
 *
 *     src                 dst = Htrue · src
 *     [0,   0]   ->   [ 2*0  + 10,  2*0  + 20 ] = [ 10,  20]
 *     [10,  0]   ->   [ 2*10 + 10,  2*0  + 20 ] = [ 30,  20]
 *     [10, 10]   ->   [ 2*10 + 10,  2*10 + 20 ] = [ 30,  40]
 *     [0,  10]   ->   [ 2*0  + 10,  2*10 + 20 ] = [ 10,  40]
 *
 * These 4 src points form a square (no 3 collinear), so the normalized-DLT
 * system is well-conditioned and has a unique (up to scale) solution.
 *
 * Walking the algorithm:
 *   1. normalizePoints(src): centroid = (5, 5); mean distance to centroid is
 *      (4 corners each at distance sqrt(5^2+5^2)=7.071) = 7.071, so
 *      scale = sqrt(2)/7.071 = 0.2. Tsrc maps the square to a centered square
 *      of "radius" sqrt(2). dst normalizes analogously (centroid (20,30),
 *      mean dist 14.142, scale 0.1).
 *   2. Build A (8×9) from the normalized correspondences; M = AᵀA is 9×9 SPD-ish
 *      with one (near-)zero eigenvalue corresponding to the exact homography
 *      null vector (the data are noise-free and consistent).
 *   3. jacobiEigenSymmetric diagonalizes M; the eigenvector of the smallest
 *      eigenvalue is the normalized homography Hn (a scalar multiple of the true
 *      normalized map).
 *   4. Denormalize H = Tdst⁻¹ · Hn · Tsrc, then divide by H[8] so H[8] = 1.
 *      Because the correspondences are an exact scale+translate, the recovered
 *      H equals Htrue (up to the H[8]=1 normalization), i.e.
 *      H ≈ [2, 0, 10, 0, 2, 20, 0, 0, 1].
 *
 * Verification via applyHomography(H, src_i):
 *      [0, 0]   -> [10, 20]  matches dst[0]
 *      [10, 0]  -> [30, 20]  matches dst[1]
 *      [10,10]  -> [30, 40]  matches dst[2]
 *      [0, 10]  -> [10, 40]  matches dst[3]
 * so reprojectionRMS(H, src, dst) ≈ 0 (within ~1e-9 floating-point / Jacobi
 * convergence error). The round-trip holds, confirming the DLT assembly, the
 * Jacobi smallest-eigenvector selection, and the denormalization order
 * (Tdst⁻¹ · Hn · Tsrc) are all correct.
 *
 * Sanity on invertMat3: invertMat3(Htrue) should give
 *      [0.5, 0, -5, 0, 0.5, -10, 0, 0, 1]
 * and applyHomography(invertMat3(Htrue), [30, 40]) = [(30-10)/2, (40-20)/2]
 * = [10, 10] = the original src[2]. Consistent.
 */
