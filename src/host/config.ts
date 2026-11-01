/**
 * Host configuration: one normalized object for the rest of the plugin.
 *
 * `resolveConfig` is deliberately pure and independent of Schemastery so the
 * unit tests can exercise every bound without a Host. `schema.ts` declares the
 * same shape for the loader; this function applies the defaults and the
 * cross-field rules the schema cannot express (`provider` XOR `model`).
 */

import { REFERENCES_MODES } from '../shared/protocol.ts'
import type { ReferencesMode } from '../shared/protocol.ts'

export interface EnhanceConfig {
  enabled: boolean
  minTextLength: number
  referencesMode: ReferencesMode
  maxInputChars: number
  maxOutputChars: number
  timeoutMs: number
  provider?: string
  model?: string
  logRequests: boolean
  shortcut?: string
}

export const DEFAULT_CONFIG: Readonly<EnhanceConfig> = Object.freeze({
  enabled: true,
  minTextLength: 1,
  referencesMode: 'replace-text',
  maxInputChars: 4000,
  maxOutputChars: 800,
  timeoutMs: 20000,
  logRequests: true,
})

/**
 * Marker of a Schemastery `.volatile()` cell.
 *
 * A field the schema marks `.volatile()` reaches `apply()` as a live reference
 * (the loader commits edits into it without restarting the plugin), so a plain
 * `typeof` check would reject every value and freeze the plugin at its
 * defaults. `Symbol.for` is used instead of importing `@deepseek-ai/cosmokit`
 * because the cell is minted by the Host's own copy of that package.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** @param value - candidate. @returns whether it is a live `.volatile()` cell. */
export function isVolatileRef(value: unknown): value is { get(): unknown } {
  return typeof value === 'object' && value !== null
    && VOLATILE_WRITE in (value as object)
    && typeof (value as { get?: unknown }).get === 'function'
}

/** @param value - raw config field. @returns the current value, following a volatile cell. */
export function readField(value: unknown): unknown {
  return isVolatileRef(value) ? value.get() : value
}

const MAX_TEXT_LENGTH = 1_000_000
const MAX_OUTPUT_CHARS = 100_000
const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_SHORTCUT_LENGTH = 128

/** A configuration failure that names the offending field. */
export class ConfigError extends Error {
  readonly field: string

  /**
   * @param field - configuration path that failed.
   * @param message - field-level diagnostic.
   */
  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'ConfigError'
    this.field = field
  }
}

/**
 * Normalize and validate one raw loader config.
 * @param raw - value supplied by the profile patch (already schema-validated in production).
 * @returns a complete config with defaults applied.
 * @throws {ConfigError} when a value is outside its accepted range or the route pair is incomplete.
 */
export function resolveConfig(raw: unknown): EnhanceConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG }
  if (!isPlainObject(raw)) throw new ConfigError('config', 'must be an object')

  const enabled = readBoolean(raw, 'enabled', DEFAULT_CONFIG.enabled)
  const logRequests = readBoolean(raw, 'logRequests', DEFAULT_CONFIG.logRequests)
  const minTextLength = readInteger(raw, 'minTextLength', DEFAULT_CONFIG.minTextLength, 0, MAX_TEXT_LENGTH)
  const referencesMode = readReferencesMode(raw, DEFAULT_CONFIG.referencesMode)
  const maxInputChars = readInteger(raw, 'maxInputChars', DEFAULT_CONFIG.maxInputChars, 1, MAX_TEXT_LENGTH)
  const maxOutputChars = readInteger(raw, 'maxOutputChars', DEFAULT_CONFIG.maxOutputChars, 1, MAX_OUTPUT_CHARS)
  const timeoutMs = readInteger(raw, 'timeoutMs', DEFAULT_CONFIG.timeoutMs, 1, MAX_TIMEOUT_MS)

  const provider = readOptionalString(raw, 'provider')
  const model = readOptionalString(raw, 'model')
  if (provider !== undefined && model === undefined) {
    throw new ConfigError('model', 'provider and model must be supplied together')
  }
  if (provider === undefined && model !== undefined) {
    throw new ConfigError('provider', 'provider and model must be supplied together')
  }

  const shortcut = readOptionalString(raw, 'shortcut')
  if (shortcut !== undefined && shortcut.length > MAX_SHORTCUT_LENGTH) {
    throw new ConfigError('shortcut', `must be at most ${MAX_SHORTCUT_LENGTH} characters`)
  }

  return {
    enabled,
    minTextLength,
    referencesMode,
    maxInputChars,
    maxOutputChars,
    timeoutMs,
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
    logRequests,
    ...shortcut === undefined ? {} : { shortcut },
  }
}

/** @param value - candidate. @returns whether it is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param raw - config object.
 * @param field - boolean field name.
 * @param fallback - default when absent.
 * @returns the explicit value or the default.
 */
function readBoolean(raw: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = readField(raw[field])
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new ConfigError(field, 'must be a boolean')
  return value
}

/**
 * @param raw - config object.
 * @param field - number field name.
 * @param fallback - default when absent.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the explicit value or the default.
 */
function readInteger(raw: Record<string, unknown>, field: string, fallback: number, min: number, max: number): number {
  const value = readField(raw[field])
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigError(field, 'must be a finite integer')
  }
  if (value < min || value > max) throw new ConfigError(field, `must be between ${min} and ${max}`)
  return value
}

/**
 * @param raw - config object.
 * @param fallback - default mode.
 * @returns the validated reference-writeback mode.
 */
function readReferencesMode(raw: Record<string, unknown>, fallback: ReferencesMode): ReferencesMode {
  const value = readField(raw['referencesMode'])
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !(REFERENCES_MODES as readonly string[]).includes(value)) {
    throw new ConfigError('referencesMode', `must be one of ${REFERENCES_MODES.join(', ')}`)
  }
  return value as ReferencesMode
}

/**
 * @param raw - config object.
 * @param field - string field name.
 * @returns a trimmed non-empty string, or undefined for absent/blank values.
 */
function readOptionalString(raw: Record<string, unknown>, field: string): string | undefined {
  const value = readField(raw[field])
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ConfigError(field, 'must be a string')
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
