import { useId } from 'react'

export interface SliderFieldProps {
  /** Visible label (wraps to 2 lines, never truncates). */
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /** Optional unit shown after the number field (e.g. "mm", "mm/min"). */
  unit?: string
  /** Native tooltip on the row. */
  title?: string
  disabled?: boolean
  /** Optional id for the range input (label association); auto if omitted. */
  id?: string
  className?: string
}

/**
 * THE canonical slider + number field (plan §2.8 / W-B). One definition
 * app-wide, replacing the ~4–7 bespoke `.cc-slider` / `.laser-slider` /
 * `.pr-slider` / `.sig-slider` / `.cam-slider` / point-tab impls and their
 * duplicated `::-webkit-slider-thumb` blocks (styling lives in slider-row.css).
 *
 * Geometry guarantees the track is always usable: the label has a small fixed
 * basis (wraps, no ellipsis), the slider keeps a `min-width`, and the number
 * frame is fixed-width with a stable scrollbar gutter so units never clip.
 * The filled portion is driven by the `--pct` custom property (no JS per frame).
 */
export function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit,
  title,
  disabled,
  id,
  className,
}: SliderFieldProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const span = max - min
  const pct = span > 0 ? ((value - min) / span) * 100 : 0

  return (
    <div
      className={['ui-sfield', className ?? ''].filter(Boolean).join(' ')}
      title={title}
    >
      <label className="ui-sfield-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className="ui-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ ['--pct' as string]: pct }}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <input
        className="ui-sfield-num"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (!Number.isNaN(v)) onChange(v)
        }}
      />
      {unit && <span className="ui-sfield-unit">{unit}</span>}
    </div>
  )
}
