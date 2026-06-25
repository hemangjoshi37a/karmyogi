/**
 * Plain-language explainer content for machine / CAM settings.
 *
 * Aimed at non-expert, least-technical operators: each entry answers
 * "what is this?", "what does changing it do?", and gives a safe-default hint
 * in 1–3 simple sentences, with no jargon. These are the ENGLISH source of
 * truth; the `InfoTip` component renders them through `t()` so every title and
 * body is translatable (keys `explain.<topic>.title` / `explain.<topic>.body`).
 *
 * Pure data — no React/DOM imports — so it stays portable and mirrors the rest
 * of `src/core/`.
 */
export interface Explainer {
  /** Short heading shown at the top of the popover. */
  title: string
  /** 1–3 plain sentences: what it is + what changing it does + a safe default. */
  body: string
}

export const EXPLAINERS: Record<string, Explainer> = {
  safeZ: {
    title: 'Safe height (Safe-Z)',
    body: 'The height the bit lifts to before moving sideways, so it clears the workpiece and clamps. Bigger = safer but a little slower; too small risks the bit crashing into the work or clamps. A few mm above the top is usually safe.',
  },
  spindleRpm: {
    title: 'Spindle speed (RPM)',
    body: 'How fast the cutting tool spins, in turns per minute. Higher speeds suit small bits and soft material; too fast can burn wood or melt plastic, too slow can chip the bit. Follow the bit/material chart, or start moderate.',
  },
  plungeFeed: {
    title: 'Plunge speed',
    body: 'How fast the bit drives straight DOWN into the material before each cut. Going down is harder than cutting sideways, so this is slower than the cutting speed. Too fast can snap the bit; keep it gentle.',
  },
  cutSpeed: {
    title: 'Cutting speed (feed rate)',
    body: 'How fast the bit travels sideways through the material while cutting. Faster finishes sooner but strains the bit and motor; slower is cleaner and safer. Start slow on a new material and speed up if it cuts smoothly.',
  },
  freeSpeed: {
    title: 'Travel speed (rapid)',
    body: 'How fast the machine moves when it is NOT cutting — repositioning in the air at safe height. This can be quite fast since nothing is being cut. Lower it if fast moves feel jerky or the machine loses position.',
  },
  cutDepthPerPass: {
    title: 'Depth per pass',
    body: 'How much material is removed in a single downward pass. Taking less per pass is gentler on the bit and gives a cleaner cut, but needs more passes. A common safe starting point is about half the bit width or less.',
  },
  totalDepth: {
    title: 'Total cut depth',
    body: 'How deep the final cut goes overall, reached in several passes. Set it to your material thickness to cut through, or less to carve a groove. Going deeper than the material will cut into whatever is underneath.',
  },
  stepover: {
    title: 'Stepover',
    body: 'How far the bit shifts sideways between neighbouring passes when clearing an area. Smaller steps leave a smoother surface but take longer; larger steps are faster but rougher. Around 40–50% of the bit width is a good balance.',
  },
  toolDiameter: {
    title: 'Tool diameter',
    body: 'The width of the cutting bit. The machine uses it to keep cuts the right size and to space out passes, so it must match the bit actually fitted. Measure the bit if you are unsure — a wrong value makes parts the wrong size.',
  },
  toolType: {
    title: 'Tool type',
    body: 'What kind of bit is fitted — flat end mill, V-bit, ball-nose, drill, or pen. It changes the shape the tool cuts and how toolpaths are calculated. Pick the one that matches the bit in the spindle.',
  },
  workZero: {
    title: 'Work zero (origin)',
    body: 'The spot on your material that counts as X0 Y0 Z0 — where the job is measured from. Usually a corner or the centre of the stock, with Z0 at the top surface. Set this before cutting so the job lands where you expect.',
  },
  roughing: {
    title: 'Roughing pass',
    body: 'A fast first pass that clears most of the waste material, leaving a little extra behind. It does the heavy lifting quickly without worrying about a perfect finish. Follow it with a finishing pass for a clean surface.',
  },
  finishing: {
    title: 'Finishing pass',
    body: 'A final light pass that shaves off the last thin layer for a smooth, accurate surface. It removes very little, so it is gentle and precise. Use it after roughing when surface quality matters.',
  },
  feedRate: {
    title: 'Feed rate',
    body: 'The speed the tool moves through the material while cutting, in mm per minute. Higher is faster but harder on the bit; lower is slower and cleaner. Start conservative and increase only if the cut stays smooth.',
  },
  feedOverride: {
    title: 'Feed override',
    body: 'A live dial to speed up or slow down the running job without editing it, shown as a percent of the programmed feed. Turn it down if the cut sounds harsh or struggles; 100% runs at the planned speed. Safe to adjust mid-cut.',
  },
  rapidOverride: {
    title: 'Rapid override',
    body: 'A live control for how fast the NON-cutting (travel) moves go, as a percent of full speed. Lower it (25% or 50%) when testing a new job so fast moves are easy to watch and stop. 100% is full travel speed.',
  },
  spindleOverride: {
    title: 'Spindle override',
    body: 'A live dial to raise or lower the spinning speed while the job runs, as a percent of the programmed RPM. Nudge it down if the material burns, up if the bit bogs down. 100% runs at the planned speed.',
  },
  jogStep: {
    title: 'Jog step',
    body: 'How far the machine moves each time you tap a jog (arrow) button — for example 0.1, 1, or 10 mm. Big steps move quickly across the table; small steps let you nudge precisely. Use small steps near the workpiece.',
  },
  probeFeed: {
    title: 'Probe speed',
    body: 'How fast the tool lowers toward the touch plate while finding the surface. Slow is more accurate and safer, since it stops the instant it touches. Keep it slow — there is no need to rush a probe.',
  },
  probeDistance: {
    title: 'Probe max distance',
    body: 'The furthest the tool will travel down looking for the plate before giving up and stopping with an alarm. It is a safety limit so the tool does not keep pushing if it never makes contact. Set it a little more than the expected gap.',
  },
  material: {
    title: 'Material',
    body: 'What you are cutting — such as wood, plastic, aluminium, or PCB. It guides sensible speeds and depths, since each material cuts differently. Choosing the right one helps avoid burning, melting, or breaking the bit.',
  },
  bit: {
    title: 'Bit',
    body: 'The cutting tool fitted in the spindle, described by its type and width. The job uses it to size cuts and plan passes, so it must match what is actually installed. Swap the setting whenever you change the physical bit.',
  },
}

