export function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function max(values) {
  if (values.length === 0) return 0
  return Math.max(...values)
}
