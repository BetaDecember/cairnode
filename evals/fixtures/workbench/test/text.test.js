import test from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/text.js'

test('lowercases and joins words', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})

test('strips punctuation and surrounding space', () => {
  assert.equal(slugify('  Hello, World!  '), 'hello-world')
})
