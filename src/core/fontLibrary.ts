// Font library — bundled/served font catalog + runtime loader.
// UI-independent, pure TS (uses fetch, but no DOM/React).
//
// The app ships a manifest at /fonts/index.json listing the fonts the Writing
// panel offers without any upload. Each entry names a file under /fonts/ and a
// `kind` ('stroke' = single-stroke JSON for StrokeFont, 'outline' = .ttf/.otf
// for OutlineFont). The built-in Hershey stroke font is ALWAYS available as a
// zero-dependency, zero-network default (id 'builtin'), even if the manifest is
// missing or empty — so the tab works fully offline.
//
// Loading is lazy: the panel populates the picker from the manifest on mount,
// then fetches+parses a font's bytes only when it's actually selected.

import { StrokeFont } from './strokeFont';
import { OutlineFont } from './outlineFont';

export type FontKind = 'stroke' | 'outline';

/**
 * Minimal local typings for the Local Font Access API (Chromium-only, behind the
 * `local-fonts` permission). Not in the default DOM lib, so we declare exactly
 * the slice we use. `blob()` returns the real font file bytes (a TTF/OTF), which
 * we hand straight to OutlineFont.fromArrayBuffer.
 * See: https://developer.mozilla.org/en-US/docs/Web/API/Window/queryLocalFonts
 */
export interface LocalFontData {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  readonly style: string;
  blob(): Promise<Blob>;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

/** A font as it appears in the picker (manifest entry, built-in, or local system font). */
export interface FontCatalogEntry {
  /** Stable id used as the persisted selection + React key. */
  id: string;
  /** Display name shown in the dropdown. */
  name: string;
  /** stroke (single-stroke JSON) or outline (.ttf/.otf). */
  kind: FontKind;
  /** URL/path under /fonts to fetch; absent for the synthetic built-in. */
  file?: string;
  /** True for the synthetic, always-present built-in Hershey font. */
  builtin?: boolean;
  /** Family name for optgroup grouping in the picker (manifest/local fonts). */
  family?: string;
  /**
   * For an enumerated local (client system) font: the live FontData handle whose
   * `.blob()` yields the actual font file. Present only for `id` starting
   * 'local:'. NOT serializable — cannot be embedded in a saved document.
   */
  local?: LocalFontData;
}

/** Raw shape of a manifest entry in /fonts/index.json. */
interface ManifestEntry {
  name?: unknown;
  file?: unknown;
  kind?: unknown;
  id?: unknown;
}

/** The always-present built-in entry. */
export const BUILTIN_ENTRY: FontCatalogEntry = {
  id: 'builtin',
  name: 'Built-in (Hershey)',
  kind: 'stroke',
  builtin: true,
};

const MANIFEST_URL = 'fonts/index.json';

/** A loaded font ready for layout — exactly one of the two is set. */
export type LoadedFont = { kind: 'stroke'; font: StrokeFont } | { kind: 'outline'; font: OutlineFont };

/**
 * Fetch the bundled font manifest and return the catalog the picker shows. The
 * built-in is always first; manifest entries follow. Network/parse failures are
 * swallowed (returns just the built-in) so the panel never breaks offline — the
 * caller can surface a note. Malformed entries are skipped, not fatal.
 */
export async function loadFontCatalog(
  signal?: AbortSignal,
): Promise<{ entries: FontCatalogEntry[]; note?: string }> {
  const entries: FontCatalogEntry[] = [BUILTIN_ENTRY];
  try {
    const res = await fetch(MANIFEST_URL, { signal, cache: 'no-cache' });
    if (!res.ok) return { entries, note: `manifest HTTP ${res.status}` };
    const raw: unknown = await res.json();
    const list: unknown = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { fonts?: unknown }).fonts)
        ? (raw as { fonts: unknown[] }).fonts
        : [];
    if (!Array.isArray(list)) return { entries, note: 'manifest has no font list' };

    let skipped = 0;
    list.forEach((item, i) => {
      const e = item as ManifestEntry;
      const file = typeof e.file === 'string' ? e.file : '';
      const kind: FontKind = e.kind === 'outline' ? 'outline' : 'stroke';
      const name = typeof e.name === 'string' && e.name ? e.name : file || `Font ${i + 1}`;
      if (!file) {
        skipped++;
        return;
      }
      const id = typeof e.id === 'string' && e.id ? e.id : `lib:${file}`;
      entries.push({
        id,
        name,
        kind,
        // Resolve relative to the fonts dir (manifest lives there).
        file: file.includes('/') ? file : `fonts/${file}`,
      });
    });
    const note = skipped > 0 ? `${skipped} manifest entr(y/ies) skipped (no file)` : undefined;
    return { entries, note };
  } catch (e) {
    // AbortError is expected on unmount — not worth surfacing.
    const msg = (e as Error)?.name === 'AbortError' ? undefined : `manifest unavailable`;
    return { entries, note: msg };
  }
}