export type ExplainerTopic = keyof typeof EXPLAINERS

// ---------------------------------------------------------------------------
// O8 — Plain-language GRBL ALARM / error explanations.
//
// GRBL reports failures as terse numeric codes: `error:20` (line rejected) and
// `ALARM:1` (state lock). Operators — especially non-experts — have no idea what
// those mean. These maps turn each code into a short plain-language CAUSE + FIX
// so the console, the controller error banner, and the Unlock affordance can all
// explain what happened and what to do. ENGLISH source of truth; rendered via
// `t('grbl.error.N.title' / '.cause' / '.fix')` so every string stays i18n-able.
//
// Codes follow GRBL v1.1 (the firmware family this app targets). Pure data — no
// React/DOM — so it stays portable with the rest of `src/core/`.
// ---------------------------------------------------------------------------

/** A decoded GRBL alarm or error: what it is, why it happened, how to fix it. */
export interface GrblExplanation {
  /** 'alarm' (machine locked, needs Unlock/Reset) or 'error' (a line was rejected). */
  kind: 'alarm' | 'error'
  /** The numeric code (e.g. 1, 9, 20). */
  code: number
  /** Short heading, e.g. "Hard limit triggered". */
  title: string
  /** One plain sentence: what caused it. */
  cause: string
  /** One plain sentence: what to do about it. */
  fix: string
}

/** GRBL v1.1 ALARM codes → plain-language cause + fix. */
export const GRBL_ALARMS: Record<number, { title: string; cause: string; fix: string }> = {
  1: {
    title: 'Hard limit triggered',
    cause: 'A limit switch was hit, so the machine stopped to protect itself — its position is now uncertain.',
    fix: 'Move the head away from the switch, then Unlock ($X) and re-home ($H) before running anything.',
  },
  2: {
    title: 'Soft limit — move out of bounds',
    cause: 'A commanded move would have driven past the machine’s travel limits.',
    fix: 'Unlock ($X), check your work zero and the job size fits the bed, then re-run.',
  },
  3: {
    title: 'Reset while in motion',
    cause: 'The controller was reset (or lost power) while moving, so its position can no longer be trusted.',
    fix: 'Unlock ($X) and re-home ($H) to re-establish a known position before cutting.',
  },
  4: {
    title: 'Probe failed (already triggered)',
    cause: 'A probe move started with the probe already touching — the cycle was aborted for safety.',
    fix: 'Lift the tool clear of the plate, check wiring, then retry the probe.',
  },
  5: {
    title: 'Probe failed (no contact)',
    cause: 'The probe travelled its full distance without ever touching the plate.',
    fix: 'Lower the tool closer to the plate or increase the probe distance, check the clip/wiring, then retry.',
  },
  6: {
    title: 'Homing failed (no switch)',
    cause: 'The homing cycle didn’t reach a limit switch within the search distance.',
    fix: 'Check the limit switches and wiring, confirm homing is enabled ($22), then re-home.',
  },
  7: {
    title: 'Homing failed (switch active)',
    cause: 'A limit switch was still pressed after pulling off during homing.',
    fix: 'Free the stuck switch, check for a faulty/triggered switch, then re-home.',
  },
  8: {
    title: 'Homing failed (no clear)',
    cause: 'Homing couldn’t move off the limit switch within the pull-off distance.',
    fix: 'Increase the pull-off ($27) or free the switch, then re-home.',
  },
  9: {
    title: 'Homing failed (limits not found)',
    cause: 'The homing cycle never located the limits in the expected direction.',
    fix: 'Check switch direction/wiring and homing direction ($23), then re-home.',
  },
}

