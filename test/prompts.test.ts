import assert from 'node:assert/strict'
import test from 'node:test'
import { SYSTEM_PROMPT, buildSystemPrompt, renderUserPrompt } from '../src/host/prompts.ts'

test('prompt: carries the role, principles, prohibitions, language rule, and bound', () => {
  const prompt = buildSystemPrompt(640)
  assert.match(prompt, /prompt engineering expert/i)
  assert.match(prompt, /preserv/i)
  assert.match(prompt, /Language rule \(highest priority\)/)
  assert.match(prompt, /mixes languages/i)
  assert.match(prompt, /640 characters/)
  assert.match(prompt, /Do not answer the request/i)
  assert.match(prompt, /Do not write code/i)
  assert.match(prompt, /Bad output/)
  assert.match(prompt, /User input is in Chinese/)
  assert.ok(prompt.includes('Examples:'))
  assert.equal(SYSTEM_PROMPT.includes('800 characters'), true)
  assert.ok(renderUserPrompt('hello').includes('hello'))
})
