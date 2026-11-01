/**
 * M3 §1/§2.1 — the pure parts of the reference write-back.
 *
 * The numbers in the "measured" cases are the ones experiment R recorded on a
 * live composer (`.m3/exp-drafts.out.txt`, `.m3/exp-insert.out.txt`):
 * a chip occupies one detect position, UTF-16 surrogate pairs count as two,
 * and a paragraph break is one character in both projections.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APPLY_DEADLINE_MS,
  applyDraft,
  composeDraft,
  detectIndex,
  parseDraft,
  runSpans,
  snapshotOf,
  splitOutput,
} from '../src/client/draft.ts'
import type { DraftDocument, ReferenceChip } from '../src/client/draft.ts'

const chip = (offset: number, clipboardText: string): ReferenceChip => ({
  source: 'reference',
  ref: clipboardText,
  offset,
  length: clipboardText.length,
  label: clipboardText.slice(1),
  clipboardText,
  appearance: 'file',
})

/** Parse or fail the test with the reported reason. */
function parsed(draft: string, occurrences: unknown): DraftDocument {
  const result = parseDraft(draft, occurrences)
  assert.equal(result.ok, true, result.ok ? '' : `parse failed: ${result.failure}`)
  return (result as { ok: true; document: DraftDocument }).document
}

test('draft: a draft without chips is one run and keeps the whole text', () => {
  const document = parsed('帮我写个登录页', [])
  assert.deepEqual(document.runs, ['帮我写个登录页'])
  assert.deepEqual(document.chips, [])
  assert.deepEqual(runSpans(document), [{ start: 0, end: 7 }])
})

test('draft: measured span for one chip at the front', () => {
  // Live: "@CMakeLists.txt  帮我写个登录页" → captureInsertion().start = 10
  const document = parsed('@CMakeLists.txt  帮我写个登录页', [{
    source: 'reference', ref: '@CMakeLists.txt', offset: 0, length: 15,
    label: 'CMakeLists.txt', clipboardText: '@CMakeLists.txt', appearance: 'file',
  }])
  assert.deepEqual(document.runs, ['', '  帮我写个登录页'])
  assert.deepEqual(runSpans(document), [{ start: 0, end: 0 }, { start: 1, end: 10 }])
})

test('draft: measured spans for two interleaved chips', () => {
  const draft = '@CMakeLists.txt  前半段 @ctx.ps1  后半段'
  const document = parsed(draft, [chip(0, '@CMakeLists.txt'), chip(21, '@ctx.ps1')])
  assert.deepEqual(document.runs, ['', '  前半段 ', '  后半段'])
  assert.deepEqual(runSpans(document), [{ start: 0, end: 0 }, { start: 1, end: 7 }, { start: 8, end: 13 }])
  assert.equal(detectIndex(draft.length, document.chips), 13)
})

test('draft: a chip at the end leaves the trailing run last', () => {
  const document = parsed('请总结这个文件 @CMakeLists.txt ', [chip(8, '@CMakeLists.txt')])
  assert.deepEqual(document.runs, ['请总结这个文件 ', ' '])
  assert.deepEqual(runSpans(document), [{ start: 0, end: 8 }, { start: 9, end: 10 }])
})

test('draft: emoji count as two UTF-16 units in both projections', () => {
  const draft = '@CMakeLists.txt  😀 write a login page 请用中文'
  const document = parsed(draft, [chip(0, '@CMakeLists.txt')])
  assert.equal(document.runs[1]?.length, 28)
  assert.deepEqual(runSpans(document)[1], { start: 1, end: 29 })
})

test('draft: a paragraph break inside a run maps to a single detect character', () => {
  const document = parsed('@CMakeLists.txt  第一段\n第二段', [chip(0, '@CMakeLists.txt')])
  assert.deepEqual(document.runs, ['', '  第一段\n第二段'])
  assert.deepEqual(runSpans(document)[1], { start: 1, end: 10 })
})

test('draft: occurrences are sorted by offset before the runs are cut', () => {
  const draft = 'a@x b@y'
  const document = parsed(draft, [chip(5, '@y'), chip(1, '@x')])
  assert.deepEqual(document.chips.map(entry => entry.ref), ['@x', '@y'])
  assert.deepEqual(document.runs, ['a', ' b', ''])
})

