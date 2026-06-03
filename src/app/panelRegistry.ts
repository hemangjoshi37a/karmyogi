import type { IDockviewPanelProps } from 'dockview'
import type { FunctionComponent } from 'react'
import { PlaceholderPanel } from '../panels/PlaceholderPanel'
import { VisualizerPanel } from '../panels/VisualizerPanel'
import { ControllerPanel } from '../panels/ControllerPanel'
import { ConsolePanel } from '../panels/ConsolePanel'
import { CoordSystemPanel } from '../panels/CoordSystemPanel'
import { ProgramPanel } from '../panels/ProgramPanel'
import { CadCamPanel } from '../panels/CadCamPanel'
import { WritingPanel } from '../panels/WritingPanel'
import { SolderingPanel } from '../panels/SolderingPanel'
import { PcbPanel } from '../panels/PcbPanel'
import { ProbePanel } from '../panels/ProbePanel'
import { GluePanel } from '../panels/GluePanel'
import { PickPlacePanel } from '../panels/PickPlacePanel'
import { SignaturePanel } from '../panels/SignaturePanel'
import { PrintPanel } from '../panels/PrintPanel'
import { CameraPanel } from '../panels/CameraPanel'
import { AiGcodePanel } from '../panels/AiGcodePanel'

/**
 * Orchestrator-owned panel registry. Each workstream contributes ONE panel
 * component (in its own file under src/panels/); the orchestrator wires it in
 * here between batches. Parallel agents must NOT edit this file.
 */
export const panelComponents: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  placeholder: PlaceholderPanel,
  visualizer: VisualizerPanel,
  controller: ControllerPanel as FunctionComponent<IDockviewPanelProps>,
  console: ConsolePanel as FunctionComponent<IDockviewPanelProps>,
  coords: CoordSystemPanel as FunctionComponent<IDockviewPanelProps>,
  program: ProgramPanel as FunctionComponent<IDockviewPanelProps>,
  cadcam: CadCamPanel as FunctionComponent<IDockviewPanelProps>,
  writing: WritingPanel as FunctionComponent<IDockviewPanelProps>,
  soldering: SolderingPanel as FunctionComponent<IDockviewPanelProps>,
  pcb: PcbPanel as FunctionComponent<IDockviewPanelProps>,
  probe: ProbePanel as FunctionComponent<IDockviewPanelProps>,
  glue: GluePanel as FunctionComponent<IDockviewPanelProps>,
  pnp: PickPlacePanel as FunctionComponent<IDockviewPanelProps>,
  signature: SignaturePanel as FunctionComponent<IDockviewPanelProps>,
  print: PrintPanel as FunctionComponent<IDockviewPanelProps>,
  camera: CameraPanel as FunctionComponent<IDockviewPanelProps>,
  aigcode: AiGcodePanel as FunctionComponent<IDockviewPanelProps>,
}

export interface PanelSpec {
  id: string
  component: string
  title: string
  params?: Record<string, unknown>
}

/** Panels available to add from the "+" menu / View menu. */
export const availablePanels: PanelSpec[] = [
  { id: 'controller', component: 'controller', title: 'Controller' },
  { id: 'console', component: 'console', title: 'Console' },
  { id: 'program', component: 'program', title: 'Program' },
  { id: 'visualizer', component: 'visualizer', title: 'Visualizer' },
  { id: 'coords', component: 'coords', title: 'Coordinates' },
  { id: 'cadcam', component: 'cadcam', title: '3D Carving' },
  { id: 'writing', component: 'writing', title: 'Writing' },
  { id: 'soldering', component: 'soldering', title: 'Soldering' },
  { id: 'pcb', component: 'pcb', title: 'PCB' },
  { id: 'probe', component: 'probe', title: 'Probe & Limits' },
  { id: 'glue', component: 'glue', title: 'Glue Dispense' },
  { id: 'pnp', component: 'pnp', title: 'Pick & Place' },
  { id: 'signature', component: 'signature', title: 'Signature' },
  { id: 'print', component: 'print', title: '3D Printing' },
  { id: 'camera', component: 'camera', title: 'Camera' },
  { id: 'aigcode', component: 'aigcode', title: 'AI G-code' },
]
