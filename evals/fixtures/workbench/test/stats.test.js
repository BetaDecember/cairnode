import test from 'node:test'
import assert from 'node:assert/strict'
import { mean, max } from '../src/stats.js'

test('means values', () => {
  assert.equal(mean([2, 4, 6]), 4)
})

test('means an empty list as zero', () => {
  assert.equal(mean([]), 0)
})

test('finds the maximum', () => {
  assert.equal(max([3, 9, 4]), 9)
})
