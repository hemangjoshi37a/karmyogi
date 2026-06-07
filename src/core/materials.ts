// Material presets — UI-independent, pure TypeScript.
// No React / DOM / three / zustand imports here (mirrors the Qt cadcam lib split).
//
// This is the data half of the project's "pick your material and bit, get safe
// cutting settings" feature. Each preset carries conservative baseline feeds/
// speeds tuned for a CNC-3018-class hobby router (small ER11 bits, a ~10k–12k
// RPM trim-router spindle, light/flexy frame). The numbers assume a ~3mm
// (1/8") end mill as the reference; `toolLibrary.recommend()` scales them for
// the actual bit. When in doubt these err on the SLOW/SHALLOW side — a hobby
// 3018 has very little rigidity, so gentle is safe.

/** Broad grouping for the material picker UI. */
export type MaterialCategory = 'wood' | 'plastic' | 'pcb' | 'metal' | 'foam' | 'other';

/** A single ready-to-use material recipe. Distances mm, feeds mm/min. */
export interface MaterialPreset {
  /** Stable id used by other modules (e.g. DEFAULT_MATERIAL_ID). */
  id: string;
  /** English display name (UI may translate via i18nKey). */
  name: string;
  /** i18n lookup key, e.g. 'mat.softwood'. */
  i18nKey: string;
  category: MaterialCategory;
  /** Single emoji glyph for the picker (fallback when {@link image} is missing). */
  icon: string;
  /**
   * Path to a small realistic material-swatch thumbnail under `public/materials/`.
   * Rendered by the picker in place of the emoji; falls back to {@link icon}.
   */
  image: string;
  /** Recommended cutting feed for the ~3mm reference bit (mm/min). */
  feedXY: number;
  /** Recommended plunge feed (mm/min). */
  feedZ: number;
  /** Recommended spindle speed (RPM). */
  spindleRPM: number;
  /** Depth per pass as a fraction of bit diameter (conservative). */
  stepdownFraction: number;
  /** Sideways stepover as a fraction of bit diameter (0..1). */
  stepoverFraction: number;
  /** One-line beginner tip (English source-of-truth; translate via {@link notesKey}). */
  notes: string;
  /** i18n lookup key for {@link notes}, e.g. 'mat.softwood.notes'. */
  notesKey: string;
}

/**
 * The built-in catalogue. Ordered roughly easiest→hardest within categories so
 * the picker reads sensibly. All values are deliberately conservative for a
 * light hobby machine; advanced users can push harder once they trust the rig.
 */
