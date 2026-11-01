/**
 * Build-artifact tests. `test` runs `node build.mjs` first, so these assert the
 * exact artifacts that ship rather than the TypeScript sources.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const clientPath = new URL('../lib/client.js', import.meta.url)
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const fakeReact = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useCallback: (fn: unknown) => fn,
}

/** What one materialization exposes to the assertions. */
interface Materialized {
  source: string
  registration: any
  exports: any
  required: string[]
}

/** Load the generated client bundle through a fake loader and materialize it. */
function materializeClient(): Materialized {
  const source = fs.readFileSync(clientPath, 'utf8')
  let registration: any
  const sandbox: Record<string, any> = {
    window: {
      __ModuleLoader__: {
        load(candidate: any) {
          registration = candidate
        },
      },
    },
    console,
    // The settings read races its namespace against a bounded wait.
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  assert.ok(registration, 'bundle did not call window.__ModuleLoader__.load')
  const required: string[] = []
  const exports = registration.factory((specifier: string) => {
    required.push(specifier)
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected external ${specifier}`)
  })
  return { source, registration, exports, required }
}

test('build: client bundle registers the package envelope lazily', () => {
  const { registration, exports, required } = materializeClient()
  assert.equal(registration.id, packageJson.name)
  assert.equal(typeof registration.factory, 'function')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots', 'locale', 'remote'])
  assert.deepEqual([...new Set(required)], ['react'])
  assert.ok(required.length >= 1)
})

test('build: client bundle inlines zod and compiles the shared protocol', () => {
  const { source } = materializeClient()
  assert.doesNotMatch(source, /require\(["']zod(\/mini)?["']\)/)
  assert.match(source, /dsh-enhance-prompt\/protocol@1/)
  // Shared guard, not a hand copy, owns the error-code list.
  for (const code of ['empty_input', 'too_long', 'no_route', 'timeout', 'aborted', 'llm_failed', 'empty_output']) {
    assert.match(source, new RegExp(code))
  }
})

test('build: no experiment probe survives in the shipped Client', () => {
  const { source } = materializeClient()
  for (const marker of ['__m2probe', '__m3probe', 'm2-probe', 'm3-probe', 'AUTO_PROBE', 'data-m1-result']) {
    assert.equal(source.includes(marker), false, `bundle still contains ${marker}`)
  }
  assert.ok(source.includes('data-dsh-enhance'))
  assert.ok(source.includes('dsh-enhance-button'))
})

test('build: client bundle stays under the 200 KB budget', () => {
  const bytes = fs.statSync(clientPath).size
  assert.ok(bytes < 200 * 1024, `client.js is ${bytes} bytes`)
})

test('build: mounted contribution carries real zod codecs', async () => {
  const { exports } = materializeClient()
  let contribution: any
  let registered: any
  const settingsReply = {
    ok: true,
    value: {
      namespaces: [
        { ns: 'other', value: { x: 1 } },
        { ns: 'enhance', value: { enabled: true, minTextLength: 3, referencesMode: 'replace-text' } },
      ],
    },
  }
  const scoped = {
    remote: {
      enhance: {
        run: async () => ({ ok: true, value: undefined }),
      },
      settings: {
        describe: async () => settingsReply,
      },
    },
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (options: any, component: any) => {
        registered = { options, component }
        return () => {}
      },
    },
  }
  const ctx = {
    remote: {
      async $mount(candidate: any) {
        contribution = candidate
      },
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    effect: (callback: () => void) => callback(),
    get: () => undefined,
    inject: (deps: string[], callback: (scoped: any) => void) => {
      if (deps.includes('remote.settings')) callback({ remote: { settings: scoped.remote.settings } })
      callback(scoped)
      return () => {}
    },
  }
  await exports.apply(ctx)
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.ok(contribution, 'apply did not mount the Remote contribution')
  assert.equal(registered.options.id, 'enhance')
  assert.equal(registered.options.order, 10)
  assert.equal(registered.options.locale, 'enhance')
  // §2.2: one descriptor left — the plugin-private `settings` method is gone.
  assert.equal(contribution.descriptors.length, 1)
  assert.equal(contribution.descriptors[0].method, 'run')
  const descriptor = contribution.descriptors[0]
  const inputCodec = descriptor.parameters[0].codec.create()
  const resultCodec = descriptor.result.create()

  assert.equal(inputCodec.safeParse({ text: 'hi' }).success, true)
  assert.equal(inputCodec.safeParse({ text: 'hi', sessionId: 's', locale: 'zh' }).success, true)
  assert.equal(inputCodec.safeParse({ text: 'hi', unexpected: true }).success, false)
  assert.equal(inputCodec.safeParse({}).success, false)

  assert.equal(resultCodec.safeParse({
    ok: true,
    text: 'x',
    route: { provider: 'p', model: 'm' },
    elapsedMs: 1,
  }).success, true)
  assert.equal(resultCodec.safeParse({ ok: false, code: 'no_route', message: 'nope' }).success, true)
  assert.equal(resultCodec.safeParse({ ok: false, code: 'apply_failed', message: 'nope' }).success, true)
  assert.equal(resultCodec.safeParse({ ok: false, code: 'other', message: 'nope' }).success, false)
})

test('build: rendering settings come from the documented settings namespace', async () => {
  const { exports } = materializeClient()
  let registered: any
  const replies = {
    ok: true,
    value: {
      namespaces: [{ ns: 'enhance', value: { enabled: true, minTextLength: 4, referencesMode: 'disabled' } }],
    },
  }
  const ctx = {
    remote: { async $mount() {} },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    effect: (callback: () => void) => callback(),
    get: () => undefined,
    inject: (deps: string[], callback: (scoped: any) => void) => {
      if (deps.includes('remote.settings')) {
        callback({ remote: { settings: { describe: async () => replies } } })
        return () => {}
      }
      callback({
        remote: { enhance: { run: async () => ({ ok: true, value: undefined }) } },
        slots: {
          inject: (_name: string, fn: () => void) => fn(),
          register: (options: any, component: any) => {
            registered = { options, component }
            return () => {}
          },
        },
      })
      return () => {}
    },
  }
  await exports.apply(ctx)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(registered, 'the slot entry was not registered')
})

test('build: an absent enhance namespace registers no slot entry (M4 §1.2)', async () => {
  const { exports } = materializeClient()
  let registered = false
  const ctx = {
    remote: { async $mount() {} },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    effect: (callback: () => void) => callback(),
    get: () => undefined,
    inject: (deps: string[], callback: (scoped: any) => void) => {
      if (deps.includes('remote.settings')) {
        callback({ remote: { settings: { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'other' }] } }) } } })
        return () => {}
      }
      callback({ slots: { inject: () => { registered = true }, register: () => () => {} } })
      return () => {}
    },
  }
  await exports.apply(ctx)
  // The 800 ms inactive grace window decides; give it time to expire.
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(registered, false)
})

test('build: enabled=false registers no slot entry', async () => {
  const { exports } = materializeClient()
  let registered = false
  const settingsReply = {
    ok: true,
    value: {
      namespaces: [{ ns: 'enhance', value: { enabled: false, minTextLength: 1, referencesMode: 'replace-text' } }],
    },
  }
  const ctx = {
    remote: { async $mount() {} },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    effect: (callback: () => void) => callback(),
    get: () => undefined,
    inject: (deps: string[], callback: (scoped: any) => void) => {
      if (deps.includes('remote.settings')) {
        callback({ remote: { settings: { describe: async () => settingsReply } } })
        return () => {}
      }
      callback({ slots: { inject: () => { registered = true }, register: () => () => {} } })
      return () => {}
    },
  }
  await exports.apply(ctx)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(registered, false)
})

test('build: a refused settings document falls back to the documented defaults', async () => {
  const { exports } = materializeClient()
  let registered = false
  const ctx = {
    remote: { async $mount() {} },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    effect: (callback: () => void) => callback(),
    get: () => undefined,
    inject: (deps: string[], callback: (scoped: any) => void) => {
      if (deps.includes('remote.settings')) {
        callback({ remote: { settings: { describe: async () => ({ ok: false, error: { code: 'settings/rejected' } }) } } })
        return () => {}
      }
      callback({
        remote: { enhance: { run: async () => ({ ok: true, value: undefined }) } },
        slots: { inject: () => { registered = true }, register: () => () => {} },
      })
      return () => {}
    },
  }
  await exports.apply(ctx)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(registered, true)
})

test('build: generated Host ESM has no residual .ts specifiers', () => {
  for (const dir of ['lib/host', 'lib/shared']) {
    for (const name of fs.readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      if (!name.endsWith('.js')) continue
      const source = fs.readFileSync(new URL(`../${dir}/${name}`, import.meta.url), 'utf8')
      assert.doesNotMatch(source, /\bfrom\s*["']\.{1,2}\/[^"']+\.ts["']/, `${dir}/${name} still imports .ts`)
    }
  }
  assert.match(
    fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'),
    /export \{ apply, inject, Config \} from '\.\/host\/index\.js'/,
  )
})

test('build: lib/ is fully generated from src/', () => {
  const expected = [
    'lib/client.js',
    'lib/index.js',
    'lib/host/index.js',
    'lib/host/enhance.js',
    'lib/host/config.js',
    'lib/shared/protocol.js',
  ]
  for (const relative of expected) {
    assert.equal(fs.existsSync(new URL(`../${relative}`, import.meta.url)), true, `missing ${relative}`)
  }
})