/** GRBL v1.1 error (line-rejected) codes → plain-language cause + fix. */
export const GRBL_ERRORS: Record<number, { title: string; cause: string; fix: string }> = {
  1: { title: 'Bad G-code letter', cause: 'A command word was missing its expected letter.', fix: 'Fix the offending line — every word needs a valid letter.' },
  2: { title: 'Bad number format', cause: 'A number in a G-code word was malformed or missing.', fix: 'Correct the number on that line (no missing digits or stray characters).' },
  3: { title: 'Unsupported “$” command', cause: 'A `$` system command isn’t recognised by this firmware.', fix: 'Check the command spelling; use only `$` settings your GRBL supports.' },
  4: { title: 'Negative value not allowed', cause: 'A value that must be positive was given as negative.', fix: 'Use a positive number for that setting/word.' },
  5: { title: 'Homing not enabled', cause: 'A homing command was sent but homing is disabled ($22=0).', fix: 'Enable homing ($22=1) in the GRBL settings, or skip homing.' },
  6: { title: 'Step pulse too short', cause: 'The step-pulse time setting ($0) is below the minimum.', fix: 'Raise $0 (step pulse, µs) to a valid value.' },
  7: { title: 'EEPROM read failed', cause: 'Saved settings couldn’t be read; defaults were restored.', fix: 'Re-check / re-save your GRBL settings.' },
  8: { title: '“$” command needs Idle', cause: 'That `$` command can only run when the machine is idle.', fix: 'Wait until the machine is Idle (or reset), then resend.' },
  9: { title: 'Locked — homing/alarm', cause: 'G-code motion is locked because the machine is in alarm or hasn’t homed.', fix: 'Unlock ($X) and/or home ($H) first, then resend.' },
  10: { title: 'Soft limits need homing', cause: 'Soft limits ($20) are on but homing ($22) is off — an unsafe combination.', fix: 'Enable homing ($22=1) too, or turn soft limits off ($20=0).' },
  11: { title: 'Line too long', cause: 'A single G-code line exceeded the controller’s buffer.', fix: 'Shorten the line / split it; regenerate the program if needed.' },
  12: { title: 'Step rate too high', cause: 'The requested step rate exceeded the firmware maximum.', fix: 'Lower the max rate ($110–$112) or steps/mm ($100–$102).' },
  13: { title: 'Safety door ajar', cause: 'A command needs the safety door closed, but it’s open.', fix: 'Close the safety door, then resend.' },
  14: { title: 'Startup line too long', cause: 'A `$N` startup line exceeded the line buffer.', fix: 'Shorten the startup line ($N0/$N1).' },
  15: { title: 'Jog distance exceeded', cause: 'A jog target was outside the machine travel.', fix: 'Reduce the jog distance or check soft limits.' },
  16: { title: 'Bad jog command', cause: 'A `$J=` jog command was malformed.', fix: 'Use a valid `$J=` form (G90/G91 + axis word + F feed).' },
  17: { title: 'Laser mode needs PWM', cause: 'Laser mode ($32) was set but the spindle pin can’t do PWM.', fix: 'Disable laser mode ($32=0) or use a PWM-capable build.' },
  20: { title: 'Unsupported G/M command', cause: 'A G-code or M-code on that line isn’t supported by GRBL.', fix: 'Remove/replace the unsupported code; regenerate the program for GRBL.' },
  21: { title: 'Conflicting modal words', cause: 'Two modal commands of the same group were on one line.', fix: 'Split the conflicting commands onto separate lines.' },
  22: { title: 'Missing feed rate', cause: 'A feed move (G1/G2/G3) ran with no feed rate set.', fix: 'Add an F feed-rate word before the first cutting move.' },
  23: { title: 'Command value not integer', cause: 'A G-code expecting a whole number got a fraction.', fix: 'Use a whole number for that command (e.g. P, L, N).' },
  24: { title: 'Too many words use axes', cause: 'Multiple commands tried to use the axis words at once.', fix: 'Put only one axis-using command per line.' },
  25: { title: 'Repeated G-code word', cause: 'A word was repeated on the same line.', fix: 'Remove the duplicate word.' },
  26: { title: 'Missing axis words', cause: 'A move that needs axis words had none.', fix: 'Add the required axis words (e.g. X/Y/Z).' },
  27: { title: 'Bad line number', cause: 'An N line number was out of the valid range.', fix: 'Use a line number in range, or strip N numbers.' },
  28: { title: 'Missing P or L value', cause: 'A command needed a P or L value and none was given.', fix: 'Add the required P/L value.' },
  29: { title: 'Unsupported work coord', cause: 'A work coordinate system (G54–G59) isn’t supported.', fix: 'Use a supported WCS (G54–G59.3 depending on build).' },
  30: { title: 'G53 needs G0/G1', cause: 'G53 was used without an active G0 or G1 motion.', fix: 'Use G53 with a G0 or G1 move on the same line.' },
  31: { title: 'Unused axis words', cause: 'Axis words were given to a command that ignores them.', fix: 'Remove the unused axis words from that line.' },
  32: { title: 'Arc with no plane motion', cause: 'A G2/G3 arc had no movement in the selected plane.', fix: 'Provide proper arc endpoints/offsets in the active plane.' },
  33: { title: 'Invalid arc geometry', cause: 'The arc target/radius don’t form a valid arc.', fix: 'Fix the arc’s endpoint, I/J/K offsets or R radius.' },
  34: { title: 'Arc radius error', cause: 'An R-format arc couldn’t be computed (radius too small).', fix: 'Increase the arc radius or use I/J/K offsets instead.' },
  35: { title: 'Arc missing offsets', cause: 'An I/J/K arc was missing the offsets for the active plane.', fix: 'Add the I/J/K offset words for the arc plane.' },
  36: { title: 'Unused value words', cause: 'A line had value words no command used.', fix: 'Remove the leftover value words.' },
  37: { title: 'G43.1 bad axis', cause: 'Dynamic tool-length offset was set on the wrong axis.', fix: 'Apply G43.1 to the configured tool-length axis only.' },
  38: { title: 'Tool number too large', cause: 'A tool number exceeded the allowed maximum.', fix: 'Use a tool number within range.' },
}

