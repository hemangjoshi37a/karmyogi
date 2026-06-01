import { useEffect } from 'react'
import { Shell } from './shell'
import { grbl } from '../serial/controller'

export function App() {
  // Silently reconnect to a previously-authorized GRBL device on load
  // (Web Serial remembers granted ports — no user gesture needed).
  useEffect(() => {
    grbl.autoConnect().catch(() => {})
  }, [])

  return <Shell />
}
