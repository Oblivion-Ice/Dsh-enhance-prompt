/**
 * Host entry for dsh-enhance-prompt.
 *
 * Registers one Cordis Service (`enhance`) and exposes `enhance/run` through
 * the M0-verified channel: a hand-written `typertRemote` binding plus the
 * protocol package's prototype marker, which the Gateway resolves in SRC mode.
 *
 * The model call uses `ctx.llm.prepareCall()` and a deadline; it never writes a
 * Session, never sends tools, and never binds the request to a conversation.
 *
 * M3 §2.2 removed the plugin-private `enhance/settings` method: the Client half
 * reads `enabled` / `minTextLength` / `referencesMode` from the documented
 * settings document (`ctx.remote.settings`, namespace = profile entry id),
 * which serves the fields this Config marks `.volatile()`.
 */

import { Service } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { EnhanceInput, EnhanceResult } from '../shared/protocol.ts'
import { isEnhanceInput } from '../shared/protocol.ts'
import { resolveConfig } from './config.ts'
import type { EnhanceConfig } from './config.ts'
import { enhance } from './enhance.ts'
import type { EnhanceDeps, LlmLike } from './enhance.ts'

export { Config } from './schema.ts'

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Host services this plugin actually reads. */
export interface EnhanceContext {
  llm: LlmLike
  plugin(plugin: unknown): unknown
}

/** Required Cordis services; `llm` is read in `apply`, before the service exists. */
export const inject = ['llm'] as const

/**
 * Mount the enhance service.
 * @param ctx - Host context with the declared `llm` service.
 * @param rawConfig - loader config; defaults and bounds are applied here.
 */
export function apply(ctx: EnhanceContext, rawConfig?: unknown): void {
  const config: EnhanceConfig = resolveConfig(rawConfig)
  const llm = ctx.llm
  const warn = (message: string): void => {
    console.warn(`[dsh-enhance-prompt] ${message}`)
  }

  class EnhanceService extends Service {
    declare typertRemote: { service: unknown; serviceKey: string; namespace: string }

    /** @param serviceCtx - owning Cordis context. */
    constructor(serviceCtx: unknown) {
      super(serviceCtx as never, 'enhance')
      this.typertRemote = Object.freeze({
        service: this,
        serviceKey: 'enhance',
        namespace: 'enhance',
      })
    }

    /**
     * M1 endpoint: rewrite one draft through a single auxiliary model call.
     * @param input - untrusted wire input.
     * @param signal - Gateway-injected cancellation signal.
     * @returns a discriminated result; failures are codes, not exceptions.
     */
    async run(input: unknown, signal: AbortSignal): Promise<EnhanceResult> {
      if (!isEnhanceInput(input)) {
        return { ok: false, code: 'llm_failed', message: 'INVALID_INPUT' }
      }
      const deps: EnhanceDeps = {
        llm,
        createUserMessage: message => createUserMessage(message as never),
        createAssembler: () => new BlockAssembler(),
        deadline: (upstream, timeoutMs, code) => deadline(upstream, timeoutMs, code),
        timeoutOf: (source, code) => timeoutOf(source as never, code),
        warn,
      }
      return enhance(input as EnhanceInput, config, signal, deps)
    }
  }

  // Hand-written equivalent of `@Remote` on `run` (M0-verified).
  Object.defineProperty(EnhanceService.prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: {
      version: 1,
      methods: [
        Object.freeze({
          method: 'run',
          invocation: Object.freeze({ kind: 'direct' }),
        }),
      ],
    },
  })

  ctx.plugin(EnhanceService)
}
