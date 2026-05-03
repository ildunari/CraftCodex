/**
 * find-quote-with-context -- Disambiguate repeated text using prefix/suffix context.
 *
 * Both PDF and HTML surfaces need to find the correct occurrence of a quoted
 * text string in a document that may contain the same text multiple times.
 * This module provides a shared helper that uses the prefix and suffix from
 * the text-quote selector for disambiguation, falling back to the first
 * occurrence when no context is available.
 */

/**
 * Find the character offset of a quote in fullText, using prefix/suffix
 * for disambiguation when the quote appears multiple times.
 *
 * @returns The character offset of the best match, or -1 if not found.
 */
export function findQuoteOffset(
  fullText: string,
  quote: string,
  prefix?: string,
  suffix?: string,
): number {
  if (!quote || !fullText) return -1

  // Collect all occurrence offsets
  const occurrences: number[] = []
  let searchFrom = 0
  while (true) {
    const idx = fullText.indexOf(quote, searchFrom)
    if (idx === -1) break
    occurrences.push(idx)
    searchFrom = idx + 1
  }

  if (occurrences.length === 0) return -1
  if (occurrences.length === 1) return occurrences[0]!

  // Multiple occurrences -- disambiguate with prefix/suffix
  const hasPrefix = prefix != null && prefix.length > 0
  const hasSuffix = suffix != null && suffix.length > 0

  if (!hasPrefix && !hasSuffix) {
    // No context available, return first match
    return occurrences[0]!
  }

  let bestIdx = occurrences[0]!
  let bestScore = -1

  for (const idx of occurrences) {
    let score = 0

    if (hasPrefix) {
      // Check how many trailing characters of prefix match the text before idx
      const textBefore = fullText.slice(Math.max(0, idx - prefix!.length), idx)
      score += commonSuffixLength(prefix!, textBefore)
    }

    if (hasSuffix) {
      // Check how many leading characters of suffix match the text after quote
      const afterIdx = idx + quote.length
      const textAfter = fullText.slice(afterIdx, afterIdx + suffix!.length)
      score += commonPrefixLength(suffix!, textAfter)
    }

    if (score > bestScore) {
      bestScore = score
      bestIdx = idx
    }
  }

  return bestIdx
}

/** Count how many characters match from the start of both strings. */
function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length)
  let i = 0
  while (i < len && a[i] === b[i]) i++
  return i
}

/** Count how many characters match from the end of both strings. */
function commonSuffixLength(a: string, b: string): number {
  const lenA = a.length
  const lenB = b.length
  const len = Math.min(lenA, lenB)
  let i = 0
  while (i < len && a[lenA - 1 - i] === b[lenB - 1 - i]) i++
  return i
}
