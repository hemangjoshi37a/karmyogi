import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AuthMode, ChatMessage, Provider } from '../core/aiGcode'

/**
 * AI G-code generator settings, persisted to localStorage.
 *
 * SECURITY: API keys AND session cookies live ONLY in the user's browser
 * (localStorage) and are sent ONLY to the chosen provider's official endpoint
 * (key mode) or the user's own relay/proxy URL (session mode) by
 * src/core/aiGcode.ts. They are never hardcoded, never logged, never sent
 * anywhere else.
 *
 * Follows the persist pattern of src/store/settings.ts / bed.ts.
 */

export type { AuthMode, ChatMessage, Provider }

/**
 * A single chat turn shown in the panel. Extends the wire-level ChatMessage
 * with UI metadata: the lint warnings computed for an assistant reply, and the
 * G-code extracted from it (so "Load into Program" works per message).
 */
export interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  at: number
  /** assistant only: G-code extracted + lint-cleaned from `content`. */
  gcode?: string
  /** assistant only: lint warning strings, pre-formatted for display. */
  warnings?: { level: 'error' | 'warn' | 'info'; message: string }[]
}

const CHAT_MAX = 60

/** Default model per provider — used when switching providers / first run. */
export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
}

/** A few suggested models per provider for the dropdown (custom is also allowed). */
export const MODEL_OPTIONS: Record<Provider, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
  anthropic: [
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
    'claude-3-7-sonnet-latest',
    'claude-sonnet-4-5',
  ],
}

/** A recent prompt the user generated from, for quick re-use. */
export interface HistoryItem {
  prompt: string
  provider: Provider
  model: string
  at: number
}

const HISTORY_MAX = 12

interface AiGcodeState {
  provider: Provider
  /** Auth mode: 'key' (official API) or 'session' (pasted cookie via a relay). */
  authMode: AuthMode
  /** Per-provider keys so a user can keep both without re-pasting. */
  apiKeys: { openai: string; anthropic: string }
  /** Per-provider chosen model (custom free-text allowed). */
  models: { openai: string; anthropic: string }
  /** session mode: pasted logged-in cookie, per provider. */
  sessionCookies: { openai: string; anthropic: string }
  /** session mode: user-supplied relay/proxy base URL, per provider. */
  proxyUrls: { openai: string; anthropic: string }
  lastPrompt: string
  history: HistoryItem[]
  /** The persisted chat conversation (browser-cached), oldest→newest. */
  chat: ChatTurn[]

  setProvider: (p: Provider) => void
  setAuthMode: (m: AuthMode) => void
  setApiKey: (p: Provider, key: string) => void
  setModel: (p: Provider, model: string) => void
  setSessionCookie: (p: Provider, cookie: string) => void
  setProxyUrl: (p: Provider, url: string) => void
  setLastPrompt: (prompt: string) => void
  pushHistory: (item: HistoryItem) => void
  clearHistory: () => void
  /** Append a chat turn (capped at CHAT_MAX). */
  pushChat: (turn: ChatTurn) => void
  /** Wipe the whole conversation (the "clear chat" button). */
  clearChat: () => void
  /**
   * Forget all stored secrets for the current provider (API key, session
   * cookie, proxy URL) — the "clear stored credentials" button. Pass a provider
   * to clear that one, or omit to clear BOTH providers.
   */
  clearCredentials: (p?: Provider) => void
}

export const useAiGcode = create<AiGcodeState>()(
  persist(
    (set) => ({
      provider: 'openai',
      authMode: 'key',
      apiKeys: { openai: '', anthropic: '' },
      models: {
        openai: DEFAULT_MODELS.openai,
        anthropic: DEFAULT_MODELS.anthropic,
      },
      sessionCookies: { openai: '', anthropic: '' },
      proxyUrls: { openai: '', anthropic: '' },
      lastPrompt: '',
      history: [],
      chat: [],

      setProvider: (provider) => set({ provider }),
      setAuthMode: (authMode) => set({ authMode }),
      setApiKey: (p, key) =>
        set((s) => ({ apiKeys: { ...s.apiKeys, [p]: key } })),
      setModel: (p, model) =>
        set((s) => ({ models: { ...s.models, [p]: model } })),
      setSessionCookie: (p, cookie) =>
        set((s) => ({ sessionCookies: { ...s.sessionCookies, [p]: cookie } })),
      setProxyUrl: (p, url) =>
        set((s) => ({ proxyUrls: { ...s.proxyUrls, [p]: url } })),
      setLastPrompt: (lastPrompt) => set({ lastPrompt }),
      pushHistory: (item) =>
        set((s) => {
          // De-dupe an identical consecutive prompt; cap the list length.
          const filtered = s.history.filter(
            (h) => !(h.prompt === item.prompt && h.provider === item.provider),
          )
          return { history: [item, ...filtered].slice(0, HISTORY_MAX) }
        }),
      clearHistory: () => set({ history: [] }),
      pushChat: (turn) =>
        set((s) => ({ chat: [...s.chat, turn].slice(-CHAT_MAX) })),
      clearChat: () => set({ chat: [] }),
      clearCredentials: (p) =>
        set((s) => {
          if (!p) {
            return {
              apiKeys: { openai: '', anthropic: '' },
              sessionCookies: { openai: '', anthropic: '' },
              proxyUrls: { openai: '', anthropic: '' },
            }
          }
          return {
            apiKeys: { ...s.apiKeys, [p]: '' },
            sessionCookies: { ...s.sessionCookies, [p]: '' },
            proxyUrls: { ...s.proxyUrls, [p]: '' },
          }
        }),
    }),
    {
      name: 'karmyogi.aiGcode',
      partialize: (s) => ({
        provider: s.provider,
        authMode: s.authMode,
        apiKeys: s.apiKeys,
        models: s.models,
        sessionCookies: s.sessionCookies,
        proxyUrls: s.proxyUrls,
        lastPrompt: s.lastPrompt,
        history: s.history,
        chat: s.chat,
      }),
    },
  ),
)
