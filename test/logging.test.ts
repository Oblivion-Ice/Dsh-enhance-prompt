import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/host/config.ts'
import { enhance } from '../src/host/enhance.ts'
import { hashInput, logRequest } from '../src/host/logging.ts'
import { assemblerFor, deadlineFor, llmFor, timeoutOfFake } from './helpers.ts'

const TEXT_MARKER = 'TEXT_MARKER_7f3c_unique_input'

test('logging: hash is stable and never contains the input', () => {
  const hash = hashInput(TEXT_MARKER)
  assert.match(hash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(hash, hashInput(TEXT_MARKER))
  assert.ok(!hash.includes(TEXT_MARKER))
})

test('logging: a successful enhance writes one desensitized line', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-enhance-log-'))
  try {
    const llm = llmFor({
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: 'rewritten' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const config = resolveConfig({
      provider: 'test-provider',
      model: 'test-model',
      logRequests: true,
    })
    const result = await enhance({ text: TEXT_MARKER, sessionId: 'session-test' }, config, undefined, {
      llm,
      createUserMessage: input => input,
      createAssembler: () => assemblerFor({ kind: 'stop' }),
      deadline: (signal, _timeoutMs, _code) => deadlineFor(signal),
      timeoutOf: timeoutOfFake,
      home,
      warn: () => {},
    })
    assert.equal(result.ok, true)

    const raw = readFileSync(join(home, 'enhance', 'requests.jsonl'), 'utf8')
    assert.ok(!raw.includes(TEXT_MARKER), 'the log must not contain the original input')
    const entry = JSON.parse(raw.trim()) as Record<string, unknown>
    assert.equal(entry.outcome, 'ok')
    assert.equal(entry.code, null)
    assert.equal(entry.sessionId, 'session-test')
    assert.equal(entry.inputChars, TEXT_MARKER.length)
    assert.equal(entry.outputChars, 'rewritten'.length)
    assert.equal(entry.inputHash, hashInput(TEXT_MARKER))
    assert.deepEqual(entry.route, { provider: 'test-provider', model: 'test-model' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('logging: logRequests=false writes nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-enhance-nolog-'))
  try {
    const config = resolveConfig({
      provider: 'test-provider',
      model: 'test-model',
      logRequests: false,
    })
    await enhance({ text: 'hello' }, config, undefined, {
      llm: llmFor(),
      createUserMessage: input => input,
      createAssembler: () => assemblerFor({ kind: 'stop' }),
      deadline: (signal, _timeoutMs, _code) => deadlineFor(signal),
      timeoutOf: timeoutOfFake,
      home,
      warn: () => {},
    })
    assert.equal(existsSync(join(home, 'enhance', 'requests.jsonl')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('logging: rotation keeps the configured generations', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-enhance-rotate-'))
  try {
    const base = {
      sessionId: null,
      route: null,
      inputChars: 1,
      outputChars: 1,
      elapsedMs: 1,
      outcome: 'ok' as const,
      inputHash: hashInput('x'),
      code: null,
    }
    for (let index = 0; index < 6; index += 1) {
      logRequest({ ...base, ts: index }, { home, maxBytes: 80, keep: 2 })
    }
    assert.equal(existsSync(join(home, 'enhance', 'requests.jsonl')), true)
    assert.equal(existsSync(join(home, 'enhance', 'requests.jsonl.1')), true)
    assert.equal(existsSync(join(home, 'enhance', 'requests.jsonl.2')), true)
    assert.equal(existsSync(join(home, 'enhance', 'requests.jsonl.3')), false)
    const active = readFileSync(join(home, 'enhance', 'requests.jsonl'), 'utf8').trim()
    assert.equal((JSON.parse(active) as { ts: number }).ts, 5)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
