// A short, pleasant "work complete" chime, synthesized with the Web Audio API
// (no audio asset to ship/cache). Played when a streamed program finishes so the
// user knows the machine has completed the job without watching the screen.
//
// Best-effort: any failure (no AudioContext, autoplay policy, etc.) is swallowed
// — a missing chime must never affect machine control. The browser allows
// resuming the context here because the user already gestured (clicked Stream)
// earlier in the session.

let ctx: AudioContext | null = null

/** Play a rising C–E–G arpeggio (~0.5s) to signal program completion. */
export function playCompletionChime(): void {
  try {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    if (!ctx) ctx = new AC()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const now = ctx.currentTime
    // C5, E5, G5 — a bright major triad arpeggio.
    const notes = [523.25, 659.25, 783.99]
    const master = ctx.createGain()
    master.gain.value = 0.9
    master.connect(ctx.destination)
    notes.forEach((freq, i) => {
      const osc = ctx!.createOscillator()
      const gain = ctx!.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const t0 = now + i * 0.13
      gain.gain.setValueAtTime(0, t0)
      gain.gain.linearRampToValueAtTime(0.18, t0 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34)
      osc.connect(gain)
      gain.connect(master)
      osc.start(t0)
      osc.stop(t0 + 0.36)
    })
  } catch {
    /* audio is best-effort; never throw into the control path */
  }
}
