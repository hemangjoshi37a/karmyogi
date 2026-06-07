import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ControllerKind } from '../machine/types'
import { useT } from '../i18n'

/**
 * A small "drivers" affordance next to the firmware selector. Web Serial talks to
 * the board over a USB-serial bridge chip, and on Windows that chip usually needs
 * a host DRIVER before the port appears. This button opens a popover with the
 * relevant driver downloads for the selected firmware, with a per-OS icon link
 * (Windows / macOS / Linux) so the user can grab the right one in one click.
 *
 * Only shown for firmwares that connect over USB-serial; vendor/galvo controllers
 * (Ruida / EzCAD / FSCUT) use their own software and are skipped.
 */

const SERIAL_KINDS: ControllerKind[] = [
  'grbl',
  'grblhal',
  'fluidnc',
  'marlin',
  'smoothieware',
]

type OS = 'win' | 'mac' | 'linux'

interface Driver {
  name: string
  note: string
  links: { os: OS; url: string }[]
}

// USB-serial bridge drivers most desktop GRBL-class boards need on Windows.
const USB_DRIVERS: Driver[] = [
  {
    name: 'CH340 / CH341',
    note: 'Most Arduino/GRBL clones',
    links: [
      { os: 'win', url: 'https://www.wch-ic.com/downloads/CH341SER_EXE.html' },
      { os: 'mac', url: 'https://www.wch-ic.com/downloads/CH341SER_MAC_ZIP.html' },
    ],
  },
  {
    name: 'CP210x (Silicon Labs)',
    note: 'ESP32 boards (e.g. FluidNC)',
    links: [
      { os: 'win', url: 'https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers' },
      { os: 'mac', url: 'https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers' },
      { os: 'linux', url: 'https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers' },
    ],
  },
  {
    name: 'FTDI VCP',
    note: 'Genuine FTDI USB chips',
    links: [
      { os: 'win', url: 'https://ftdichip.com/drivers/vcp-drivers/' },
      { os: 'mac', url: 'https://ftdichip.com/drivers/vcp-drivers/' },
      { os: 'linux', url: 'https://ftdichip.com/drivers/vcp-drivers/' },
    ],
  },
]

const OS_LABEL: Record<OS, { icon: string; title: string }> = {
  win: { icon: '🪟', title: 'Windows' },
  mac: { icon: '🍎', title: 'macOS' },
  linux: { icon: '🐧', title: 'Linux' },
}

export function FirmwareDrivers({ kind }: { kind: ControllerKind }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)

  const reposition = () => {
    const btn = btnRef.current
    const pop = popRef.current
    if (!btn) return
    const margin = 8
    const br = btn.getBoundingClientRect()
    const pw = pop?.offsetWidth ?? 240
    let left = br.left
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - pw))
    setCoords({ top: br.bottom + 6, left })
  }

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    reposition()
    const on = () => reposition()
    window.addEventListener('scroll', on, true)
    window.addEventListener('resize', on)
    return () => {
      window.removeEventListener('scroll', on, true)
      window.removeEventListener('resize', on)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const tgt = e.target as Node
      if (btnRef.current?.contains(tgt) || popRef.current?.contains(tgt)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!SERIAL_KINDS.includes(kind)) return null

  return (
    <span className="km-fwdrv">
      <button
        ref={btnRef}
        type="button"
        className="km-fwdrv-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={t('conn.drivers.title', 'USB driver downloads (needed on Windows to see the port)')}
        aria-label={t('conn.drivers.label', 'USB driver downloads')}
      >
        ⬇
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="km-fwdrv-pop"
            role="menu"
            style={{
              top: coords ? `${coords.top}px` : undefined,
              left: coords ? `${coords.left}px` : undefined,
              visibility: coords ? 'visible' : 'hidden',
            }}
          >
            <div className="km-fwdrv-head">
              {t('conn.drivers.head', 'USB-serial drivers')}
            </div>
            <div className="km-fwdrv-sub">
              {t(
                'conn.drivers.sub',
                'Install the one matching your board’s USB chip, then re-plug. (Linux/macOS often need none.)',
              )}
            </div>
            {USB_DRIVERS.map((d) => (
              <div key={d.name} className="km-fwdrv-row">
                <span className="km-fwdrv-name">
                  {d.name}
                  <span className="km-fwdrv-note">{d.note}</span>
                </span>
                <span className="km-fwdrv-os">
                  {d.links.map((l) => (
                    <a
                      key={l.os}
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="km-fwdrv-osbtn"
                      title={`${d.name} — ${OS_LABEL[l.os].title}`}
                      aria-label={`${d.name} for ${OS_LABEL[l.os].title}`}
                    >
                      {OS_LABEL[l.os].icon}
                    </a>
                  ))}
                </span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </span>
  )
}
