import { useEffect } from 'react'
import { Shell } from './shell'
import { grbl } from '../serial/controller'
import { usePersistentState } from '../store'
import { useMachineBridge } from '../machine/machineBridge'

export function App() {
  // Silently reconnect to a previously-authorized GRBL device on load
  // (Web Serial remembers granted ports — no user gesture needed).
  useEffect(() => {
    grbl.autoConnect().catch(() => {})
  }, [])

  // Server bridge: opt-in (persisted, default OFF). Mounted at the shell level so
  // the relay runs regardless of which panel is open. The hook itself only
  // relays while enabled AND the machine is connected.
  const [bridgeEnabled] = usePersistentState('karmyogi.machineBridge.enabled', false)
  useMachineBridge(bridgeEnabled)

  return <Shell />
}
