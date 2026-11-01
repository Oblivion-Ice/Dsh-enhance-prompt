import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_ENHANCE_SETTINGS,
  ENHANCE_ERROR_CODES,
  isEnhanceErrorCode,
  isEnhanceInput,
  isEnhanceResult,
  isEnhanceSettings,
} from '../src/shared/protocol.ts'

test('protocol: every documented error code is accepted, unknown strings are not', () => {
  for (const code of ENHANCE_ERROR_CODES) assert.equal(isEnhanceErrorCode(code), true)
  assert.equal(isEnhanceErrorCode('boom'), false)
  assert.equal(isEnhanceErrorCode(42), false)
})

test('protocol: input guard rejects missing/wrong fields', () => {
  assert.equal(isEnhanceInput({ text: 'hi' }), true)
  assert.equal(isEnhanceInput({ text: 'hi', sessionId: 's', model: 'm', locale: 'zh' }), true)
  assert.equal(isEnhanceInput({}), false)
  assert.equal(isEnhanceInput({ text: 1 }), false)
  assert.equal(isEnhanceInput({ text: 'hi', locale: 'ja' }), false)
  assert.equal(isEnhanceInput(null), false)
})

test('protocol: result guard enforces the discriminated shape', () => {
  assert.equal(isEnhanceResult({
    ok: true,
    text: 'x',
    route: { provider: 'p', model: 'm' },
    elapsedMs: 1,
  }), true)
  assert.equal(isEnhanceResult({ ok: false, code: 'no_route', message: 'no route' }), true)
  assert.equal(isEnhanceResult({ ok: false, code: 'other', message: 'x' }), false)
  assert.equal(isEnhanceResult({ ok: true, text: 'x', route: { provider: '', model: 'm' }, elapsedMs: 1 }), false)
  assert.equal(isEnhanceResult({ ok: true, text: 'x', route: { provider: 'p', model: 'm' } }), false)
  assert.equal(isEnhanceResult(null), false)
})

test('protocol: settings guard accepts only the three rendering fields', () => {
  assert.equal(isEnhanceSettings({ enabled: true, minTextLength: 1, referencesMode: 'replace-text' }), true)
  assert.equal(isEnhanceSettings({ enabled: false, minTextLength: 0, referencesMode: 'disabled' }), true)
  assert.equal(isEnhanceSettings({ enabled: true, minTextLength: 1 }), false)
  assert.equal(isEnhanceSettings({ enabled: true, minTextLength: 1, referencesMode: 'sometimes' }), false)
  assert.equal(isEnhanceSettings({ enabled: 'yes', minTextLength: 1, referencesMode: 'replace-text' }), false)
  assert.equal(isEnhanceSettings({ enabled: true, minTextLength: 1.5, referencesMode: 'replace-text' }), false)
  assert.equal(isEnhanceSettings({ enabled: true, minTextLength: -1, referencesMode: 'replace-text' }), false)
  assert.equal(isEnhanceSettings({ enabled: true, minTextLength: 1, referencesMode: 'replace-text', extra: true }), true)
  assert.equal(isEnhanceSettings(null), false)
  assert.deepEqual(DEFAULT_ENHANCE_SETTINGS, { enabled: true, minTextLength: 1, referencesMode: 'replace-text' })
})

test('protocol: the M3 client-side codes exist in the shared vocabulary', () => {
  assert.ok(ENHANCE_ERROR_CODES.includes('apply_failed'))
  assert.ok(ENHANCE_ERROR_CODES.includes('references_unsupported'))
})
