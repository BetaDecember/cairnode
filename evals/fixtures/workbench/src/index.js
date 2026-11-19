import { add, multiply } from './math.js'
import { slugify } from './text.js'

export function describe(title, price, quantity) {
  return { slug: slugify(title), total: add(multiply(price, quantity), 0) }
}

console.log(describe('Two Notebooks', 4.5, 2))
