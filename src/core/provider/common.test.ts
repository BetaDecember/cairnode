import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseRetryAfter } from './common.ts'

describe('parseRetryAfter', () => {
  it('reads delta seconds', () => {
    assert.equal(parseRetryAfter('45'), 45_000)
    assert.equal(parseRetryAfter(' 0 '), 0)
    assert.equal(parseRetryAfter('1.5'), 1_500)
  })

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('Fri, 20 Nov 2026 12:00:00 GMT')
    assert.equal(parseRetryAfter('Fri, 20 Nov 2026 12:00:30 GMT', now), 30_000)
    assert.equal(parseRetryAfter('Fri, 20 Nov 2026 11:59:00 GMT', now), 0)
  })

  it('ignores missing or invalid values', () => {
    assert.equal(parseRetryAfter(null), undefined)
    assert.equal(parseRetryAfter(''), undefined)
    assert.equal(parseRetryAfter('later'), undefined)
    assert.equal(parseRetryAfter('-5'), undefined)
  })
})
