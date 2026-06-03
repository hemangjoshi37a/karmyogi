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
