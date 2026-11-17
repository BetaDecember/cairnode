import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segments } from './markdown.ts'

test('plain prose is one text segment', () => {
  assert.deepEqual(segments('It printed: hello'), [{ type: 'text', text: 'It printed: hello' }])
})

test('inline code is not a fence', () => {
  const source = 'Run `node --test` and check `math.js`.'
  assert.deepEqual(segments(source), [{ type: 'text', text: source }])
})

test('a fenced block is split out of the prose', () => {
  assert.deepEqual(segments('Before.\n```js\nconst a = 1\n```\nAfter.'), [
    { type: 'text', text: 'Before.\n' },
    { type: 'code', text: 'const a = 1', language: 'js' },
    { type: 'text', text: '\nAfter.' },
  ])
})

test('a fence without a language still starts a block', () => {
  assert.deepEqual(segments('```\nhello\n```'), [{ type: 'code', text: 'hello' }])
})

test('an unclosed fence runs to the end while streaming', () => {
  assert.deepEqual(segments('Here:\n```ts\nconst value = 1'), [
    { type: 'text', text: 'Here:\n' },
    { type: 'code', text: 'const value = 1', language: 'ts' },
  ])
})

test('multiple blocks keep their order', () => {
  const parts = segments('```a\n1\n```\nmiddle\n```b\n2\n```')
  assert.deepEqual(
    parts.map((part) => part.type),
    ['code', 'text', 'code'],
  )
})

test('an empty reply yields an empty text segment', () => {
  assert.deepEqual(segments(''), [{ type: 'text', text: '' }])
})
