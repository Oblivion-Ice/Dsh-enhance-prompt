import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigError, DEFAULT_CONFIG, isVolatileRef, readField, resolveConfig } from '../src/host/config.ts'

test('config: defaults match the documented values', () => {
  assert.deepEqual(resolveConfig(undefined), {
    enabled: true,
    minTextLength: 1,
    referencesMode: 'replace-text',
    maxInputChars: 4000,
    maxOutputChars: 800,
    timeoutMs: 20000,
    logRequests: true,
  })
  assert.equal(DEFAULT_CONFIG.minTextLength, 1)
  assert.equal(DEFAULT_CONFIG.referencesMode, 'replace-text')
})

test('config: referencesMode accepts exactly the two documented modes', () => {
  assert.equal(resolveConfig({ referencesMode: 'replace-text' }).referencesMode, 'replace-text')
  assert.equal(resolveConfig({ referencesMode: 'disabled' }).referencesMode, 'disabled')
  assert.throws(() => resolveConfig({ referencesMode: 'sometimes' }), (error: unknown) => {
    assert.ok(error instanceof ConfigError)
    assert.equal(error.field, 'referencesMode')
    return true
  })
  assert.throws(() => resolveConfig({ referencesMode: true }), ConfigError)
})

test('config: a .volatile() cell is followed to its live value', () => {
  // Shape minted by cosmokit: a frozen cell carrying the registered marker.
  const cell = (value: unknown): Record<symbol, unknown> => {
    const holder = { get: () => value }
    Object.defineProperty(holder, Symbol.for('cosmokit.volatile.write'), { value: () => {} })
    return holder as unknown as Record<symbol, unknown>
  }
  assert.equal(isVolatileRef(cell(3)), true)
  assert.equal(isVolatileRef(3), false)
  assert.equal(isVolatileRef({ get: () => 3 }), false)
  assert.equal(readField(cell(7)), 7)
  assert.equal(readField('plain'), 'plain')

  // The loader hands `apply()` parsed config, so volatile fields arrive as cells.
  const config = resolveConfig({
    enabled: cell(true),
    minTextLength: cell(4),
    referencesMode: cell('disabled'),
    timeoutMs: cell(9000),
  })
  assert.equal(config.enabled, true)
  assert.equal(config.minTextLength, 4)
  assert.equal(config.referencesMode, 'disabled')
  assert.equal(config.timeoutMs, 9000)
})

test('config: every documented bound is accepted at its edge', () => {
  const config = resolveConfig({
    enabled: false,
    minTextLength: 0,
    maxInputChars: 1,
    maxOutputChars: 1,
    timeoutMs: 1,
    logRequests: false,
    shortcut: 'Mod+Shift+E',
  })
  assert.equal(config.enabled, false)
  assert.equal(config.minTextLength, 0)
  assert.equal(config.maxInputChars, 1)
  assert.equal(config.maxOutputChars, 1)
  assert.equal(config.timeoutMs, 1)
  assert.equal(config.logRequests, false)
  assert.equal(config.shortcut, 'Mod+Shift+E')
})

test('config: provider and model must be supplied together', () => {
  assert.throws(() => resolveConfig({ provider: 'p' }), (error: unknown) => {
    assert.ok(error instanceof ConfigError)
    assert.equal(error.field, 'model')
    return true
  })
  assert.throws(() => resolveConfig({ model: 'm' }), (error: unknown) => {
    assert.ok(error instanceof ConfigError)
    assert.equal(error.field, 'provider')
    return true
  })
  assert.throws(() => resolveConfig({ provider: 'p', model: '   ' }), ConfigError)
  assert.equal(resolveConfig({ provider: 'p', model: 'm' }).provider, 'p')
})

test('config: out-of-range and wrong-typed values name their field', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ minTextLength: -1 }, 'minTextLength'],
    [{ maxInputChars: 0 }, 'maxInputChars'],
    [{ maxInputChars: 1.5 }, 'maxInputChars'],
    [{ maxOutputChars: 0 }, 'maxOutputChars'],
    [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ timeoutMs: Number.POSITIVE_INFINITY }, 'timeoutMs'],
    [{ enabled: 'yes' }, 'enabled'],
    [{ logRequests: 1 }, 'logRequests'],
    [{ provider: 42, model: 'm' }, 'provider'],
  ]
  for (const [raw, field] of cases) {
    assert.throws(() => resolveConfig(raw), (error: unknown) => {
      assert.ok(error instanceof ConfigError, `${field} should be a ConfigError`)
      assert.equal(error.field, field)
      return true
    })
  }
})
