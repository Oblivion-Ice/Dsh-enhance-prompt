/**
 * Rendering settings read from the documented settings Remote (§2.2) — and the
 * M4 §1.2 rule that separates "my Host entry is not active" from "I cannot read
 * the settings document".
 *
 * The Client half receives no loader config (`apply(ctx, config)` sees
 * `undefined`), so `enabled` / `minTextLength` / `referencesMode` come from the
 * Host's settings document instead of a plugin-private endpoint:
 *
 * - `ctx.remote.settings` is the generated namespace owned by
 *   `@deepseek-ai/dsh-api-settings-controller`;
 * - `describe()` returns `{ ok, value: { namespaces: [...] } }`, one
 *   `{ ns, value, … }` view per configurable profile entry;
 * - the namespace is the **profile entry id**, so this plugin's view is the row
 *   whose `ns === 'enhance'`;
 * - a namespace only appears when at least one of its fields is declared
 *   `.volatile()` in the plugin's Config schema (`enabled`, `minTextLength`,
 *   `referencesMode`).
 *
 * M4 §1.2 distinguishes the two reasons a namespace can be missing:
 *
 * - `describe()` **succeeds** and the `enhance` namespace is **absent** → the
 *   Host entry did not activate (almost always an invalid config). Rendering a
 *   button here would answer every click with `error: llm_failed`, which points
 *   at the model instead of the config. The control is therefore not registered.
 * - `describe()` **fails** (no settings controller, refused call, malformed
 *   envelope, present-but-invalid value) → the plugin cannot tell why, so it
 *   falls back to the documented defaults and renders. A visible control beats a
 *   silently missing one.
 *
 * Because the two halves of one plugin activate in no guaranteed order, absence
 * is re-checked for a short grace window before the plugin concludes "inactive".
 */

import { DEFAULT_ENHANCE_SETTINGS, isEnhanceSettings } from '../shared/protocol.ts'
import type { EnhanceSettings } from '../shared/protocol.ts'

/** Profile entry id = settings namespace. */
export const SETTINGS_NAMESPACE = 'enhance'

/** How long activation waits for the settings namespace before using defaults. */
export const SETTINGS_WAIT_MS = 1500

/**
 * How long an *absent* namespace is re-read before concluding the Host entry is
 * inactive. The Host entry may activate a few milliseconds after the Client half
 * on a cold boot; a hostile config never appears, so this only delays the
 * hide-by-design path.
 */
export const SETTINGS_INACTIVE_GRACE_MS = 800

/** Interval between absence re-reads inside the grace window. */
export const SETTINGS_INACTIVE_POLL_MS = 100

/** Minimal `remote.settings` surface this plugin uses (structural on purpose). */
export interface SettingsNamespaceLike {
  describe(): Promise<unknown>
}

/** The remote envelope: exactly one of these two shapes, discriminated on `ok`. */
interface RemoteEnvelope {
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string } | undefined
}

/** What activation learned about the settings, and what it must do about it. */
export type SettingsOutcome =
  /** The Host entry is active and served its three rendering fields. */
  | { kind: 'served'; settings: EnhanceSettings }
  /** The Host entry is provably not active: no slot entry must be registered. */
  | { kind: 'inactive' }
  /** The settings document could not be read: render with the documented defaults. */
  | { kind: 'fallback'; settings: EnhanceSettings }

/**
 * @param value - untrusted wire value.
 * @returns whether it is a remote envelope at all.
 */
function isEnvelope(value: unknown): value is RemoteEnvelope {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean'
}

/**
 * Read this plugin's namespace out of the settings document.
 * @param reply - untrusted `describe()` result.
 * @param ns - profile entry id.
 * @returns the namespace view, or undefined when it is absent.
 */
export function findNamespace(reply: unknown, ns: string): { value?: unknown } | undefined {
  if (!isEnvelope(reply) || reply.ok !== true) return undefined
  const namespaces = (reply.value as { namespaces?: unknown } | undefined)?.namespaces
  if (!Array.isArray(namespaces)) return undefined
  for (const entry of namespaces) {
    if (typeof entry !== 'object' || entry === null) continue
    if ((entry as { ns?: unknown }).ns === ns) return entry as { value?: unknown }
  }
  return undefined
}

/**
 * Decide what one successful `describe()` reply means for activation (M4 §1.2).
 *
 * - successful envelope, `enhance` present and valid → `served`;
 * - successful envelope, `enhance` absent → `inactive` (the Host entry is not
 *   active: an invalid config or another loader refusal);
 * - anything unreadable (refused, malformed, present-but-invalid value) →
 *   `fallback`, because guessing "inactive" from a broken read would hide the
 *   control on hosts whose settings controller merely differs.
 *
 * @param reply - untrusted `describe()` result.
 * @param ns - settings namespace (= profile entry id).
 * @returns the activation decision.
 */
