/**
 * Route resolution for one enhance call.
 *
 * Priority is fixed and never guesses:
 *   1. an explicit provider+model pair from configuration;
 *   2. the model id reported by the Client, searched through the live catalog;
 *   3. no route.
 *
 * Provider names come from `ctx.llm.listProviders()`; none are hardcoded.
 */

import type { EnhanceConfig } from './config.ts'

/** Minimal live-catalog surface used by resolution. */
export interface LlmDirectory {
  listProviders(): ReadonlyArray<{ id: string; name?: string }>
  listModels(provider: string): Promise<ReadonlyArray<{ id: string }>>
}

/** One resolved provider/model pair. */
export interface ResolvedRoute {
  provider: string
  model: string
}

export interface ResolveRouteOptions {
  config: EnhanceConfig
  reportedModel?: string | undefined
  llm: LlmDirectory
  signal?: AbortSignal | undefined
}

/**
 * Resolve the exact route for a request.
 * @param options - config, optional Client-reported model, live catalog, cancellation.
 * @returns the route, or null when no configured/reported model can be resolved.
 * @throws when the live catalog itself fails; the caller maps that to a failure code.
 */
export async function resolveRoute(options: ResolveRouteOptions): Promise<ResolvedRoute | null> {
  const { config, reportedModel, llm, signal } = options

  signal?.throwIfAborted()
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }

  const wanted = typeof reportedModel === 'string' ? reportedModel.trim() : ''
  if (wanted === '') return null

  signal?.throwIfAborted()
  for (const provider of llm.listProviders()) {
    signal?.throwIfAborted()
    const models = await llm.listModels(provider.id)
    if (models.some(model => model.id === wanted)) {
      return { provider: provider.id, model: wanted }
    }
  }
  return null
}
