// Programmatic dock-tab navigation hooks — a tiny indirection so non-shell code
// (the gamepad loop, shortcuts) can FOCUS a tab or enumerate the open tabs
// without importing the dockview API. The app shell registers the real
// implementations on mount; everything is a safe no-op until it does.
//
// Pure module: no React/DOM imports. Mirrors the shape of `activity.ts`
// (getActiveTab/setActiveTab) which already lives alongside this.

let focuser: ((id: string) => void) | null = null
let lister: (() => string[]) | null = null

/**
 * Register the shell's tab controls. `focus(id)` activates that dock panel;
 * `list()` returns the OPEN tab ids in display order. Returns an unregister fn.
 */
export function registerTabNav(impl: { focus: (id: string) => void; list: () => string[] }): () => void {
  focuser = impl.focus
  lister = impl.list
  return () => {
    if (focuser === impl.focus) focuser = null
    if (lister === impl.list) lister = null
  }
}

/** Activate the dock tab with this id (no-op if the shell isn't mounted/unknown). */
export function focusTab(id: string): void {
  focuser?.(id)
}

/** The currently OPEN tab ids in display order (empty until the shell registers). */
export function openTabs(): string[] {
  return lister?.() ?? []
}