export const MATERIALS: MaterialPreset[] = [
  // ---- Wood ----------------------------------------------------------------
  {
    id: 'softwood',
    name: 'Softwood (pine, cedar)',
    i18nKey: 'mat.softwood',
    category: 'wood',
    icon: '🪵',
    image: '/materials/softwood.png',
    feedXY: 600,
    feedZ: 200,
    spindleRPM: 12000,
    stepdownFraction: 0.5, // ~1.6mm/pass with a 3.175mm bit
    stepoverFraction: 0.4,
    notes: 'Easy and forgiving — a great first material. Watch for fuzzy grain.',
    notesKey: 'mat.softwood.notes',
  },
  {
    id: 'hardwood',
    name: 'Hardwood (oak, maple)',
    i18nKey: 'mat.hardwood',
    category: 'wood',
    icon: '🪵',
    image: '/materials/hardwood.png',
    feedXY: 450,
    feedZ: 150,
    spindleRPM: 12000,
    stepdownFraction: 0.35,
    stepoverFraction: 0.35,
    notes: 'Denser than softwood — slow down and take lighter passes.',
    notesKey: 'mat.hardwood.notes',
  },
  {
    id: 'plywood',
    name: 'Plywood',
    i18nKey: 'mat.plywood',
    category: 'wood',
    icon: '🪵',
    image: '/materials/plywood.png',
    feedXY: 500,
    feedZ: 150,
    spindleRPM: 12000,
    stepdownFraction: 0.4,
    stepoverFraction: 0.4,
    notes: 'Glue layers dull bits fast; expect tear-out on the bottom veneer.',
    notesKey: 'mat.plywood.notes',
  },
  {
    id: 'mdf',
    name: 'MDF',
    i18nKey: 'mat.mdf',
    category: 'wood',
    icon: '🟫',
    image: '/materials/mdf.png',
    feedXY: 700,
    feedZ: 250,
    spindleRPM: 12000,
    stepdownFraction: 0.5,
    stepoverFraction: 0.45,
    notes: 'Cuts cleanly but makes fine dust — use dust extraction and a mask.',
    notesKey: 'mat.mdf.notes',
  },
  // ---- Plastics ------------------------------------------------------------
  {
    id: 'acrylic',
    name: 'Acrylic (PMMA)',
    i18nKey: 'mat.acrylic',
    category: 'plastic',
    icon: '🟦',
    image: '/materials/acrylic.png',
    feedXY: 400,
    feedZ: 120,
    spindleRPM: 10000,
    stepdownFraction: 0.25,
    stepoverFraction: 0.35,
    notes: 'Melts if it rubs — keep moving, lower RPM, single-flute bit helps.',
    notesKey: 'mat.acrylic.notes',
  },
  {
    id: 'pvc',
    name: 'PVC / plastics',
    i18nKey: 'mat.pvc',
    category: 'plastic',
    icon: '🟨',
    image: '/materials/pvc.png',
    feedXY: 500,
    feedZ: 150,
    spindleRPM: 10000,
    stepdownFraction: 0.3,
    stepoverFraction: 0.4,
    notes: 'Soft and gummy — keep RPM modest so chips clear instead of melting.',
    notesKey: 'mat.pvc.notes',
  },
  // ---- PCB -----------------------------------------------------------------
  {
    id: 'pcb',
    name: 'PCB (FR-4 copper-clad)',
    i18nKey: 'mat.pcb',
    category: 'pcb',
    icon: '🟩',
    image: '/materials/pcb.png',
    feedXY: 200,
    feedZ: 60,
    spindleRPM: 12000,
    stepdownFraction: 0.1, // isolation cuts are very shallow
    stepoverFraction: 0.4,
    notes: 'Use a V-bit for isolation routing; FR-4 is abrasive — cut shallow.',
    notesKey: 'mat.pcb.notes',
  },
  // ---- Metals --------------------------------------------------------------
  {
    id: 'aluminium',
    name: 'Aluminium',
    i18nKey: 'mat.aluminium',
    category: 'metal',
    icon: '⬜',
    image: '/materials/aluminium.png',
    feedXY: 250,
    feedZ: 60,
    spindleRPM: 12000,
    stepdownFraction: 0.1, // very light — a 3018 lacks rigidity for metal
    stepoverFraction: 0.3,
    notes: 'Hard on a hobby rig: tiny passes, slow feed, and use cutting fluid.',
    notesKey: 'mat.aluminium.notes',
  },
  {
    id: 'brass',
    name: 'Brass',
    i18nKey: 'mat.brass',
    category: 'metal',
    icon: '🟧',
    image: '/materials/brass.png',
    feedXY: 200,
    feedZ: 50,
    spindleRPM: 12000,
    stepdownFraction: 0.08,
    stepoverFraction: 0.3,
    notes: 'Machines nicely but heavy — feather-light passes; light oil helps.',
    notesKey: 'mat.brass.notes',
  },
  // ---- Soft / fast ---------------------------------------------------------
  {
    id: 'foam',
    name: 'Foam (EPS/XPS, modelling)',
    i18nKey: 'mat.foam',
    category: 'foam',
    icon: '🧊',
    image: '/materials/foam.png',
    feedXY: 1200,
    feedZ: 400,
    spindleRPM: 10000,
    stepdownFraction: 0.8, // foam clears easily, go deep & fast
    stepoverFraction: 0.5,
    notes: 'Very fast and easy. Static cling makes a mess — extraction helps.',
    notesKey: 'mat.foam.notes',
  },
  {
    id: 'wax',
    name: 'Machining wax',
    i18nKey: 'mat.wax',
    category: 'other',
    icon: '🕯️',
    image: '/materials/wax.png',
    feedXY: 800,
    feedZ: 250,
    spindleRPM: 10000,
    stepdownFraction: 0.6,
    stepoverFraction: 0.45,
    notes: 'Great for practice and casting masters — soft, clean, forgiving.',
    notesKey: 'mat.wax.notes',
  },
];

/** Look up a preset by id. Returns undefined when unknown. */
export function getMaterial(id: string): MaterialPreset | undefined {
  return MATERIALS.find((m) => m.id === id);
}

/**
 * Default material id. MUST stay valid — other modules hardcode 'softwood' as
 * the safe, beginner-friendly starting point.
 */
export const DEFAULT_MATERIAL_ID = 'softwood';
