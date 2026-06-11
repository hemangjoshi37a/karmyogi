import { useEffect } from 'react'
import { useHistory } from '../store/history'

// Platform-wide undo/redo keyboard shortcuts. Mounted ONCE at the app root.
//
//   Undo : Ctrl+Z   (Cmd+Z on macOS)
//   Redo : Ctrl+Shift+Z / Ctrl+Y   (Cmd+Shift+Z on macOS)
//
// It deliberately IGNORES the event when focus is inside an editable element
// (input / textarea / select / contentEditable) so the browser's native text
// undo and number-field editing keep working untouched. Undo/redo on an empty
// stack is a no-op handled by the history store itself.

/** True when the event target is a field where native text editing should win. */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

export function UndoRedoHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Require the platform modifier (Ctrl on Win/Linux, Cmd on macOS). Avoid
      // firing when BOTH Ctrl and Meta are held (uncommon combo / OS shortcut).
      const mod = e.ctrlKey !== e.metaKey
      if (!mod || e.altKey) return

      const key = e.key.toLowerCase()
      let action: 'undo' | 'redo' | null = null
      if (key === 'z') action = e.shiftKey ? 'redo' : 'undo'
      else if (key === 'y' && !e.shiftKey) action = 'redo'
      if (!action) return

      // Let native editing handle the shortcut inside text fields.
      if (isEditableTarget(e.target)) return

      e.preventDefault()
      const h = useHistory.getState()
      if (action === 'undo') h.undo()
      else h.redo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return null
}
