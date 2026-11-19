import * as stats from './stats.js'

const samples = [12, 18, 9, 30, 21]

console.log(`mean: ${stats.mean(samples)}`)
console.log(`max: ${stats.max(samples)}`)

// The summary line is what the dashboard reads.
console.log(`average: ${stats.average(samples)}`)