/**
 * Decode any GRBL message/error string (e.g. `"ALARM:1"`, `"error:20"`, or a
 * wrapped form like `error on "G1 …": error:33`) into a plain-language
 * explanation. Returns `null` when no recognised `error:N` / `ALARM:N` token is
 * present, so callers can fall back to showing the raw text.
 */
export function explainGrblMessage(msg: string | null | undefined): GrblExplanation | null {
  if (!msg) return null
  // Match the LAST occurrence so a wrapped "error on …: error:33" resolves to 33.
  const alarm = /alarm:\s*(\d+)/gi
  const err = /error:\s*(\d+)/gi
  let am: RegExpExecArray | null
  let lastAlarm: number | null = null
  while ((am = alarm.exec(msg))) lastAlarm = parseInt(am[1], 10)
  let em: RegExpExecArray | null
  let lastErr: number | null = null
  while ((em = err.exec(msg))) lastErr = parseInt(em[1], 10)
  // An explicit ALARM token wins (it's the more serious, locked state).
  if (lastAlarm != null) {
    const e = GRBL_ALARMS[lastAlarm]
    if (e) return { kind: 'alarm', code: lastAlarm, ...e }
    return {
      kind: 'alarm',
      code: lastAlarm,
      title: 'Machine alarm',
      cause: 'The controller entered an alarm state and locked motion.',
      fix: 'Unlock ($X) and re-home ($H); check limits and wiring if it repeats.',
    }
  }
  if (lastErr != null) {
    const e = GRBL_ERRORS[lastErr]
    if (e) return { kind: 'error', code: lastErr, ...e }
    return {
      kind: 'error',
      code: lastErr,
      title: 'Command rejected',
      cause: 'GRBL rejected the last command with an unrecognised error code.',
      fix: 'Check the offending line; consult the GRBL error reference for this code.',
    }
  }
  return null
}