/**
 * Load + parse a catalog entry into a usable font. The built-in is synthesized
 * locally; everything else is fetched from its `file` and parsed by kind.
 * Throws on network or parse failure (the caller shows the message).
 */
export async function loadCatalogFont(
  entry: FontCatalogEntry,
  signal?: AbortSignal,
): Promise<LoadedFont> {
  if (entry.builtin || entry.id === 'builtin') {
    return { kind: 'stroke', font: StrokeFont.builtin() };
  }
  if (!entry.file) throw new Error('Font entry has no file.');

  const res = await fetch(entry.file, { signal, cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${entry.file}`);

  if (entry.kind === 'outline') {
    const buf = await res.arrayBuffer();
    return { kind: 'outline', font: OutlineFont.fromArrayBuffer(buf, entry.name) };
  }
  const text = await res.text();
  return { kind: 'stroke', font: StrokeFont.fromJson(text) };
}

/** Detect a file's font kind by extension. Defaults to stroke (JSON). */
export function detectKindByName(filename: string): FontKind {
  return /\.(ttf|otf|woff)$/i.test(filename) ? 'outline' : 'stroke';
}

/** Outcome of a `queryLocalFonts()` attempt. */
export interface SystemFontsResult {
  /** Catalog entries for every enumerated local font (id 'local:...', kind 'outline'). */
  entries: FontCatalogEntry[];
  /** Human note describing what happened (unsupported / denied / count). */
  note: string;
  /** True only when the browser actually returned a (possibly empty) font list. */
  ok: boolean;
}

/** Whether the Local Font Access API exists at all (Chromium + secure context). */
export function systemFontsSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';
}

/**
 * Enumerate the user's *local (client) system* fonts via the Local Font Access
 * API. This is the correct, supported way to read installed fonts in a static
 * browser SPA — a static site can never read the *server* PC's fonts; it reads
 * the visitor's own machine, and only after they grant the `local-fonts`
 * permission from a user gesture (so this must be called from a click handler).
 *
 * Returns catalog entries (one per FontData, kind 'outline' since these are real
 * TTF/OTF files) carrying the live `local` handle for lazy `.blob()` loading.
 * Degrades gracefully: if the API is missing (non-Chromium) or the permission is
 * denied/dismissed, returns ok:false with an explanatory note and no entries —
 * never throws, never disturbs the bundled catalog.
 */
export async function loadSystemFonts(): Promise<SystemFontsResult> {
  if (!systemFontsSupported()) {
    return {
      entries: [],
      ok: false,
      note: 'Loading system fonts needs a Chromium browser (Chrome/Edge) over HTTPS or localhost.',
    };
  }
  let fonts: LocalFontData[];
  try {
    // Non-null: systemFontsSupported() guarantees the function exists.
    fonts = await window.queryLocalFonts!();
  } catch (e) {
    const err = e as Error;
    const denied = err?.name === 'SecurityError' || err?.name === 'NotAllowedError';
    return {
      entries: [],
      ok: false,
      note: denied
        ? 'System-font access was denied. Allow the "Fonts" permission and try again.'
        : `Could not read system fonts: ${err?.message || 'unknown error'}.`,
    };
  }

  const entries: FontCatalogEntry[] = [];
  for (const f of fonts) {
    // postscriptName is unique per face; use it as the stable id.
    const ps = f.postscriptName || f.fullName || f.family;
    if (!ps) continue;
    entries.push({
      id: `local:${ps}`,
      name: f.fullName || ps,
      kind: 'outline',
      family: f.family || f.fullName || ps,
      local: f,
    });
  }
  // Stable, family-grouped order so the (long) picker reads sensibly.
  entries.sort(
    (a, b) =>
      (a.family ?? a.name).localeCompare(b.family ?? b.name) || a.name.localeCompare(b.name),
  );
  return {
    entries,
    ok: true,
    note: entries.length
      ? `Loaded ${entries.length} system font(s).`
      : 'No system fonts were returned.',
  };
}

/**
 * Lazily load a local (system) font entry: pull its file bytes via the FontData
 * `.blob()` handle and parse them into an OutlineFont. Throws on failure (no
 * handle, or parse error) so the caller can surface the message.
 */
export async function loadLocalFont(entry: FontCatalogEntry): Promise<LoadedFont> {
  if (!entry.local) throw new Error('System font is no longer available — reload system fonts.');
  const blob = await entry.local.blob();
  const buf = await blob.arrayBuffer();
  return { kind: 'outline', font: OutlineFont.fromArrayBuffer(buf, entry.name) };
}
