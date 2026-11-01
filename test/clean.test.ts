import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanOutput } from '../src/host/clean.ts'
import { renderUserPrompt } from '../src/host/prompts.ts'

test('clean: strips one wrapping quote pair', () => {
  assert.equal(cleanOutput('  "hello"\n'), 'hello')
  assert.equal(cleanOutput("'hello'"), 'hello')
  assert.equal(cleanOutput('“hello”'), 'hello')
  assert.equal(cleanOutput('「hello」'), 'hello')
  assert.equal(cleanOutput('"unbalanced'), '"unbalanced')
  assert.equal(cleanOutput('"a" and "b"'), '"a" and "b"')
})

test('clean: strips one whole-text markdown fence', () => {
  assert.equal(cleanOutput('```\nhello\n```'), 'hello')
  assert.equal(cleanOutput('```markdown\nhello\n```'), 'hello')
  assert.equal(cleanOutput('```text\nline one\nline two\n```\n'), 'line one\nline two')
  assert.equal(cleanOutput('```hello```'), 'hello')
  assert.equal(cleanOutput('prefix\n```\nhello\n```'), 'prefix\n```\nhello\n```')
})

test('clean: trims blank lines and whitespace, and keeps interior text', () => {
  assert.equal(cleanOutput('  \n\nhello\n\n '), 'hello')
  assert.equal(cleanOutput('\n\t\r\n'), '')
  assert.equal(cleanOutput('line one\n\nline two'), 'line one\n\nline two')
})

test('prompt: user input is interpolated literally, including $& and $1', () => {
  const input = 'literal $& and $1 and $` text'
  const prompt = renderUserPrompt(input)
  assert.ok(prompt.includes(input))
  assert.ok(prompt.startsWith('USER INPUT:\n'))
  assert.equal(prompt.split(input).length, 2)
})
