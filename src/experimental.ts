/**
 * Experimental / archival feature flags.
 *
 * Features here are CODED but NOT shown to the public — they are kept as
 * "idea-thinking" scaffolding to be fully finished + battle-tested before going
 * public. They become visible in two cases ONLY:
 *
 *   1. Local dev with the env flag set:
 *        VITE_EXPERIMENTAL_AI=true HTTPS=1 npm run dev -- --host 0.0.0.0
 *   2. The signed-in user is the OWNER ({@link ADMIN_EMAIL}) — so the owner can
 *      dogfood unfinished features in the real production build while everyone
 *      else sees nothing.
 *
 * See docs/ai-roadmap.md for the staged plan behind these flags.
 */
import { useAuth } from './auth/authStore'

/** Build-time opt-in for local development. */
const EXPERIMENTAL_AI_ENV = import.meta.env.VITE_EXPERIMENTAL_AI === 'true'

/** Owner who may preview unfinished features in the public build. */
export const ADMIN_EMAIL = 'hemangjoshi37a@gmail.com'

/** Non-reactive snapshot (for use outside React, e.g. module-level guards). */
export function experimentalAiEnabled(): boolean {
  if (EXPERIMENTAL_AI_ENV) return true
  const email = useAuth.getState().user?.email ?? null
  return email?.toLowerCase() === ADMIN_EMAIL
}

/**
 * React hook: whether experimental AI features should render. True when the build
 * opted in (local dev) OR the signed-in user is the owner. Reactive — re-renders
 * on sign-in / sign-out so the owner sees the feature appear after logging in and
 * the public never does.
 */
export function useExperimentalAI(): boolean {
  const email = useAuth((s) => s.user?.email ?? null)
  return EXPERIMENTAL_AI_ENV || email?.toLowerCase() === ADMIN_EMAIL
}
