// Orchestrator-owned store barrel. Workstreams add their slice exports here
// via the orchestrator (never edited directly by parallel agents).

export { useSettings } from './settings'
export type { Theme, Units } from './settings'

export { useLayout } from './layout'

export { useMachine } from './machine'
export type { ConnectionStatus, MachineState, Vec3 } from './machine'

export { useProgram } from './program'

export { useConsole } from './console'
export type { ConsoleEntry, ConsoleDir } from './console'

export { useGrblSettings } from './grblSettings'

export { useMachineProfile } from './machineProfile'

export { useNotifications } from './notifications'
export type { NotificationLevel, NotificationEntry } from './notifications'

export { usePersistentState } from './persist'

export { useAiGcode } from './aiGcode'
