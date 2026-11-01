/**
 * M3 §2.2 / M4 §1.2 — reading `enabled` / `minTextLength` / `referencesMode`
 * from the documented settings namespace, and telling "my Host entry is not
 * active" apart from "the settings document could not be read".
 *
 * The wire shape is the one measured on a live host (`.m3/exp-settings-after.out.txt`):
 * `describe()` → `{ ok, value: { namespaces: [{ ns, value, revision, … }] } }`,
 * and this plugin's view is `ns === 'enhance'`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  awaitSettings,
  decideSettings,
  findNamespace,
  readSettings,
  SETTINGS_NAMESPACE,
  SETTINGS_WAIT_MS,
} from '../src/client/settings.ts'
import { DEFAULT_ENHANCE_SETTINGS } from '../src/shared/protocol.ts'

const defaults = { ...DEFAULT_ENHANCE_SETTINGS }

const envelope = (namespaces: unknown): unknown => ({ ok: true, value: { namespaces } })

test('settings: the namespace is the profile entry id', () => {
  assert.equal(SETTINGS_NAMESPACE, 'enhance')
})

test('settings: findNamespace reads only a successful envelope', () => {
  assert.equal(findNamespace({ ok: false, error: { code: 'settings/rejected' } }, 'enhance'), undefined)
  assert.equal(findNamespace({ value: { namespaces: [] } }, 'enhance'), undefined)
  assert.equal(findNamespace({ ok: true, value: { namespaces: 'nope' } }, 'enhance'), undefined)
  assert.equal(findNamespace(null, 'enhance'), undefined)
  assert.deepEqual(findNamespace(envelope([{ ns: 'other' }, { ns: 'enhance', value: { enabled: true } }]), 'enhance'), {
    ns: 'enhance',
    value: { enabled: true },
  })
})

test('settings: a served namespace provides all three fields', async () => {
  const settings = {
    describe: async () => envelope([{ ns: 'enhance', value: { enabled: false, minTextLength: 4, referencesMode: 'disabled' } }]),
  }
  assert.deepEqual(await readSettings({ settings }), {
    kind: 'served',
    settings: { enabled: false, minTextLength: 4, referencesMode: 'disabled' },
  })
})

test('settings: a successful describe() without the namespace means the Host entry is inactive', async () => {
  const settings = { describe: async () => envelope([{ ns: 'other', value: {} }]) }
  assert.deepEqual(decideSettings(envelope([{ ns: 'other' }])), { kind: 'inactive' })
  assert.deepEqual(await readSettings({ settings }), { kind: 'inactive' })
})

test('settings: every unreadable failure mode degrades to the documented defaults', async () => {
  const cases = [
    undefined,
    {},
    { settings: {} },
    { settings: { describe: async () => { throw new Error('refused') } } },
    { settings: { describe: async () => ({ ok: false, error: { code: 'settings/rejected' } }) } },
    { settings: { describe: async () => envelope([{ ns: 'enhance', value: { enabled: 'yes' } }]) } },
    { settings: { describe: async () => ({ value: { namespaces: [] } }) } },
    { settings: { describe: async () => ({ ok: true, value: { namespaces: 'nope' } }) } },
  ]
  for (const remote of cases) {
    assert.deepEqual(await readSettings(remote as never), { kind: 'fallback', settings: defaults })
  }
})

test('settings: awaitSettings resolves through an injected namespace', async () => {
  const ctx = {
    inject: (deps: string[], callback: (scoped: unknown) => void) => {
      assert.deepEqual(deps, ['remote.settings'])
      callback({ remote: { settings: { describe: async () => envelope([{ ns: 'enhance', value: defaults }]) } } })
      return () => {}
    },
  }
  assert.deepEqual(await awaitSettings(ctx), { kind: 'served', settings: defaults })
})

test('settings: awaitSettings concludes "inactive" once the grace window expires', async () => {
  const ctx = {
    inject: (_deps: string[], callback: (scoped: unknown) => void) => {
      callback({ remote: { settings: { describe: async () => envelope([{ ns: 'other' }]) } } })
      return () => {}
    },
  }
  const started = Date.now()
  assert.deepEqual(await awaitSettings(ctx, { graceMs: 80, pollMs: 10 }), { kind: 'inactive' })
  assert.ok(Date.now() - started < SETTINGS_WAIT_MS, 'the grace window, not the wait budget, decides')
})

test('settings: awaitSettings tolerates the cold-boot activation race', async () => {
  let calls = 0
  const ctx = {
    inject: (_deps: string[], callback: (scoped: unknown) => void) => {
      callback({
        remote: {
          settings: {
            describe: async () => {
              calls += 1
              return calls < 3 ? envelope([{ ns: 'other' }]) : envelope([{ ns: 'enhance', value: defaults }])
            },
          },
        },
      })
      return () => {}
    },
  }
  assert.deepEqual(await awaitSettings(ctx, { graceMs: 500, pollMs: 10 }), { kind: 'served', settings: defaults })
  assert.ok(calls >= 3)
})

test('settings: awaitSettings falls back when the host never offers the namespace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = awaitSettings({ inject: () => () => {} })
  t.mock.timers.tick(SETTINGS_WAIT_MS)
  assert.deepEqual(await pending, { kind: 'fallback', settings: defaults })
})

test('settings: awaitSettings falls back when inject throws', async () => {
  const ctx = {
    inject: () => { throw new Error('no client cordis') },
  }
  assert.deepEqual(await awaitSettings(ctx as never), { kind: 'fallback', settings: defaults })
})
