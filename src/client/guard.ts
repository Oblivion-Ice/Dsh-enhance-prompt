/**
 * Client-side boundary adapter for the enhance Remote.
 *
 * The runtime guard itself lives only in `src/shared/protocol.ts`; this file
 * imports it so the built Client bundle contains the shared implementation
 * (asserted by `test/build.test.ts`). Any outcome that does not match the
 * shared guard collapses to `llm_failed` instead of being cast.
 */

import { isEnhanceResult } from '../shared/protocol.ts'
import type { EnhanceInput, EnhanceResult } from '../shared/protocol.ts'

/** Wire envelope shared by both remote methods (`$mount()` unary face). */
export interface RemoteOutcome {
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string } | undefined
}

/** Minimal mounted `remote.enhance` namespace surface. */
export interface EnhanceNamespace {
  /**
   * Rewrite one draft. The final positional argument is the gateway's
   * cancellation contract (M2 experiment 0.3: `ns.run(input, signal)` works;
   * `ns.run(input, { signal })` throws).
   */
  run(input: EnhanceInput, signal?: AbortSignal): Promise<RemoteOutcome>
}

/**
 * @param ns - the mounted `remote.enhance` namespace service.
 * @param input - guarded draft payload.
 * @param signal - caller cancellation; the Gateway folds a cancel into a
 *   resolved failure, so this function reports it as `null` instead of an error.
 * @returns a shared-protocol result, `null` when the caller aborted, or a
 *   `llm_failed` fallback for transport/shape failures.
 */
export async function callEnhance(
  ns: EnhanceNamespace,
  input: EnhanceInput,
  signal: AbortSignal,
): Promise<EnhanceResult | null> {
  try {
    const outcome = await ns.run(input, signal)
    if (signal.aborted) return null
    if (!outcome.ok) {
      const code = outcome.error?.code
      if (code === 'gateway/cancelled') return null
      return { ok: false, code: 'llm_failed', message: typeof code === 'string' ? code : 'transport' }
    }
    if (!isEnhanceResult(outcome.value)) {
      return { ok: false, code: 'llm_failed', message: 'invalid_result' }
    }
    return outcome.value
  } catch (error) {
    if (signal.aborted) return null
    return { ok: false, code: 'llm_failed', message: error instanceof Error ? error.name : 'transport' }
  }
}