export function decideSettings(reply: unknown, ns: string = SETTINGS_NAMESPACE): SettingsOutcome {
  if (!isEnvelope(reply) || reply.ok !== true) return { kind: 'fallback', settings: { ...DEFAULT_ENHANCE_SETTINGS } }
  const namespaces = (reply.value as { namespaces?: unknown } | undefined)?.namespaces
  if (!Array.isArray(namespaces)) return { kind: 'fallback', settings: { ...DEFAULT_ENHANCE_SETTINGS } }
  const view = findNamespace(reply, ns)
  if (view === undefined) return { kind: 'inactive' }
  if (isEnhanceSettings(view.value)) return { kind: 'served', settings: view.value }
  return { kind: 'fallback', settings: { ...DEFAULT_ENHANCE_SETTINGS } }
}

/**
 * Read this plugin's namespace out of the settings document.
 * @param remote - the mounted `remote` service, or undefined on a host without one.
 * @param ns - settings namespace (= profile entry id).
 * @returns the activation decision; `fallback` on every unreadable failure.
 */
export async function readSettings(
  remote: { settings?: SettingsNamespaceLike } | undefined,
  ns: string = SETTINGS_NAMESPACE,
): Promise<SettingsOutcome> {
  const settings = remote?.settings
  if (settings === undefined || typeof settings.describe !== 'function') {
    return { kind: 'fallback', settings: { ...DEFAULT_ENHANCE_SETTINGS } }
  }
  try {
    return decideSettings(await settings.describe(), ns)
  } catch {
    // A refused or unreachable settings document must not remove the control.
    return { kind: 'fallback', settings: { ...DEFAULT_ENHANCE_SETTINGS } }
  }
}

/** Injectable timing/reading seam for {@link awaitSettings} (tests shrink it). */
export interface AwaitSettingsOptions {
  /** Budget for `remote.settings` to appear. */
  waitMs?: number
  /** Budget for re-reading an absent namespace before calling the entry inactive. */
  graceMs?: number
  /** Interval between absence re-reads. */
  pollMs?: number
}

/**
 * Wait at most {@link SETTINGS_WAIT_MS} for `remote.settings` to exist, then read.
 *
 * A top-level `inject` on `remote.settings` would make the whole plugin wait
 * forever on a host that serves no settings controller, and Cordis 4 has no
 * optional-inject form. Waiting here keeps the control visible in that case
 * (documented fallback) while still honouring `enabled: false` whenever the
 * document is reachable.
 *
 * An absent namespace is re-read for up to {@link SETTINGS_INACTIVE_GRACE_MS}
 * so a cold-boot activation race cannot hide the control permanently (M4 §1.2).
 *
 * @param ctx - client Cordis context.
 * @param options - timing overrides for tests.
 * @returns the activation decision.
 */
export function awaitSettings(
  ctx: {
    inject(deps: string[], callback: (scoped: any) => void): unknown
  },
  options: AwaitSettingsOptions = {},
): Promise<SettingsOutcome> {
  const waitMs = options.waitMs ?? SETTINGS_WAIT_MS
  const graceMs = options.graceMs ?? SETTINGS_INACTIVE_GRACE_MS
  const pollMs = options.pollMs ?? SETTINGS_INACTIVE_POLL_MS
  const fallback = (): SettingsOutcome => ({ kind: 'fallback', settings: { ...DEFAULT_ENHANCE_SETTINGS } })
  return new Promise<SettingsOutcome>(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: SettingsOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    /** Re-arm the failure budget: first for waiting, then for the read itself. */
    const arm = (ms: number): void => {
      clearTimeout(timer)
      timer = setTimeout(() => finish(fallback()), ms)
    }
    arm(waitMs)

    let scoped: { remote?: { settings?: SettingsNamespaceLike } } | undefined
    const readOnce = async (): Promise<void> => {
      const outcome = await readSettings(scoped?.remote)
      if (settled) return
      if (outcome.kind !== 'inactive') {
        finish(outcome)
        return
      }
      // Absent namespace: the Host entry may still be activating. Re-read within
      // the grace window before concluding that it is inactive.
      const deadline = Date.now() + graceMs
      for (;;) {
        if (settled) return
        if (Date.now() >= deadline) {
          finish(outcome)
          return
        }
        await new Promise<void>(next => setTimeout(next, pollMs))
        const again = await readSettings(scoped?.remote)
        if (settled) return
        if (again.kind !== 'inactive') {
          finish(again)
          return
        }
      }
    }

    try {
      ctx.inject(['remote.settings'], (value: any) => {
        if (settled) return
        scoped = value
        // The service appeared; the decision now comes from the read. Bound a
        // hanging describe() with the same budget.
        arm(waitMs)
        void readOnce().catch(() => finish(fallback()))
      })
    } catch {
      finish(fallback())
    }
  })
}
