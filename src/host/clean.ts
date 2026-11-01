/**
 * Output normalization for model replies.
 *
 * The enhancer asks for bare text, but models still wrap answers in quotes or
 * fences. Cleaning is deliberately conservative: remove one wrapping layer,
 * never rewrite the interior, and never truncate to a target length.
 */

const WRAPPING_QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
]

/**
 * Normalize one raw model output.
 * @param raw - exact text assembled from the stream.
 * @returns trimmed text without one quote or fence wrapper; empty when nothing remains.
 */
export function cleanOutput(raw: string): string {
  let text = raw.trim()
  text = stripWrappingQuotes(text)
  text = stripFence(text)
  return text.trim()
}

/** @param text - trimmed text. @returns text without one matching quote pair. */
function stripWrappingQuotes(text: string): string {
  for (const [open, close] of WRAPPING_QUOTES) {
    if (text.length < 2 || !text.startsWith(open) || !text.endsWith(close)) continue
    const inner = text.slice(open.length, text.length - close.length)
    // A matching quote before the final character means these are two quoted
    // fragments ("a" and "b"), not one wrapper around the whole text.
    if (inner.includes(close)) continue
    return inner
  }
  return text
}

/**
 * Remove one markdown fence that wraps the whole text.
 * Handles both a fenced block with an optional language line and a one-line
 * triple-backtick wrapper.
 * @param text - text after quote stripping.
 * @returns the fence body, or the input when no whole-text fence exists.
 */
function stripFence(text: string): string {
  if (!text.startsWith('```') || !text.endsWith('```') || text.length < 6) return text
  const inner = text.slice(3, text.length - 3)
  const newline = inner.indexOf('\n')
  // The first line after ``` may be a language tag; drop it only when a body line follows.
  return newline < 0 ? inner : inner.slice(newline + 1)
}
