/**
 * Test doubles for the Host unit tests.
 * Imports only types, so no DSH package is needed outside the real Host.
 */

import type { AssemblerLike, ChatChunk, DeadlineLike, FinishReason, LlmLike } from '../src/host/enhance.ts'

/** Build an assembler that concatenates text deltas and reports one fixed finish. */
export function assemblerFor(initialFinish: FinishReason): AssemblerLike {
  let text = ''
  let finish = initialFinish
  return {
    push(chunk: ChatChunk): void {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'finish' && typeof chunk.reason === 'object' && chunk.reason !== null) {
        finish = chunk.reason as FinishReason
      }
    },
    blocks() {
      return [{ type: 'text', text }]
    },
    get finish() {
      return finish
    },
  }
}

export interface FakeLlmOptions {
  providers?: Array<{ id: string; name?: string }>
  models?: Record<string, Array<{ id: string }>>
  stream?: (options: Record<string, unknown>) => AsyncIterable<ChatChunk>
  prepareError?: unknown
}

/** Build the minimal `ctx.llm` surface used by enhance(). */
export function llmFor(options: FakeLlmOptions = {}): LlmLike {
  const providers = options.providers ?? [{ id: 'test-provider', name: 'Test' }]
  const models = options.models ?? { 'test-provider': [{ id: 'test-model' }] }
  return {
    listProviders: () => providers,
    listModels: async (provider: string) => models[provider] ?? [],
    prepareCall: async () => {
      if (options.prepareError !== undefined) throw options.prepareError
      return {
        config: {},
        stream: options.stream ?? (async function* () {
          yield { type: 'text-delta', index: 0, text: 'rewritten' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }),
      }
    },
  }
}

/** Deadline double; `timeout` aborts immediately with the marker `timeoutOf` recognizes. */
export function deadlineFor(signal: AbortSignal | undefined, mode: 'none' | 'timeout' = 'none'): DeadlineLike {
  if (mode === 'timeout') {
    const controller = new AbortController()
    controller.abort(Object.freeze({ timeoutCode: 'ENHANCE_TIMEOUT' }))
    return { signal: controller.signal, [Symbol.dispose]() {} }
  }
  return {
    signal: signal ?? new AbortController().signal,
    [Symbol.dispose]() {},
  }
}

/** Mirror of `timeoutOf` for the deadline double above. */
export function timeoutOfFake(source: unknown, code: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  const reason = Reflect.get(source, 'reason')
  if (typeof reason !== 'object' || reason === null) return undefined
  return Reflect.get(reason, 'timeoutCode') === code ? reason : undefined
}
