import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/host/config.ts'
import { enhance } from '../src/host/enhance.ts'
import { assemblerFor, deadlineFor, llmFor, timeoutOfFake } from './helpers.ts'

test('abort: aborting mid-stream returns aborted and never logs outcome ok', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-enhance-abort-'))
  try {
    const controller = new AbortController()
    const llm = llmFor({
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial ' }
        await new Promise<never>((_resolve, reject) => {
          if (controller.signal.aborted) {
            reject(new Error('aborted'))
            return
          }
          controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
    })
    const config = resolveConfig({
      provider: 'test-provider',
      model: 'test-model',
      logRequests: true,
      timeoutMs: 20000,
    })
    const pending = enhance({ text: 'hello' }, config, controller.signal, {
      llm,
      createUserMessage: input => input,
      createAssembler: () => assemblerFor({ kind: 'stop' }),
      deadline: (signal, _timeoutMs, _code) => deadlineFor(signal),
      timeoutOf: timeoutOfFake,
      home,
      warn: () => {},
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.code, 'aborted')

    const lines = readFileSync(join(home, 'enhance', 'requests.jsonl'), 'utf8').trim().split('\n')
    const entry = JSON.parse(lines.at(-1) as string) as { outcome: string; code: string | null }
    assert.equal(entry.outcome, 'error')
    assert.equal(entry.code, 'aborted')
    assert.notEqual(entry.outcome, 'ok')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
