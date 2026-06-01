import { useEffect, useState } from 'react'

/**
 * useState that persists to localStorage under `key`, so input values survive a
 * page refresh. The latest value (whether typed or set programmatically — e.g.
 * read back from the machine) is saved on every change and restored on load.
 */
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw != null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* ignore quota / serialization errors */
    }
  }, [key, value])

  return [value, setValue] as const
}
