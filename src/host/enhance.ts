/**
 * One enhance call: resolve a route, make exactly one auxiliary model request,
 * assemble the stream, normalize the text, and record a desensitized result.
 *
 * The function takes its Host dependencies explicitly so unit tests can drive
 * every failure branch without a live DSH process.
 */

import type { EnhanceConfig } from './config.ts'
import type { EnhanceErrorCode, EnhanceInput, EnhanceResult, EnhanceRoute } from '../shared/protocol.ts'
import { cleanOutput } from './clean.ts'
import { hashInput, logRequest } from './logging.ts'
import { buildSystemPrompt, renderUserPrompt } from './prompts.ts'
import { resolveRoute } from './route.ts'
import type { LlmDirectory } from './route.ts'

/** Minimal chunk shape consumed by `BlockAssembler`. */
export interface ChatChunk {
  type: string
  [key: string]: unknown
}

/** Minimal assembled block shape. */
export interface AssembledBlock {
  type: string
  text?: string
}

/** Terminal stream reason. */
export interface FinishReason {
  kind: string
  failure?: { code?: string } | undefined
}

/** Minimal `BlockAssembler` surface. */
export interface AssemblerLike {
  push(chunk: ChatChunk): void
  blocks(): AssembledBlock[]
  readonly finish: FinishReason
}

/** One prepared call handle. */
export interface PreparedCallLike {
  config: Record<string, unknown>
  stream(options: Record<string, unknown>): AsyncIterable<ChatChunk> | Iterable<ChatChunk>
}

/** Minimal `ctx.llm` surface. */
export interface LlmLike extends LlmDirectory {
  prepareCall(config: Record<string, unknown>, signal?: AbortSignal | undefined): Promise<PreparedCallLike>
}

/** Minimal `dsh-timeout` deadline handle. */
export interface DeadlineLike {
  signal: AbortSignal
  [Symbol.dispose](): void
}

export interface EnhanceDeps {
  llm: LlmLike
  createUserMessage(input: { content: Array<{ type: 'text'; text: string }> }): unknown
  createAssembler(): AssemblerLike
  deadline(upstream: AbortSignal | undefined, timeoutMs: number, code: string): DeadlineLike
  timeoutOf(source: unknown, code: string): unknown
  home?: string | undefined
  warn?: ((message: string) => void) | undefined
}

/**
 * Estimate an output-token cap from a character target.
 * Intentionally generous: a truncated answer is worse than a slightly longer one.
 * @param maxOutputChars - configured character target.
 * @returns a positive token cap.
 */
export function estimateMaxTokens(maxOutputChars: number): number {
  return Math.max(256, Math.min(32768, Math.ceil(maxOutputChars * 1.5)))
}

/**
 * Execute one enhance request.
 * @param input - guarded Remote input.
 * @param config - resolved Host config.
 * @param signal - caller cancellation from the Gateway.
 * @param deps - Host services and test seams.
 * @returns a discriminated result; never throws for model/route failures.
 */
export async function enhance(
  input: EnhanceInput,
  config: EnhanceConfig,
  signal: AbortSignal | undefined,
  deps: EnhanceDeps,
): Promise<EnhanceResult> {
  const started = Date.now()
  const text = typeof input.text === 'string' ? input.text : ''
  const inputHash = hashInput(text)
  let route: EnhanceRoute | null = null
  let outputChars = 0
  let truncated = false

  const log = (outcome: 'ok' | 'error', code: EnhanceErrorCode | null): void => {
    if (!config.logRequests) return
    try {
      logRequest({
        ts: Date.now(),
        sessionId: input.sessionId ?? null,
        route,
        inputChars: text.length,
        outputChars,
        elapsedMs: Date.now() - started,
        outcome,
        inputHash,
        code,
        ...truncated ? { truncated: true } : {},
      }, { home: deps.home })
    } catch (error) {
      deps.warn?.(`enhance: failed to write request log: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const fail = (code: EnhanceErrorCode, message: string): EnhanceResult => {
    log('error', code)
    return { ok: false, code, message }
  }

  if (text.trim() === '') return fail('empty_input', 'input is empty')
  if (text.length > config.maxInputChars) return fail('too_long', `input exceeds ${config.maxInputChars} characters`)

  try {
    route = await resolveRoute({ config, reportedModel: input.model, llm: deps.llm, signal })
  } catch (error) {
    if (signal?.aborted) return fail('aborted', 'request aborted')
    return fail('no_route', errorCodeOf(error) ?? 'route resolution failed')
  }
  if (route === null) return fail('no_route', 'no provider/model route')

  const d = deps.deadline(signal, config.timeoutMs, 'ENHANCE_TIMEOUT')
  try {
    const call = await deps.llm.prepareCall({
      ...route,
      maxTokens: estimateMaxTokens(config.maxOutputChars),
    }, d.signal)

    const assembler = deps.createAssembler()
    const message = deps.createUserMessage({
      content: [{ type: 'text', text: renderUserPrompt(text) }],
    })
    const stream = call.stream({
      ...call.config,
      messages: [message],
      system: buildSystemPrompt(config.maxOutputChars),
      signal: d.signal,
    })
    for await (const chunk of stream) assembler.push(chunk)

    const finish = assembler.finish
    if (finish.kind === 'aborted') {
      return deps.timeoutOf(d.signal, 'ENHANCE_TIMEOUT') !== undefined
        ? fail('timeout', 'request timed out')
        : fail('aborted', 'request aborted')
    }
    if (finish.kind === 'error') {
      if (deps.timeoutOf(d.signal, 'ENHANCE_TIMEOUT') !== undefined) return fail('timeout', 'request timed out')
      return fail('llm_failed', finish.failure?.code ?? 'LLM_ERROR')
    }
    if (finish.kind === 'max-tokens') {
      truncated = true
      deps.warn?.('enhance: model stopped at max-tokens; result may be incomplete')
    } else if (finish.kind !== 'stop') {
      return fail('llm_failed', `UNEXPECTED_FINISH_${finish.kind}`)
    }

    const raw = assembler.blocks()
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('')
    const cleaned = cleanOutput(raw)
    outputChars = cleaned.length
    if (cleaned === '') return fail('empty_output', 'model returned empty output')
    if (cleaned.length > config.maxOutputChars) {
      truncated = true
      deps.warn?.(`enhance: output is ${cleaned.length} characters, above the ${config.maxOutputChars} target; accepting it whole`)
    }

    log('ok', null)
    return {
      ok: true,
      text: cleaned,
      route,
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    if (deps.timeoutOf(d.signal, 'ENHANCE_TIMEOUT') !== undefined) return fail('timeout', 'request timed out')
    if (signal?.aborted || d.signal.aborted) return fail('aborted', 'request aborted')
    const code = errorCodeOf(error)
    if (code === 'NO_ADAPTER') return fail('no_route', 'no adapter for route')
    return fail('llm_failed', code ?? 'LLM_ERROR')
  } finally {
    d[Symbol.dispose]()
  }
}

/**
 * Read a stable failure code without leaking the error object.
 * @param error - caught value.
 * @returns the code when present, else undefined.
 */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' && code.length > 0 ? code : undefined
}
