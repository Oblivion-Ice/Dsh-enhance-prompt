import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../src/host/config.ts'
import { enhance } from '../src/host/enhance.ts'
import type { EnhanceDeps } from '../src/host/enhance.ts'
import { assemblerFor, deadlineFor, llmFor, timeoutOfFake } from './helpers.ts'

function depsFor(
  options: {
    llm?: ReturnType<typeof llmFor>
    finish?: { kind: string; failure?: { code?: string } }
    deadlineMode?: 'none' | 'timeout'
    warns?: string[]
  } = {},
): EnhanceDeps {
  const llm = options.llm ?? llmFor()
  const warns = options.warns ?? []
  return {
    llm,
    createUserMessage: input => input,
    createAssembler: () => assemblerFor(options.finish ?? { kind: 'stop' }),
    deadline: (signal, _timeoutMs, _code) => deadlineFor(signal, options.deadlineMode),
    timeoutOf: timeoutOfFake,
    warn: message => {
      warns.push(message)
    },
  }
}

const routedConfig = () => resolveConfig({
  provider: 'test-provider',
  model: 'test-model',
  logRequests: false,
})

test('errors: empty_input never reaches the model', async () => {
  let prepared = false
  const llm = llmFor()
  const original = llm.prepareCall
  llm.prepareCall = async (...args) => {
    prepared = true
    return original(...args)
  }
  const result = await enhance({ text: '   \n\t' }, routedConfig(), undefined, depsFor({ llm }))
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, 'empty_input')
  assert.equal(prepared, false)
})

test('errors: too_long rejects before any network work', async () => {
  const result = await enhance(
    { text: '12345' },
    resolveConfig({ provider: 'test-provider', model: 'test-model', maxInputChars: 4, logRequests: false }),
    undefined,
    depsFor(),
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, 'too_long')
})

test('errors: no_route when neither config nor a reported model resolves', async () => {
  const result = await enhance({ text: 'hello' }, resolveConfig({ logRequests: false }), undefined, depsFor())
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, 'no_route')
})

test('errors: timeout is classified before generic cancellation', async () => {
  const llm = llmFor({ prepareError: new Error('slow SECRET_MARKER') })
  const result = await enhance(
    { text: 'hello' },
    routedConfig(),
    undefined,
    depsFor({ llm, deadlineMode: 'timeout' }),
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, 'timeout')
  assert.ok(!JSON.stringify(result).includes('SECRET_MARKER'))
})

test('errors: aborted when the caller signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort(new Error('caller cancelled SECRET_MARKER'))
  const result = await enhance({ text: 'hello' }, routedConfig(), controller.signal, depsFor())
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, 'aborted')
  assert.ok(!JSON.stringify(result).includes('SECRET_MARKER'))
})

test('errors: llm_failed exposes only the provider failure code', async () => {
  const llm = llmFor({
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }
    },
  })
  const result = await enhance({ text: 'hello' }, routedConfig(), undefined, depsFor({ llm }))
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, 'llm_failed')
  assert.equal(!result.ok && result.message, 'RATE_LIMIT')
})

test('errors: empty_output when the model returns only whitespace', async () => {
  const llm = llmFor({
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '   \n' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const result = await enhance({ text: 'hello' }, routedConfig(), undefined, depsFor({ llm }))
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, 'empty_output')
})

test('errors: a missing adapter becomes no_route', async () => {
  const llm = llmFor({ prepareError: Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' }) })
  const result = await enhance({ text: 'hello' }, routedConfig(), undefined, depsFor({ llm }))
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, 'no_route')
})

test('success: cleaned text, chosen route, and elapsed time are returned', async () => {
  const llm = llmFor({
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '  "rewritten prompt"\n' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const result = await enhance({ text: 'hello' }, routedConfig(), undefined, depsFor({ llm }))
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.text, 'rewritten prompt')
    assert.deepEqual(result.route, { provider: 'test-provider', model: 'test-model' })
    assert.ok(result.elapsedMs >= 0)
  }
})

test('success: output above maxOutputChars is accepted whole and warns', async () => {
  const warns: string[] = []
  const llm = llmFor({
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: 'this prompt is longer than the target' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const config = resolveConfig({
    provider: 'test-provider',
    model: 'test-model',
    maxOutputChars: 5,
    logRequests: false,
  })
  const result = await enhance({ text: 'hello' }, config, undefined, depsFor({ llm, warns }))
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.text, 'this prompt is longer than the target')
  assert.ok(warns.some(message => message.includes('above the 5 target')))
})

test('success: max-tokens is accepted whole and flagged as truncated', async () => {
  const warns: string[] = []
  const llm = llmFor({
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: 'a complete-looking prompt' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  })
  const result = await enhance({ text: 'hello' }, routedConfig(), undefined, depsFor({ llm, warns }))
  assert.equal(result.ok, true)
  assert.ok(warns.some(message => message.includes('max-tokens')))
})
