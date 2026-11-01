/**
 * i18n contract (C4.9): both shipped locales carry the same key set, every value
 * is non-empty, and the generated Client bundle really contains both dictionaries.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (name: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(new URL(`../locale/${name}.json`, import.meta.url), 'utf8')) as Record<string, string>
const zh = read('zh')
const en = read('en')

test('i18n: zh and en expose exactly the same keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.ok(Object.keys(zh).length >= 5)
})

test('i18n: every value is a non-empty string and the error template carries {code}', () => {
  for (const [locale, dict] of [['zh', zh], ['en', en]] as Array<[string, Record<string, string>]>) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`)
      assert.ok(value.trim().length > 0, `${locale}.${key} must not be blank`)
    }
    assert.match(dict.error as string, /\{code\}/, `${locale}.error must interpolate the code`)
  }
})

test('i18n: the three phase tooltips are distinct in each locale', () => {
  for (const dict of [zh, en]) {
    const labels = [dict.title, dict.enhancing, dict.revert]
    assert.equal(new Set(labels).size, 3)
    assert.notEqual(dict.references, dict.title)
  }
})

test('i18n: the client bundle inlines both dictionaries (no runtime fetch)', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const value of [zh.title, en.title, zh.references, en.references]) {
    assert.ok(source.includes(value), `bundle is missing ${JSON.stringify(value)}`)
  }
})

test('i18n: locale/ ships in the packed file list', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('locale/'), 'package.json files must include locale/')
})
