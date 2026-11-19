import test from 'node:test'
import assert from 'node:assert/strict'
import { add, multiply } from '../src/math.js'

test('adds numbers', () => {
  assert.equal(add(2, 3), 5)
})

test('multiplies numbers', () => {
  assert.equal(multiply(4, 2.5), 10)
})
