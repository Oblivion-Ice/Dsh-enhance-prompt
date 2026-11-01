/**
 * Shared Remote contract for the enhance endpoint.
 *
 * The M0 channel carries this contract without trusting either side: the Client
 * mounts a hand-written descriptor and the Host resolves through SRC, so neither
 * side validates types on the wire. These runtime guards are therefore the
 * actual boundary and must be called on both sides.
 */

/**
 * Protocol identity compiled into both halves. `build.test.ts` asserts this
 * marker appears in the generated Client bundle, so a hand-copied guard cannot
 * silently replace the shared one.
 */
export const ENHANCE_PROTOCOL_TAG = 'dsh-enhance-prompt/protocol@1'

export const ENHANCE_ERROR_CODES = [
  'empty_input',
  'too_long',
  'no_route',
  'timeout',
  'aborted',
  'llm_failed',
  'empty_output',
  'apply_failed',
  'references_unsupported',
] as const

export type EnhanceErrorCode = (typeof ENHANCE_ERROR_CODES)[number]

/** How a draft carrying reference chips is treated (M3 §1). */
export const REFERENCES_MODES = ['replace-text', 'disabled'] as const

export type ReferencesMode = (typeof REFERENCES_MODES)[number]

export interface EnhanceRoute {
  provider: string
  model: string
}

export interface EnhanceInput {
  text: string
  sessionId?: string
  model?: string
  locale?: 'zh' | 'en'
}

/**
 * Rendering-relevant Host settings, read from the settings document (`M3 §2.2`).
 *
 * The client half receives no loader config (M2 experiment 0.2:
 * `apply(ctx, config)` sees `undefined`), so these three fields are the ones
 * declared `.volatile()` in the Host Config schema and projected into the
 * `enhance` settings namespace.
 */
export interface EnhanceSettings {
  enabled: boolean
  minTextLength: number
  referencesMode: ReferencesMode
}

/** Fallback settings when the settings document cannot be read at activation. */
export const DEFAULT_ENHANCE_SETTINGS: Readonly<EnhanceSettings> = Object.freeze({
  enabled: true,
  minTextLength: 1,
  referencesMode: 'replace-text',
})

export type EnhanceResult =
  | {
      ok: true
      text: string
      route: EnhanceRoute
      elapsedMs: number
    }
  | {
      ok: false
      code: EnhanceErrorCode
      message: string
    }

/** @param value - untrusted wire value. @returns whether it is a known error code. */
export function isEnhanceErrorCode(value: unknown): value is EnhanceErrorCode {
  return typeof value === 'string'
    && (ENHANCE_ERROR_CODES as readonly string[]).includes(value)
}

/** @param value - untrusted wire value. @returns whether it is a well-formed request input. */
export function isEnhanceInput(value: unknown): value is EnhanceInput {
  if (!isPlainObject(value)) return false
  if (typeof value.text !== 'string') return false
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') return false
  if (value.model !== undefined && typeof value.model !== 'string') return false
  if (value.locale !== undefined && value.locale !== 'zh' && value.locale !== 'en') return false
  return true
}

/** @param value - untrusted wire value. @returns whether it is a well-formed enhance result. */
export function isEnhanceResult(value: unknown): value is EnhanceResult {
  if (!isPlainObject(value)) return false
  if (typeof value.ok !== 'boolean') return false
  if (value.ok) {
    if (typeof value.text !== 'string') return false
    if (!isPlainObject(value.route)) return false
    if (typeof value.route.provider !== 'string' || value.route.provider.length === 0) return false
    if (typeof value.route.model !== 'string' || value.route.model.length === 0) return false
    if (typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) return false
    return true
  }
  if (!isEnhanceErrorCode(value.code)) return false
  if (typeof value.message !== 'string') return false
  return true
}

/** @param value - untrusted wire value. @returns whether it is a well-formed settings record. */
export function isEnhanceSettings(value: unknown): value is EnhanceSettings {
  if (!isPlainObject(value)) return false
  if (typeof value.enabled !== 'boolean') return false
  if (typeof value.minTextLength !== 'number') return false
  if (!Number.isInteger(value.minTextLength) || value.minTextLength < 0) return false
  if (!(REFERENCES_MODES as readonly unknown[]).includes(value.referencesMode)) return false
  return true
}

/** @param value - candidate object. @returns whether it is a plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
