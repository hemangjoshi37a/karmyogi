import {
  Gamepad2,
  Terminal,
  FileCode2,
  Box,
  Shapes,
  PenLine,
  Zap,
  Wrench,
  Drill,
  CircuitBoard,
  Droplet,
  Grab,
  Signature,
  Printer,
  Crosshair,
  Flame,
  Camera,
  Sparkles,
  PanelsTopLeft,
  type LucideIcon,
} from 'lucide-react'

/**
 * One distinct, meaning-related icon per panel id (lucide-react). Used wherever
 * a panel is named — dockview tab titles, the top-bar Open/Reopen-panels menu,
 * and the mobile tab strip — so a tab is recognizable at a glance.
 *
 * `aigcode` maps to the AI sparkle (the dissolved tab now lives as the floating
 * assistant bubble, reopened from the panels menu).
 */
const PANEL_ICONS: Record<string, LucideIcon> = {
  controller: Gamepad2,
  console: Terminal,
  program: FileCode2,
  visualizer: Box,
  cadcam: Shapes,
  writing: PenLine,
  soldering: Zap,
  screwfitting: Wrench,
  drilling: Drill,
  pcb: CircuitBoard,
  glue: Droplet,
  pnp: Grab,
  signature: Signature,
  print: Printer,
  laser: Crosshair,
  welding: Flame,
  camera: Camera,
  aigcode: Sparkles,
}

/** Render the icon for a panel id (falls back to a generic panels glyph). */
export function PanelIcon({
  id,
  size = 14,
  className,
}: {
  id: string
  size?: number
  className?: string
}) {
  const Icon = PANEL_ICONS[id] ?? PanelsTopLeft
  return <Icon size={size} className={className} aria-hidden="true" />
}
