import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../src/host/config.ts'
import { resolveRoute } from '../src/host/route.ts'
import type { LlmDirectory } from '../src/host/route.ts'

function directory(
  providers: Array<{ id: string; name?: string }>,
  models: Record<string, Array<{ id: string }>>,
): LlmDirectory {
  return {
    listProviders: () => providers,
    listModels: async (provider: string) => models[provider] ?? [],
  }
}

test('route: explicit provider+model wins over a reported model', async () => {
  const config = resolveConfig({ provider: 'cfg-provider', model: 'cfg-model' })
  const llm = directory(
    [{ id: 'reported-provider' }, { id: 'cfg-provider' }],
    { 'reported-provider': [{ id: 'reported-model' }], 'cfg-provider': [{ id: 'cfg-model' }] },
  )
  const route = await resolveRoute({ config, reportedModel: 'reported-model', llm })
  assert.deepEqual(route, { provider: 'cfg-provider', model: 'cfg-model' })
})

test('route: reported model is searched through providers in order and takes the first hit', async () => {
  const config = resolveConfig({})
  const llm = directory(
    [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
    {
      first: [{ id: 'other' }],
      second: [{ id: 'wanted' }],
      third: [{ id: 'wanted' }],
    },
  )
  const route = await resolveRoute({ config, reportedModel: 'wanted', llm })
  assert.deepEqual(route, { provider: 'second', model: 'wanted' })
})

test('route: no config pair and no reported model yields no route', async () => {
  let listed = false
  const config = resolveConfig({})
  const llm: LlmDirectory = {
    listProviders: () => {
      listed = true
      return [{ id: 'p' }]
    },
    listModels: async () => [{ id: 'm' }],
  }
  assert.equal(await resolveRoute({ config, llm }), null)
  assert.equal(listed, false)
})

test('route: an unknown reported model yields no route', async () => {
  const config = resolveConfig({})
  const llm = directory([{ id: 'p' }], { p: [{ id: 'known' }] })
  assert.equal(await resolveRoute({ config, reportedModel: 'missing', llm }), null)
})

test('route: an aborted signal stops catalog lookups', async () => {
  const config = resolveConfig({})
  const llm = directory([{ id: 'p' }], { p: [{ id: 'm' }] })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    resolveRoute({ config, reportedModel: 'm', llm, signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
})
