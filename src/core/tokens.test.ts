import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  contextFraction,
  estimateMessagesTokens,
  estimateTokens,
  reconcile,
} from './tokens.ts'

describe('estimateTokens', () => {
  it('returns zero for empty input', () => {
    assert.equal(estimateTokens(''), 0)
  })

  it('estimates prose more coarsely than code', () => {
    const text = 'x'.repeat(100)
    assert.equal(estimateTokens(text, 'prose'), 25)
    assert.equal(estimateTokens(text, 'code'), 29)
  })

  it('never returns zero for non-empty input', () => {
    assert.ok(estimateTokens('a') >= 1)
  })
})

describe('estimateMessagesTokens', () => {
  it('includes per-message overhead', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(40) }]
    assert.equal(estimateMessagesTokens(messages, { messageOverhead: 4 }), 15)
  })

  it('accumulates across messages', () => {
    const messages = [
      { role: 'system', content: 'x'.repeat(40) },
      { role: 'user', content: 'x'.repeat(40) },
    ]
    assert.equal(estimateMessagesTokens(messages, { messageOverhead: 4 }), 30)
  })
})

describe('reconcile', () => {
  it('falls back to the estimate when nothing is measured', () => {
    assert.equal(reconcile(500, null, 0), 500)
  })

  it('scales the estimate by the observed correction factor', () => {
    // We estimated 400 for a prompt that actually cost 800: factor 2.
    assert.equal(reconcile(500, 800, 400), 1000)
  })

  it('ignores a zero denominator', () => {
    assert.equal(reconcile(500, 800, 0), 500)
  })
})

describe('contextFraction', () => {
  it('clamps to 0..1', () => {
    assert.equal(contextFraction(50, 100), 0.5)
    assert.equal(contextFraction(200, 100), 1)
    assert.equal(contextFraction(-1, 100), 0)
    assert.equal(contextFraction(1, 0), 0)
  })
})
