import type { IDockviewPanelProps } from 'dockview'
import {
  createElement,
  lazy,
  Suspense,
  type ComponentType,
  type FunctionComponent,
  type LazyExoticComponent,
} from 'react'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { useT } from '../i18n'

/**
 * Orchestrator-owned panel registry.
 *
 * Reliability + performance hardening for a public launch:
 *
 *  - CODE-SPLITTING: every panel is `React.lazy()`-loaded so the ~18 CAM modes
 *    are NOT bundled into the entry chunk. Only the panels the user actually
 *    opens are fetched (and dockview only mounts a panel's component when its
 *    tab is created/shown). The heavy three.js viewer (Visualizer), the OCCT
 *    WASM (2D/3D Carving), opentype (Writing/Signature) and polygon-clipping
 *    (PCB) therefore load on demand, not up front.
 *
 *  - CONTAINMENT: each panel is wrapped in its OWN <ErrorBoundary>, so a crash
 *    while parsing an untrusted DXF/STL/Gerber file, or a WebGL/WASM failure,
 *    is contained to that one panel and never white-screens the whole SPA.
 *
 *  - SUSPENSE: each lazy component is wrapped in <Suspense> with a lightweight
 *    "loading" fallback, since dockview renders the component synchronously.
 *
 * dockview renders whatever component we register under each key, so the
 * registered value is a tiny wrapper component = ErrorBoundary > Suspense >
 * lazy(panel). Parallel agents must NOT edit this file.
 */

type PanelModule = { [key: string]: ComponentType<IDockviewPanelProps> }

/**
 * Lazily import a panel module and pick its named export. Each entry is a
 * separate dynamic import so Vite/Rollup emits a separate chunk per panel.
 */
const lazyPanels: Record<string, LazyExoticComponent<ComponentType<IDockviewPanelProps>>> = {
  placeholder: lazy(() =>
    import('../panels/PlaceholderPanel').then((m) => ({ default: pick(m, 'PlaceholderPanel') })),
  ),
  visualizer: lazy(() =>
    import('../panels/VisualizerPanel').then((m) => ({ default: pick(m, 'VisualizerPanel') })),
  ),
  controller: lazy(() =>
    import('../panels/ControllerPanel').then((m) => ({ default: pick(m, 'ControllerPanel') })),
  ),
  console: lazy(() =>
    import('../panels/ConsolePanel').then((m) => ({ default: pick(m, 'ConsolePanel') })),
  ),
  program: lazy(() =>
    import('../panels/ProgramPanel').then((m) => ({ default: pick(m, 'ProgramPanel') })),
  ),
  cadcam: lazy(() =>
    import('../panels/CadCamPanel').then((m) => ({ default: pick(m, 'CadCamPanel') })),
  ),
  writing: lazy(() =>
    import('../panels/WritingPanel').then((m) => ({ default: pick(m, 'WritingPanel') })),
  ),
  soldering: lazy(() =>
    import('../panels/SolderingPanel').then((m) => ({ default: pick(m, 'SolderingPanel') })),
  ),
  screwfitting: lazy(() =>
    import('../panels/ScrewFittingPanel').then((m) => ({
      default: pick(m, 'ScrewFittingPanel'),
    })),
  ),
  drilling: lazy(() =>
    import('../panels/DrillingPanel').then((m) => ({
      default: pick(m, 'DrillingPanel'),
    })),
  ),
  pcb: lazy(() => import('../panels/PcbPanel').then((m) => ({ default: pick(m, 'PcbPanel') }))),
  probe: lazy(() =>
    import('../panels/ProbePanel').then((m) => ({ default: pick(m, 'ProbePanel') })),
  ),
  glue: lazy(() => import('../panels/GluePanel').then((m) => ({ default: pick(m, 'GluePanel') }))),
  pnp: lazy(() =>
    import('../panels/PickPlacePanel').then((m) => ({ default: pick(m, 'PickPlacePanel') })),
  ),
  signature: lazy(() =>
    import('../panels/SignaturePanel').then((m) => ({ default: pick(m, 'SignaturePanel') })),
  ),
  print: lazy(() =>
    import('../panels/PrintPanel').then((m) => ({ default: pick(m, 'PrintPanel') })),
  ),
  laser: lazy(() =>
    import('../panels/LaserPanel').then((m) => ({ default: pick(m, 'LaserPanel') })),
  ),
  welding: lazy(() =>
    import('../panels/WeldingPanel').then((m) => ({ default: pick(m, 'WeldingPanel') })),
  ),
  camera: lazy(() =>
    import('../panels/CameraPanel').then((m) => ({ default: pick(m, 'CameraPanel') })),
  ),
  aigcode: lazy(() =>
    import('../panels/AiGcodePanel').then((m) => ({ default: pick(m, 'AiGcodePanel') })),
  ),
}

