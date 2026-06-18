/**
 * DEPRECATED / REMOVED — the two big fixed-position corner HUD overlays have been
 * replaced by tiny per-element hint chips (a gamepad-glyph badge at each mapped
 * Controller element's UPPER-LEFT corner, mirroring the keyboard `Kbd` chip at
 * the UPPER-RIGHT) plus a live "operating" highlight on the element a control is
 * driving. See `ControllerPanel.tsx` (`Pad` / `Kbd` chips + `.gp-active`).
 *
 * This module is intentionally a NO-OP export, kept only so any stray import
 * resolves. It renders nothing.
 */
export function GamepadHud(): null {
  return null
}
