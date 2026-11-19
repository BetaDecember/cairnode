export function slugify(value) {
  return value.toLowerCase().trim().replace(/ /g, '-')
}

// TODO: strip punctuation once the tests describe the intended output.