/** Pick a named export from a module, asserting it exists (dev safety). */
function pick(mod: PanelModule, name: string): ComponentType<IDockviewPanelProps> {
  const c = mod[name]
  if (!c) throw new Error(`panelRegistry: missing export "${name}"`)
  return c
}

/**
 * Suspense fallback shown while a panel's code chunk loads: an animated spinner
 * + a localized "Loading…" label so the user clearly understands the panel is
 * loading (not broken). Styling/keyframes live in globals.css (.km-panel-loading).
 */
function PanelLoading() {
  const t = useT()
  return createElement(
    'div',
    { className: 'km-panel-loading', role: 'status', 'aria-live': 'polite' },
    createElement('span', { className: 'km-panel-spinner', 'aria-hidden': 'true' }),
    createElement('span', { className: 'km-panel-loading-label' }, t('panel.loading', 'Loading…')),
  )
}

/** Human-readable scope label per panel id (shown in the error fallback). */
const PANEL_SCOPE: Record<string, string> = {
  placeholder: 'Panel',
  visualizer: 'Visualizer',
  controller: 'Controller',
  console: 'Console',
  program: 'Program',
  cadcam: '2D/3D Carving',
  writing: 'Writing',
  soldering: 'Soldering',
  screwfitting: 'Screw Fitting',
  drilling: 'Bore / Drill / Hole',
  pcb: 'PCB',
  probe: 'Probe',
  glue: 'Glue Dispense',
  pnp: 'Pick & Place',
  signature: 'Signature',
  print: '3D Printing',
  laser: 'Laser Cutting',
  welding: 'Welding',
  camera: 'Camera',
  aigcode: 'AI G-code',
}

/**
 * Build the registered wrapper component for a panel id:
 *   ErrorBoundary(scope) > Suspense(fallback) > lazy(panel)
 * Each panel crash is contained, and its code is fetched on demand.
 */
function makePanelComponent(id: string): FunctionComponent<IDockviewPanelProps> {
  const Lazy = lazyPanels[id]
  const scope = PANEL_SCOPE[id] ?? id
  const Wrapped: FunctionComponent<IDockviewPanelProps> = (props) =>
    createElement(
      ErrorBoundary,
      { scope },
      createElement(Suspense, { fallback: createElement(PanelLoading) }, createElement(Lazy, props)),
    )
  Wrapped.displayName = `Panel(${id})`
  return Wrapped
}

/**
 * Map dockview registers under each content-component key. Every value is the
 * lazy+Suspense+ErrorBoundary wrapper above, NOT the raw panel — so unopened
 * panels stay out of the entry chunk and panel crashes are isolated.
 */
export const panelComponents: Record<string, FunctionComponent<IDockviewPanelProps>> =
  Object.fromEntries(Object.keys(lazyPanels).map((id) => [id, makePanelComponent(id)]))

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
  { id: 'cadcam', component: 'cadcam', title: '2D/3D Carving' },
  { id: 'writing', component: 'writing', title: 'Writing' },
  { id: 'soldering', component: 'soldering', title: 'Soldering' },
  { id: 'screwfitting', component: 'screwfitting', title: 'Screw Fitting' },
  { id: 'drilling', component: 'drilling', title: 'Bore / Drill / Hole' },
  { id: 'pcb', component: 'pcb', title: 'PCB' },
  { id: 'glue', component: 'glue', title: 'Glue Dispense' },
  { id: 'pnp', component: 'pnp', title: 'Pick & Place' },
  { id: 'signature', component: 'signature', title: 'Signature' },
  { id: 'print', component: 'print', title: '3D Printing' },
  { id: 'laser', component: 'laser', title: 'Laser Cutting' },
  { id: 'welding', component: 'welding', title: 'Welding' },
  { id: 'camera', component: 'camera', title: 'Camera' },
  { id: 'aigcode', component: 'aigcode', title: 'AI G-code' },
]