test('draft: an unmappable chip table is rejected instead of guessed', () => {
  const reject = (occurrences: unknown, expected: string): void => {
    const result = parseDraft('@README.md  hi', occurrences)
    assert.equal(result.ok, false)
    assert.equal((result as { ok: false; failure: string }).failure, expected)
  }
  reject('nope', 'not-an-array')
  reject([{ offset: 0 }], 'bad-entries')
  reject([{ offset: -1, length: 3, clipboardText: '@ab' }], 'bad-entries')
  reject([{ offset: 0, length: 0, clipboardText: '' }], 'bad-entries')
  reject([{ offset: 6, length: 9, clipboardText: '@README.md' }], 'bad-entries')
  reject([{ offset: 0, length: 6, clipboardText: '@READM' }, { offset: 1, length: 6, clipboardText: 'README' }], 'overlap')
  reject([{ offset: 0, length: 9, clipboardText: '@OTHER.md' }], 'token-mismatch')
})

test('draft: composeDraft interleaves rewritten runs with the chip tokens', () => {
  const chips = [chip(0, '@a'), chip(2, '@b')]
  assert.equal(composeDraft(['', ' 前 ', ' 后'], chips), '@a 前 @b 后')
  assert.equal(composeDraft(['x', 'y'], [chip(0, '@a')]), 'x@ay')
})

test('draft: splitOutput requires every token once, in order', () => {
  const chips = [chip(0, '@a'), chip(5, '@b')]
  assert.deepEqual(splitOutput('@a 前 @b 后', chips), ['', ' 前 ', ' 后'])
  // A reworded, dropped, or reordered token rejects the answer.
  assert.equal(splitOutput('@A 前 @b 后', chips), null)
  assert.equal(splitOutput('前 @b 后', chips), null)
  assert.equal(splitOutput('@b 前 @a 后', chips), null)
  // A duplicated token is not reordered; it stays literal text inside a run.
  assert.deepEqual(splitOutput('@a 前 @a @b 后', chips), ['', ' 前 @a ', ' 后'])
})

test('draft: snapshotOf keeps the text, the runs, and the refs', () => {
  const document = parsed('@a 前 @b 后', [chip(0, '@a'), chip(5, '@b')])
  assert.deepEqual(snapshotOf(document), { text: '@a 前 @b 后', runs: ['', ' 前 ', ' 后'], refs: ['@a', '@b'] })
})

test('applyDraft: a write that lands immediately is accepted', async () => {
  let draft = ''
  const outcome = await applyDraft({
    write: () => { draft = 'next'; return true },
    expected: 'next',
    read: () => ({ draft, refs: [] }),
  })
  assert.deepEqual(outcome, { ok: true })
})

test('applyDraft: a write that lands one frame later is still accepted', async () => {
  let draft = 'before'
  let frames = 0
  const outcome = await applyDraft({
    write: () => { return true },
    expected: 'after',
    read: () => ({ draft, refs: [] }),
    wait: async () => { frames += 1; draft = 'after' },
  })
  assert.deepEqual(outcome, { ok: true })
  assert.equal(frames, 1)
})

test('applyDraft: a write the composer ignores is reported, not assumed', async () => {
  let now = 0
  const outcome = await applyDraft({
    write: () => true,
    expected: 'after',
    read: () => ({ draft: 'before', refs: [] }),
    wait: async () => { now += APPLY_DEADLINE_MS },
    now: () => now,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'mismatch')
  assert.equal(outcome.seen, 'before')
})

test('applyDraft: a refused or throwing writer is reported as writer-refused', async () => {
  const refused = await applyDraft({
    write: () => false,
    expected: 'after',
    read: () => ({ draft: 'before', refs: [] }),
  })
  assert.equal(refused.reason, 'writer-refused')

  const threw = await applyDraft({
    write: () => { throw new Error('blocked') },
    expected: 'after',
    read: () => ({ draft: 'before', refs: [] }),
  })
  assert.equal(threw.reason, 'writer-refused')
})

test('applyDraft: a chip set that changed is a mismatch even when the text matches', async () => {
  let now = 0
  const outcome = await applyDraft({
    write: () => true,
    expected: 'same text',
    expectedRefs: ['@a'],
    read: () => ({ draft: 'same text', refs: [] }),
    wait: async () => { now += APPLY_DEADLINE_MS },
    now: () => now,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'mismatch')
})

test('applyDraft: a chip set that matches is accepted', async () => {
  const outcome = await applyDraft({
    write: () => true,
    expected: 'same text',
    expectedRefs: ['@a', '@b'],
    read: () => ({ draft: 'same text', refs: ['@a', '@b'] }),
  })
  assert.deepEqual(outcome, { ok: true })
})
